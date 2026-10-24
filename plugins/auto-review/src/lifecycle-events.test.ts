import { describe, expect, it, vi } from "vitest";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { ReviewContext } from "./context.js";
import { registerLifecycleEvents, unlatch } from "./lifecycle-events.js";

const release = vi.hoisted(() => ({
  releaseDeferred: vi.fn(async () => undefined),
  sweepDeferrals: vi.fn(async () => undefined),
  sweepOrphanFindings: vi.fn(async () => undefined),
}));
vi.mock("./release.js", async (original) => ({
  ...(await original<typeof import("./release.js")>()),
  ...release,
}));

function fakeBb(metadata: Record<string, Record<string, unknown>> = {}) {
  const warnings: string[] = [];
  const deletedKeys: string[] = [];
  const store = new Map<string, unknown>();
  const scheduled = new Map<string, () => Promise<void>>();
  const handlers = new Map<string, (payload: unknown) => Promise<void>>();
  const bb = {
    sdk: {
      threads: {
        getPluginMetadata: async ({ threadId }: { threadId: string }) => metadata[threadId] ?? {},
        updatePluginMetadata: async ({ threadId, set, remove }: { threadId: string; set: Record<string, unknown>; remove?: string[] }) => {
          const current = { ...(metadata[threadId] ?? {}) };
          Object.assign(current, set);
          for (const key of remove ?? []) {
            delete current[key];
          }
          metadata[threadId] = current;
          return {};
        },
      },
    },
    storage: {
      kv: {
        get: async (key: string) => store.get(key),
        set: async (key: string, value: unknown) => {
          store.set(key, value);
        },
        delete: async (key: string) => {
          store.delete(key);
          deletedKeys.push(key);
        },
        list: async (prefix?: string) =>
          [...store.keys()].filter((key) => (prefix === undefined ? true : key.startsWith(prefix))),
      },
    },
    log: {
      warn: (message: string) => {
        warnings.push(message);
      },
      info: () => undefined,
    },
    realtime: { publish: () => undefined },
    background: {
      schedule: (name: string, _cron: string, run: () => Promise<void>) => {
        scheduled.set(name, run);
      },
    },
    events: {
      on: (name: string, handler: (payload: unknown) => Promise<void>) => {
        handlers.set(name, handler);
      },
    },
  } as unknown as BbPluginApi;
  return { bb, warnings, deletedKeys, store, scheduled, handlers };
}

const ctx = (bb: BbPluginApi) =>
  ({ bb, settings: {}, globals: { enabled: true, mergeEligibleMainlines: ["master"], reviewMode: "auto" } }) as unknown as ReviewContext;

describe("unlatch", () => {
  it("clears the latch, the deferral and the review record", async () => {
    const { bb, deletedKeys } = fakeBb();
    await unlatch(ctx(bb), "thread-1");
    expect(deletedKeys).toEqual(
      expect.arrayContaining(["deferral:thread-1", "review:thread-1"]),
    );
  });

  it("resets a latched phase and keeps the findings of a thread that still exists", async () => {
    const metadata: Record<string, Record<string, unknown>> = {
      "thread-1": { phase: "awaiting-review", dispatchedAt: 5 },
    };
    const { bb, deletedKeys } = fakeBb(metadata);
    await unlatch(ctx(bb), "thread-1");
    expect(metadata["thread-1"]).toMatchObject({ phase: "idle" });
    expect(metadata["thread-1"].dispatchedAt).toBeUndefined();
    expect(deletedKeys.some((key) => key.includes("finding"))).toBe(false);
  });

  it("a deleted thread loses its findings and baselines too", async () => {
    const { bb, deletedKeys } = fakeBb();
    await unlatch(ctx(bb), "thread-1", true);
    expect(deletedKeys).toEqual(
      expect.arrayContaining([expect.stringContaining("finding"), expect.stringContaining("baseline")]),
    );
  });
});

describe("registerLifecycleEvents", () => {
  it("runs both sweeps and reports one that fails without skipping the other", async () => {
    const { bb, warnings, scheduled } = fakeBb();
    release.sweepDeferrals.mockClear();
    release.sweepOrphanFindings.mockClear();
    release.releaseDeferred.mockClear();
    release.sweepDeferrals.mockRejectedValueOnce("kaboom");
    registerLifecycleEvents(ctx(bb));
    const sweep = scheduled.get("sweep-deferrals");
    expect(sweep).toBeDefined();
    await sweep?.();
    expect(warnings).toEqual(["auto-review: the deferrals sweep failed: kaboom"]);
    expect(release.sweepOrphanFindings).toHaveBeenCalledTimes(1);
  });

  it("unlatches a failed thread and releases the review parked behind it", async () => {
    const { bb, handlers } = fakeBb();
    registerLifecycleEvents(ctx(bb));
    await handlers.get("thread.failed")?.({ thread: { id: "thread-1", providerId: "claude-code" } });
    expect(release.releaseDeferred).toHaveBeenCalledWith(expect.anything(), "claude-code");
  });

  it("a deleted thread is unlatched as deleted and releases the parked review", async () => {
    const { bb, deletedKeys, handlers } = fakeBb();
    registerLifecycleEvents(ctx(bb));
    await handlers.get("thread.deleted")?.({ thread: { id: "thread-1", providerId: "codex" } });
    expect(deletedKeys).toEqual(
      expect.arrayContaining([expect.stringContaining("finding"), expect.stringContaining("baseline")]),
    );
    expect(release.releaseDeferred).toHaveBeenCalledWith(expect.anything(), "codex");
  });
});
