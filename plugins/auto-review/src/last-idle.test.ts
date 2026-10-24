import { describe, expect, it, vi } from "vitest";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { GateThreadLike } from "./context.js";
import type { ThreadState } from "./state.js";
import { lastIdleFloor, refreshIdleSnapshot, refreshLastIdle } from "./last-idle.js";

const lookups = vi.hoisted(() => ({
  captureTree: vi.fn(),
  tryCaptureSinceSeq: vi.fn(),
  userTurnRunningSince: vi.fn(),
}));
vi.mock("./detect.js", async (original) => ({
  ...(await original<typeof import("./detect.js")>()),
  ...lookups,
}));

function fakeBb(seed: Record<string, unknown> = {}) {
  const warnings: string[] = [];
  let metadata: Record<string, unknown> = { ...seed };
  let status = "idle";
  const bb = {
    sdk: {
      threads: {
        get: async () => ({ status }),
        getPluginMetadata: async () => metadata,
        updatePluginMetadata: async ({ set, remove }: { set: Record<string, unknown>; remove?: string[] }) => {
          metadata = { ...metadata, ...set };
          for (const key of remove ?? []) {
            delete metadata[key];
          }
          return {};
        },
      },
    },
    log: {
      warn: (message: string) => warnings.push(message),
      info: () => undefined,
    },
  } as unknown as BbPluginApi;
  return {
    bb,
    warnings,
    metadata: () => metadata,
    setStatus: (next: string) => {
      status = next;
    },
  };
}

const tree = { headSha: "h0", files: {}, commits: [] };
const thread = (environmentId: string | null) =>
  ({ id: "thr", projectId: "p", environmentId, providerId: "claude-code" }) as unknown as GateThreadLike;

describe("lastIdleFloor", () => {
  it("is 0 without a turn start, else the later of the two cursors", () => {
    expect(lastIdleFloor({ phase: "idle" } as ThreadState)).toBe(0);
    expect(
      lastIdleFloor({
        phase: "idle",
        turnStart: { sinceSeq: 5 },
        lastIdle: { sinceSeq: 3 },
      } as ThreadState),
    ).toBe(5);
    expect(
      lastIdleFloor({
        phase: "idle",
        turnStart: { sinceSeq: 2 },
        lastIdle: { sinceSeq: 9 },
      } as ThreadState),
    ).toBe(9);
  });
});

describe("refreshLastIdle", () => {
  it("records the cursor and tree at an idle", async () => {
    const f = fakeBb();
    lookups.tryCaptureSinceSeq.mockResolvedValueOnce(7);
    lookups.captureTree.mockResolvedValueOnce(tree);
    await refreshLastIdle(f.bb, thread("env"));
    expect(f.metadata().lastIdle).toMatchObject({ sinceSeq: 7, tree });
  });

  it("a thread without an environment records nothing", async () => {
    const f = fakeBb({ lastIdle: { sinceSeq: 1, tree } });
    await refreshLastIdle(f.bb, thread(null));
    expect(f.metadata().lastIdle).toBeUndefined();
  });

  it("a snapshot that cannot be taken removes the record", async () => {
    const f = fakeBb({ lastIdle: { sinceSeq: 1, tree } });
    lookups.tryCaptureSinceSeq.mockResolvedValueOnce(undefined);
    lookups.captureTree.mockResolvedValueOnce(tree);
    await refreshLastIdle(f.bb, thread("env"));
    expect(f.metadata().lastIdle).toBeUndefined();
  });
});

describe("refreshIdleSnapshot", () => {
  it("an idle snapshot without a running turn takes the plain cursor", async () => {
    const f = fakeBb();
    lookups.tryCaptureSinceSeq.mockResolvedValueOnce(4);
    lookups.captureTree.mockResolvedValueOnce(tree);
    await refreshIdleSnapshot(f.bb, thread("env"), { phase: "idle" } as ThreadState);
    expect(f.metadata().lastIdle).toMatchObject({ sinceSeq: 4 });
  });

  it("a snapshot under a running user turn is anchored one before its request", async () => {
    const f = fakeBb();
    f.setStatus("active");
    lookups.userTurnRunningSince.mockResolvedValueOnce(10);
    lookups.captureTree.mockResolvedValueOnce(tree);
    await refreshIdleSnapshot(
      f.bb,
      thread("env"),
      { phase: "idle", turnStart: { sinceSeq: 6 } } as ThreadState,
    );
    expect(lookups.userTurnRunningSince).toHaveBeenCalledWith(expect.anything(), "thr", 6);
    expect(f.metadata().lastIdle).toMatchObject({ sinceSeq: 9, tree });
  });

  it("a running turn that cannot be shown to be the user's leaves no record", async () => {
    const f = fakeBb();
    f.setStatus("active");
    lookups.userTurnRunningSince.mockResolvedValueOnce(null);
    await refreshIdleSnapshot(f.bb, thread("env"), { phase: "idle" } as ThreadState);
    expect(f.metadata().lastIdle).toBeUndefined();
    expect(f.warnings).toEqual([]);
  });

  it("a failed anchor read warns and removes the record", async () => {
    const f = fakeBb({ lastIdle: { sinceSeq: 1, tree } });
    f.setStatus("active");
    lookups.userTurnRunningSince.mockRejectedValueOnce("kaboom");
    await refreshIdleSnapshot(f.bb, thread("env"), { phase: "idle" } as ThreadState);
    expect(f.metadata().lastIdle).toBeUndefined();
    expect(f.warnings[0]).toContain("kaboom");
  });

  it("a failed status read warns and removes the record", async () => {
    const f = fakeBb({ lastIdle: { sinceSeq: 1, tree } });
    f.bb.sdk.threads.get = async () => {
      throw new Error("status down");
    };
    await refreshIdleSnapshot(f.bb, thread("env"), { phase: "idle" } as ThreadState);
    expect(f.metadata().lastIdle).toBeUndefined();
    expect(f.warnings[0]).toContain("status down");
  });

  it("a workspace the caller fetched is reused", async () => {
    const f = fakeBb();
    lookups.tryCaptureSinceSeq.mockResolvedValueOnce(4);
    lookups.captureTree.mockResolvedValueOnce(tree);
    const workspace = { environmentId: "env", tree, at: 1 };
    await refreshIdleSnapshot(f.bb, thread("env"), { phase: "idle" } as ThreadState, workspace as never);
    expect(f.metadata().lastIdle).toMatchObject({ sinceSeq: 4 });
  });
});
