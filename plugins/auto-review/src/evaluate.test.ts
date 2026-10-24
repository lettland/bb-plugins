import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { GateThreadLike, ReviewContext } from "./context.js";
import { evaluate } from "./evaluate.js";

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
});
