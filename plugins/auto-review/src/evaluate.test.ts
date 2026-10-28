import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { GateThreadLike, ReviewContext } from "./context.js";
import { evaluate, handleIdle } from "./evaluate.js";
import { REVIEW_CONTINUATION_CAP_MS, STALE_WINDOW_MS } from "./state.js";

const lookups = vi.hoisted(() => ({
  fetchWorkspace: vi.fn(),
  firstUserTurnSince: vi.fn(),
  stoppedByUser: vi.fn(),
  runningChildIds: vi.fn(),
  turnChangedPaths: vi.fn(),
}));
vi.mock("./detect.js", async (original) => ({
  ...(await original<typeof import("./detect.js")>()),
  ...lookups,
}));
const deferral = vi.hoisted(() => ({ providerReviewInFlight: vi.fn() }));
vi.mock("./deferral.js", async (original) => ({
  ...(await original<typeof import("./deferral.js")>()),
  providerReviewInFlight: deferral.providerReviewInFlight,
}));
const noWork = vi.hoisted(() => ({ parkRelease: vi.fn(), parkBaseline: vi.fn(), noNewWork: vi.fn() }));
vi.mock("./no-new-work.js", async (original) => ({
  ...(await original<typeof import("./no-new-work.js")>()),
  ...noWork,
}));
const standDowns = vi.hoisted(() => ({ parkStandDown: vi.fn() }));
vi.mock("./park-stand-down.js", async (original) => ({
  ...(await original<typeof import("./park-stand-down.js")>()),
  parkStandDown: standDowns.parkStandDown,
}));
const turns = vi.hoisted(() => ({ userTurnQueued: vi.fn(), userTurnRunning: vi.fn() }));
vi.mock("./user-turn.js", async (original) => ({
  ...(await original<typeof import("./user-turn.js")>()),
  ...turns,
}));
const dispatch = vi.hoisted(() => ({ dispatchReview: vi.fn() }));
vi.mock("./dispatch.js", async (original) => ({
  ...(await original<typeof import("./dispatch.js")>()),
  dispatchReview: dispatch.dispatchReview,
}));
const lastIdle = vi.hoisted(() => ({ refreshLastIdle: vi.fn() }));
vi.mock("./last-idle.js", async (original) => ({
  ...(await original<typeof import("./last-idle.js")>()),
  refreshLastIdle: lastIdle.refreshLastIdle,
}));
const continuation = vi.hoisted(() => ({
  noteUserTurn: vi.fn(),
  reviewContinuationPending: vi.fn(),
}));
vi.mock("./review-continuation.js", async (original) => ({
  ...(await original<typeof import("./review-continuation.js")>()),
  ...continuation,
}));
const outcome = vi.hoisted(() => ({ recordUnfinishedReview: vi.fn(), userStoppedReview: vi.fn() }));
vi.mock("./review-outcome.js", async (original) => ({
  ...(await original<typeof import("./review-outcome.js")>()),
  recordUnfinishedReview: outcome.recordUnfinishedReview,
  userStoppedReview: outcome.userStoppedReview,
}));

beforeEach(() => {
  vi.clearAllMocks();
  noWork.parkRelease.mockResolvedValue("none");
  noWork.parkBaseline.mockReturnValue(undefined);
  noWork.noNewWork.mockResolvedValue(false);
  standDowns.parkStandDown.mockResolvedValue(false);
  turns.userTurnQueued.mockResolvedValue({ busy: false, queued: false, userQueued: false });
  turns.userTurnRunning.mockResolvedValue(false);
  deferral.providerReviewInFlight.mockResolvedValue(false);
  lookups.stoppedByUser.mockResolvedValue(false);
  lookups.runningChildIds.mockResolvedValue([]);
  continuation.noteUserTurn.mockImplementation(
    async (_ctx: unknown, _thread: unknown, state: unknown) => state,
  );
  continuation.reviewContinuationPending.mockResolvedValue(false);
  outcome.userStoppedReview.mockResolvedValue(false);
});

const workspace = {
  checkout: { kind: "branch", branchName: "feature/x", headSha: "head" },
  workingTree: { files: [{ path: "src/a.ts" }] },
  mergeBase: { files: [], mergeBaseBranch: "master", baseRef: "head", aheadCount: 0, commits: [] },
  branch: { currentBranch: "feature/x", defaultBranch: "master" },
};

const turn = {
  paths: ["src/a.ts"],
  commits: [],
  committedPaths: [],
  foreignCommits: [],
  upstreamCommits: [],
  parkedCommits: [],
  parkedPaths: [],
  unclaimed: [],
};

function fakeBb(seed: Record<string, unknown> = {}) {
  const warnings: string[] = [];
  const kvWrites: Array<[string, unknown]> = [];
  const metadata: Record<string, unknown> = { ...seed };
  const bb = {
    sdk: {
      threads: {
        get: async () => ({ status: "idle" }),
        list: async () => [],
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
        set: async (key: string, value: unknown) => {
          kvWrites.push([key, value]);
        },
        delete: async () => undefined,
        list: async () => [] as string[],
      },
    },
    log: {
      warn: (message: string) => warnings.push(message),
      info: () => undefined,
    },
  } as unknown as BbPluginApi;
  const ctx = { bb, settings: {}, globals: { enabled: true, mergeEligibleMainlines: ["master"], reviewMode: "auto" } } as unknown as ReviewContext;
  const thread = (environmentId: string | null) =>
    ({ id: "thr", projectId: "p", environmentId, providerId: "claude-code" }) as unknown as GateThreadLike;
  return { bb, ctx, warnings, kvWrites, metadata, thread };
}

describe("evaluate", () => {
  it("a thread without an environment stops after deciding its turn", async () => {
    const { ctx, metadata, kvWrites, thread } = fakeBb({ turnStart: { sinceSeq: 1 } });
    await evaluate(ctx, thread(null));
    expect(metadata.turnDecided).toBe(true);
    expect(lookups.fetchWorkspace).not.toHaveBeenCalled();
    expect(kvWrites).toEqual([]);
  });

  it("an unreadable workspace stands the turn down as status-unavailable", async () => {
    const { ctx, kvWrites, thread } = fakeBb({ turnStart: { sinceSeq: 1 } });
    lookups.fetchWorkspace.mockResolvedValueOnce(null);
    await evaluate(ctx, thread("env"));
    expect(lookups.fetchWorkspace).toHaveBeenCalledTimes(1);
    expect(lookups.turnChangedPaths).not.toHaveBeenCalled();
    const fire = kvWrites.find(([key]) => key === "lastfire:p:thr");
    expect(fire?.[1]).toMatchObject({ outcome: "stood-down", reason: "status-unavailable" });
  });

  it("a stand-down that parks behind another review ends the evaluation before dispatch", async () => {
    const { ctx, thread } = fakeBb({ turnStart: { sinceSeq: 1 } });
    lookups.fetchWorkspace.mockResolvedValueOnce(workspace);
    lookups.turnChangedPaths.mockResolvedValueOnce(turn);
    standDowns.parkStandDown.mockResolvedValueOnce(true);
    await evaluate(ctx, thread("env"));
    expect(standDowns.parkStandDown).toHaveBeenCalledTimes(1);
    expect(dispatch.dispatchReview).not.toHaveBeenCalled();
  });

  it("an unreadable already-reviewed check reviews anyway, whatever the error", async () => {
    const { ctx, warnings, kvWrites, thread } = fakeBb({
      turnStart: { sinceSeq: 1 },
      lastCodeReviewSeq: 10,
    });
    lookups.fetchWorkspace.mockResolvedValueOnce(workspace);
    lookups.firstUserTurnSince.mockRejectedValueOnce("kaboom");
    lookups.turnChangedPaths.mockResolvedValueOnce({ ...turn, paths: [] });
    await evaluate(ctx, thread("env"));
    expect(warnings[0]).toContain("could not read whether the user wrote since the last review of thr");
    expect(warnings[0]).toContain("kaboom");
    const fire = kvWrites.find(([key]) => key === "lastfire:p:thr");
    expect(fire?.[1]).toMatchObject({ outcome: "stood-down", reason: "no-authorship" });
  });

  // Regression origin thr_4dg2yfp8d7: the user's own uncommitted work sat in a
  // shared checkout while a planning thread held it, and auto-review dispatched
  // a code review over it mid-plan.
  it("thr_4dg2yfp8d7: an armed native plan gate carries the idle's changes instead of dispatching a code review", async () => {
    const { ctx, kvWrites, thread } = fakeBb({
      turnStart: { sinceSeq: 1 },
      planReviewArmedAt: Date.now() - 1_000,
      planReviewLight: false,
    });
    lookups.fetchWorkspace.mockResolvedValueOnce(workspace);
    await evaluate(ctx, thread("env"));
    expect(dispatch.dispatchReview).not.toHaveBeenCalled();
    const fire = kvWrites.find(([key]) => key === "lastfire:p:thr");
    expect(fire?.[1]).toMatchObject({
      outcome: "deferred",
      reason: "plan-in-review",
      planReviewerCount: 0,
      planReviewTier: "standard",
    });
  });

  it("thr_4dg2yfp8d7: an active PresentPlan arm holds too, whatever path it armed for", async () => {
    const { ctx, kvWrites, thread } = fakeBb({
      turnStart: { sinceSeq: 1 },
      presentPlanArmedAt: Date.now() - 1_000,
      presentPlanArmedPath: "docs/plans/some-other-plan.md",
      presentPlanLight: true,
    });
    lookups.fetchWorkspace.mockResolvedValueOnce(workspace);
    await evaluate(ctx, thread("env"));
    expect(dispatch.dispatchReview).not.toHaveBeenCalled();
    const fire = kvWrites.find(([key]) => key === "lastfire:p:thr");
    expect(fire?.[1]).toMatchObject({
      outcome: "deferred",
      reason: "plan-in-review",
      planReviewerCount: 0,
      planReviewTier: "light",
    });
  });

  it("the hold outranks already-reviewed in the fire ledger", async () => {
    const { ctx, kvWrites, thread } = fakeBb({
      turnStart: { sinceSeq: 1 },
      planReviewArmedAt: Date.now() - 1_000,
      lastCodeReviewSeq: 10,
    });
    lookups.fetchWorkspace.mockResolvedValueOnce(workspace);
    lookups.firstUserTurnSince.mockResolvedValueOnce(null);
    await evaluate(ctx, thread("env"));
    const fire = kvWrites.find(([key]) => key === "lastfire:p:thr");
    expect(fire?.[1]).toMatchObject({ outcome: "deferred", reason: "plan-in-review" });
  });

  it("a queued native hold past the stale window no longer suppresses the review", async () => {
    const { ctx, thread } = fakeBb({
      turnStart: { sinceSeq: 1 },
      planReviewArmedAt: Date.now() - STALE_WINDOW_MS - 5 * 60_000,
      planReviewEntryId: "qm-1",
    });
    lookups.fetchWorkspace.mockResolvedValueOnce(workspace);
    lookups.turnChangedPaths.mockResolvedValueOnce(turn);
    await evaluate(ctx, thread("env"));
    expect(dispatch.dispatchReview).toHaveBeenCalledTimes(1);
  });

  it("a delivered native hold past the continuation cap no longer suppresses the review", async () => {
    const { ctx, thread } = fakeBb({
      turnStart: { sinceSeq: 1 },
      planReviewArmedAt: Date.now() - REVIEW_CONTINUATION_CAP_MS - 5 * 60_000,
      planReviewDeliveredSeq: 100,
    });
    lookups.fetchWorkspace.mockResolvedValueOnce(workspace);
    lookups.turnChangedPaths.mockResolvedValueOnce(turn);
    await evaluate(ctx, thread("env"));
    expect(dispatch.dispatchReview).toHaveBeenCalledTimes(1);
  });

  it("a PresentPlan arm past the cap no longer suppresses the review", async () => {
    const { ctx, thread } = fakeBb({
      turnStart: { sinceSeq: 1 },
      presentPlanArmedAt: Date.now() - REVIEW_CONTINUATION_CAP_MS - 5 * 60_000,
    });
    lookups.fetchWorkspace.mockResolvedValueOnce(workspace);
    lookups.turnChangedPaths.mockResolvedValueOnce(turn);
    await evaluate(ctx, thread("env"));
    expect(dispatch.dispatchReview).toHaveBeenCalledTimes(1);
  });

  it("a live native hold keeps suppressing past a leftover expired PresentPlan arm", async () => {
    // Regression origin: the advisor review of 202a708 — a stale PresentPlan
    // arm that leaked into the native gate's expiry lifted the hold while the
    // native window was still open.
    const { ctx, kvWrites, thread } = fakeBb({
      turnStart: { sinceSeq: 1 },
      planReviewArmedAt: Date.now() - 1_000,
      presentPlanArmedAt: Date.now() - REVIEW_CONTINUATION_CAP_MS - 5 * 60_000,
    });
    lookups.fetchWorkspace.mockResolvedValueOnce(workspace);
    await evaluate(ctx, thread("env"));
    expect(dispatch.dispatchReview).not.toHaveBeenCalled();
    const fire = kvWrites.find(([key]) => key === "lastfire:p:thr");
    expect(fire?.[1]).toMatchObject({ outcome: "deferred", reason: "plan-in-review" });
  });

  it("thr_4dg2yfp8d7: the plan-in-review carry anchors its snapshot without a user-turn boundary", async () => {
    // The composed end-to-end exclusion (the user's uncommitted mid-hold edits
    // staying out of the post-approval dispatch) is covered by manual replay:
    // the detect mock hides it here.
    const { ctx, thread } = fakeBb({
      turnStart: { sinceSeq: 1 },
      planReviewArmedAt: Date.now() - 1_000,
    });
    const thr = thread("env");
    lookups.fetchWorkspace.mockResolvedValueOnce(workspace);
    await evaluate(ctx, thr);
    expect(lastIdle.refreshLastIdle).toHaveBeenCalledWith(ctx.bb, thr, {});
  });
});

describe("handleIdle", () => {
  it("a review in flight when the plan arms finishes: the continuation stays untouched", async () => {
    const { ctx, metadata, kvWrites, thread } = fakeBb({
      phase: "awaiting-review",
      turnStart: { sinceSeq: 1 },
      reviewDeliveredAt: Date.now() - 1_000,
      planReviewArmedAt: Date.now() - 1_000,
    });
    continuation.reviewContinuationPending.mockResolvedValueOnce(true);
    await handleIdle(ctx, thread("env"));
    expect(metadata.phase).toBe("awaiting-review");
    expect(outcome.recordUnfinishedReview).not.toHaveBeenCalled();
    expect(kvWrites.find(([key]) => key === "lastfire:p:thr")).toBeUndefined();
    expect(dispatch.dispatchReview).not.toHaveBeenCalled();
  });
});
