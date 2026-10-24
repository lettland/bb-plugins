import { describe, expect, it, vi } from "vitest";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { GateThreadLike, ReviewContext } from "./context.js";
import { NoTurnCompletedError, UnreadTurnError } from "./detect.js";
import type { ThreadState, TurnStart } from "./state.js";
import { noteUserTurn, readEndedTurn, reviewContinuationPending } from "./review-continuation.js";

const lookups = vi.hoisted(() => ({
  endedTurn: vi.fn(),
  fetchWorkspace: vi.fn(),
  spawnedDescendantIds: vi.fn(),
  turnChangedPaths: vi.fn(),
}));
vi.mock("./detect.js", async (original) => ({
  ...(await original<typeof import("./detect.js")>()),
  ...lookups,
}));

function fakeBb(seed: Record<string, unknown> = {}) {
  const warnings: string[] = [];
  let metadata: Record<string, unknown> = { ...seed };
  const bb = {
    sdk: {
      threads: {
        queuedMessages: { list: async () => rows },
        getPluginMetadata: async () => metadata,
        updatePluginMetadata: async ({ set, remove }: { set?: Record<string, unknown>; remove?: string[] }) => {
          metadata = { ...metadata, ...(set ?? {}) };
          for (const key of remove ?? []) {
            delete metadata[key];
          }
          return { ...metadata };
        },
      },
    },
    log: {
      warn: (message: string) => warnings.push(message),
      info: () => undefined,
    },
  } as unknown as BbPluginApi;
  let rows: Array<Record<string, unknown>> = [];
  const ctx = { bb, settings: {}, globals: { enabled: true, mergeEligibleMainlines: ["master"], reviewMode: "auto" } } as unknown as ReviewContext;
  return {
    bb,
    ctx,
    warnings,
    metadata: () => metadata,
    setRows(next: Array<Record<string, unknown>>) {
      rows = next;
    },
  };
}

const thread = (environmentId: string | null) =>
  ({ id: "thr", projectId: "p", environmentId, providerId: "claude-code" }) as unknown as GateThreadLike;
const turnStart: TurnStart = { sinceSeq: 1 };

describe("reviewContinuationPending", () => {
  it("is false without a delivery time and past the cap", async () => {
    const f = fakeBb();
    expect(await reviewContinuationPending(f.ctx, { phase: "awaiting-review" } as ThreadState, "thr")).toBe(false);
    expect(
      await reviewContinuationPending(
        f.ctx,
        { phase: "awaiting-review", reviewDeliveredAt: Date.now() - 3 * 60 * 60 * 1_000 } as ThreadState,
        "thr",
      ),
    ).toBe(false);
  });

  it("a running descendant keeps the review", async () => {
    const f = fakeBb();
    lookups.spawnedDescendantIds.mockResolvedValueOnce({ running: ["thr_child"], all: new Set(["thr_child"]) });
    expect(await reviewContinuationPending(f.ctx, { phase: "awaiting-review", reviewDeliveredAt: Date.now() } as ThreadState, "thr")).toBe(true);
  });

  it.each([
    ["a wake-up from a spawned child", { failureReason: null, initiator: "system", origin: "user", sendAt: null, senderThreadId: "thr_child" }, true],
    ["a wake-up from no thread", { failureReason: null, initiator: "system", origin: "user", sendAt: null, senderThreadId: null }, true],
    ["a row of the user's", { failureReason: null, initiator: "user", origin: "user", sendAt: null, senderThreadId: null }, false],
    ["a plugin row", { failureReason: null, initiator: "system", origin: "plugin", sendAt: null, senderThreadId: null }, false],
    ["a failed row", { failureReason: "gone", initiator: "system", origin: "user", sendAt: null, senderThreadId: null }, false],
    ["a row scheduled for later", { failureReason: null, initiator: "system", origin: "user", sendAt: Date.now() + 60_000, senderThreadId: null }, false],
    ["a stranger's row", { failureReason: null, initiator: "system", origin: "user", sendAt: null, senderThreadId: "thr_stranger" }, false],
  ])("%s is judged against the hold", async (_name, row, expected) => {
    const f = fakeBb();
    lookups.spawnedDescendantIds.mockResolvedValueOnce({ running: [], all: new Set(["thr_child"]) });
    f.setRows([row]);
    expect(await reviewContinuationPending(f.ctx, { phase: "awaiting-review", reviewDeliveredAt: Date.now() } as ThreadState, "thr")).toBe(expected);
  });

  it("a failed check warns and ends the hold, whatever the error", async () => {
    const f = fakeBb();
    lookups.spawnedDescendantIds.mockRejectedValueOnce("kaboom");
    expect(await reviewContinuationPending(f.ctx, { phase: "awaiting-review", reviewDeliveredAt: Date.now() } as ThreadState, "thr")).toBe(false);
    expect(f.warnings[0]).toContain("could not check what thr's review is waiting on");
    expect(f.warnings[0]).toContain("kaboom");
  });
});

describe("readEndedTurn", () => {
  it("returns the ended turn as read", async () => {
    const f = fakeBb();
    lookups.endedTurn.mockResolvedValueOnce({ users: true, completedSeq: 9, approvedPlans: [], reviewTurn: false });
    expect(
      await readEndedTurn(f.bb, "thr", { phase: "awaiting-review", handledTurnEndSeq: 5 } as ThreadState, turnStart, true),
    ).toEqual({ read: true, users: true, completedSeq: 9, approvedPlans: [], reviewTurn: false });
  });

  it("an idle with nothing new is null when the read was only catching up", async () => {
    const f = fakeBb();
    lookups.endedTurn.mockRejectedValueOnce(new NoTurnCompletedError("none"));
    expect(
      await readEndedTurn(f.bb, "thr", { phase: "awaiting-review" } as ThreadState, turnStart, false),
    ).toBeNull();
  });

  it("an unread turn counts as theirs, carrying its end when the end was found", async () => {
    const f = fakeBb();
    lookups.endedTurn.mockRejectedValueOnce(new UnreadTurnError("unreadable", 9));
    expect(
      await readEndedTurn(f.bb, "thr", { phase: "awaiting-review" } as ThreadState, turnStart, true),
    ).toEqual({ read: false, completedSeq: 9 });
    expect(f.warnings[0]).toContain("unreadable");
    const stranger = fakeBb();
    lookups.endedTurn.mockRejectedValueOnce("kaboom");
    expect(
      await readEndedTurn(stranger.bb, "thr", { phase: "awaiting-review" } as ThreadState, turnStart, true),
    ).toEqual({ read: false, completedSeq: undefined });
    expect(stranger.warnings[0]).toContain("kaboom");
  });
});

describe("noteUserTurn", () => {
  const ended = (over: Record<string, unknown> = {}) => ({
    users: true,
    completedSeq: 9,
    approvedPlans: [],
    reviewTurn: false,
    ...over,
  });

  it("records a user turn and checks the tree it changed, here against no workspace", async () => {
    const f = fakeBb();
    lookups.endedTurn.mockResolvedValueOnce(ended());
    lookups.endedTurn.mockRejectedValueOnce(new NoTurnCompletedError("none"));
    const held = await noteUserTurn(f.ctx, thread(null), { phase: "awaiting-review", turnStart } as ThreadState);
    expect(held).toMatchObject({
      handledTurnEndSeq: 9,
      userTurnStart: turnStart,
      userTurnAuthored: true,
      userStopFloorSeq: 9,
    });
    expect(f.warnings[0]).toContain("could not read whether the user's turn in thr changed files");
  });

  it("a failed workspace read counts the turn as authored, whatever the error", async () => {
    const f = fakeBb();
    lookups.endedTurn.mockResolvedValueOnce(ended());
    lookups.endedTurn.mockRejectedValueOnce(new NoTurnCompletedError("none"));
    lookups.fetchWorkspace.mockRejectedValueOnce("kaboom");
    const held = await noteUserTurn(f.ctx, thread("env"), { phase: "awaiting-review", turnStart } as ThreadState);
    expect(held.userTurnAuthored).toBe(true);
    expect(f.warnings[0]).toContain("kaboom");
  });

  it("a turn that is not the user's writes only its end", async () => {
    const f = fakeBb();
    lookups.endedTurn.mockResolvedValueOnce(ended({ users: false }));
    lookups.endedTurn.mockRejectedValueOnce(new NoTurnCompletedError("none"));
    const held = await noteUserTurn(f.ctx, thread("env"), { phase: "awaiting-review", turnStart } as ThreadState);
    expect(held).toMatchObject({ handledTurnEndSeq: 9 });
    expect(held.userTurnStart).toBeUndefined();
    expect(lookups.turnChangedPaths).not.toHaveBeenCalled();
  });
});
