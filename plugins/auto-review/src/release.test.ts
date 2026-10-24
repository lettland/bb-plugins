import { describe, expect, it, vi } from "vitest";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { ReviewContext } from "./context.js";
import { resolveAndEvaluate, sweepOrphanFindings } from "./release.js";

const lookups = vi.hoisted(() => ({
  providerReviewInFlight: vi.fn(),
  deferralProviderId: vi.fn(),
}));
vi.mock("./deferral.js", async (original) => ({
  ...(await original<typeof import("./deferral.js")>()),
  providerReviewInFlight: lookups.providerReviewInFlight,
  deferralProviderId: lookups.deferralProviderId,
}));

function context(getThread: () => Promise<unknown>, kvList: string[] = []) {
  const warnings: string[] = [];
  const metadata: Record<string, unknown> = { phase: "deferred" };
  const bb = {
    sdk: {
      threads: {
        get: getThread,
        getPluginMetadata: async () => ({ ...metadata }),
        updatePluginMetadata: async ({ set, remove }: { set?: Record<string, unknown>; remove?: string[] }) => {
          Object.assign(metadata, set ?? {});
          for (const key of remove ?? []) {
            delete metadata[key];
          }
          return { ...metadata };
        },
      },
    },
    storage: {
      kv: {
        get: async () => undefined,
        set: async () => undefined,
        delete: async () => undefined,
        list: async () => kvList,
      },
    },
    log: {
      warn: (message: string) => warnings.push(message),
      info: () => undefined,
    },
  } as unknown as BbPluginApi;
  const ctx = { bb, settings: {}, globals: { enabled: true, mergeEligibleMainlines: ["master"], reviewMode: "auto" } } as unknown as ReviewContext;
  return { ctx, warnings, metadata };
}

describe("resolveAndEvaluate", () => {
  it("reports an unreadable thread to the caller as unusable, whatever the error", async () => {
    const { ctx } = context(async () => {
      throw "kaboom";
    });
    const onUnusable = vi.fn(async () => undefined);
    expect(await resolveAndEvaluate(ctx, "thr", onUnusable)).toBe(false);
    expect(onUnusable).toHaveBeenCalledWith("kaboom");
  });

  it("does not evaluate a thread that fails the gate", async () => {
    const { ctx } = context(async () => ({ status: "failed", projectId: "p" }));
    const onUnusable = vi.fn(async () => undefined);
    expect(await resolveAndEvaluate(ctx, "thr", onUnusable)).toBe(false);
    expect(onUnusable).toHaveBeenCalledWith("thread no longer passes the auto-review thread gate");
  });
});

describe("sweepOrphanFindings", () => {
  it("keeps the findings of a thread whose existence cannot be read, whatever the error", async () => {
    const { ctx, warnings } = context(
      async () => {
        throw "kaboom";
      },
      ["findings:thr-1"],
    );
    await sweepOrphanFindings(ctx);
    expect(warnings[0]).toContain("could not check whether thr-1 still exists");
    expect(warnings[0]).toContain("kaboom");
  });
});
