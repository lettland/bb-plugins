import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { ReviewContext } from "./context.js";
import { onMessageDispatched, onThreadActive, onThreadIdle } from "./turn-events.js";

const lookups = vi.hoisted(() => ({
  captureSinceSeq: vi.fn(),
  captureTree: vi.fn(),
  handleIdle: vi.fn(),
  releaseDeferred: vi.fn(),
  deliveredPatch: vi.fn(),
}));
vi.mock("./detect.js", async (original) => ({
  ...(await original<typeof import("./detect.js")>()),
  captureSinceSeq: lookups.captureSinceSeq,
  captureTree: lookups.captureTree,
}));
vi.mock("./evaluate.js", async (original) => ({
  ...(await original<typeof import("./evaluate.js")>()),
  handleIdle: lookups.handleIdle,
}));
vi.mock("./release.js", async (original) => ({
  ...(await original<typeof import("./release.js")>()),
  releaseDeferred: lookups.releaseDeferred,
}));
vi.mock("./review-outcome.js", async (original) => ({
  ...(await original<typeof import("./review-outcome.js")>()),
  deliveredPatch: lookups.deliveredPatch,
}));

function fakeBb(seed: Record<string, unknown> = {}) {
  const warnings: string[] = [];
  let metadata: Record<string, unknown> = { ...seed };
  let writeFails: unknown = undefined;
  const bb = {
    sdk: {
      threads: {
        getPluginMetadata: async () => metadata,
        updatePluginMetadata: async (args: { set?: Record<string, unknown>; remove?: string[] }) => {
          if (writeFails !== undefined) {
            throw writeFails;
          }
          metadata = { ...metadata, ...(args.set ?? {}) };
          for (const key of args.remove ?? []) {
            delete metadata[key];
          }
          return { ...metadata };
        },
      },
    },
    log: { warn: (message: string) => warnings.push(message), info: () => undefined },
  } as unknown as BbPluginApi;
  const ctx = { bb, settings: {}, globals: { enabled: true, mergeEligibleMainlines: ["master"], reviewMode: "auto" } } as unknown as ReviewContext;
  return {
    bb,
    ctx,
    warnings,
    metadata: () => metadata,
    failWrites(next: unknown) {
      writeFails = next;
    },
  };
}

const thread = (environmentId: string | null) => ({
  id: "thr",
  projectId: "p",
  parentThreadId: null,
  originPluginId: null,
  visibility: "visible",
  environmentId,
  providerId: "claude-code",
  archivedAt: null,
});

beforeEach(() => {
  vi.clearAllMocks();
  lookups.captureSinceSeq.mockResolvedValue(5);
  lookups.deliveredPatch.mockResolvedValue({ reviewDeliveredAt: 500, reviewDeliveredSeq: 9 });
});

describe("onThreadActive", () => {
  it("records the turn start with the tree as the turn found it, clearing the idle's record", async () => {
    const f = fakeBb({ turnDecided: true, turnStart: { sinceSeq: 1 }, lastIdle: { sinceSeq: 1 } });
    lookups.captureTree.mockResolvedValueOnce({ headSha: "h0", files: {}, commits: [] });
    await onThreadActive(f.ctx, { thread: thread("env") } as never);
    expect(lookups.captureTree).toHaveBeenCalledWith(f.bb, "env");
    expect(f.metadata().turnStart).toMatchObject({ sinceSeq: 5, tree: { headSha: "h0" } });
    expect(f.metadata().turnDecided).toBeUndefined();
    expect(f.metadata().lastIdle).toBeUndefined();
  });
});

describe("onThreadIdle", () => {
  it("reports a planDenied latch it cannot clear and goes on to the idle, whatever the error", async () => {
    const failing = fakeBb({ planDenied: { at: 1, sinceSeq: 2 } });
    failing.failWrites(new Error("metadata down"));
    await onThreadIdle(failing.ctx, { thread: thread("env") } as never);
    expect(failing.warnings[0]).toContain("could not clear planDenied in thr");
    expect(failing.warnings[0]).toContain("metadata down");
    expect(lookups.handleIdle).toHaveBeenCalledTimes(1);
    const notAnError = fakeBb({ planDenied: { at: 1, sinceSeq: 2 } });
    notAnError.failWrites("kaboom");
    await onThreadIdle(notAnError.ctx, { thread: thread("env") } as never);
    expect(notAnError.warnings[0]).toContain("kaboom");
    expect(lookups.handleIdle).toHaveBeenCalledTimes(2);
  });

  it("clears planDenied quietly and releases the provider's parked turns after the idle", async () => {
    const f = fakeBb({ planDenied: { at: 1, sinceSeq: 2 } });
    await onThreadIdle(f.ctx, { thread: thread("env") } as never);
    expect(f.metadata().planDenied).toBeUndefined();
    expect(f.warnings).toEqual([]);
    expect(lookups.handleIdle).toHaveBeenCalledTimes(1);
    expect(lookups.releaseDeferred).toHaveBeenCalledWith(f.ctx, "claude-code");
  });
});

describe("onMessageDispatched", () => {
  it("reports a plan review dispatched without a cursor and leaves it without one, whatever the error", async () => {
    const failing = fakeBb({ planReviewEntryId: "qm-1" });
    lookups.captureSinceSeq.mockRejectedValueOnce(new Error("timeline down"));
    await onMessageDispatched(failing.ctx, { entry: { id: "qm-1", threadId: "thr" } } as never);
    expect(failing.warnings[0]).toContain("could not capture a timeline cursor for the dispatched plan review in thr");
    expect(failing.warnings[0]).toContain("timeline down");
    expect(failing.metadata().planReviewDeliveredSeq).toBeUndefined();
    expect(failing.metadata().planReviewEntryId).toBeUndefined();
    const notAnError = fakeBb({ planReviewEntryId: "qm-1" });
    lookups.captureSinceSeq.mockRejectedValueOnce("kaboom");
    await onMessageDispatched(notAnError.ctx, { entry: { id: "qm-1", threadId: "thr" } } as never);
    expect(notAnError.warnings[0]).toContain("kaboom");
    expect(notAnError.metadata().planReviewEntryId).toBeUndefined();
  });

  it("leaves a queued review's state alone when another entry was dispatched", async () => {
    const f = fakeBb({ phase: "pending-dispatch", pendingEntryId: "qm-2" });
    await onMessageDispatched(f.ctx, { entry: { id: "qm-1", threadId: "thr" } } as never);
    expect(f.metadata()).toMatchObject({ phase: "pending-dispatch", pendingEntryId: "qm-2" });
    expect(lookups.deliveredPatch).not.toHaveBeenCalled();
  });
});
