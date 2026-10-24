import { beforeEach, describe, expect, it, vi } from "vitest";
import { lastFireSchema } from "./config.js";
import { recordFire } from "./context.js";
import { parkedFire } from "./detect-park.js";
import { parkStandDown } from "./park-stand-down.js";
import { noNewWork, parkBaseline, parkRelease, pushedRelease, staleRelease } from "./no-new-work.js";
import type { ThreadState } from "./state.js";

const lookups = vi.hoisted(() => ({
  branchHeadPushed: vi.fn(),
  firstUserTurnSince: vi.fn(),
  quietSincePark: vi.fn(),
  turnChangedPaths: vi.fn(),
}));
vi.mock("./detect.js", async (original) => ({ ...(await original<typeof import("./detect.js")>()), ...lookups }));

const tree = { headSha: "h0", files: {}, commits: [] };
const thread = { id: "thr", projectId: "p", environmentId: "env", providerId: "claude-code" } as never;
const parked = {
  phase: "deferred",
  turnStart: { sinceSeq: 1, startedAt: 1_000, tree },
  lastIdle: { sinceSeq: 5, startedAt: 2_000, tree },
} as unknown as ThreadState;

function context() {
  const warnings: string[] = [];
  const writes: unknown[] = [];
  const ctx = {
    bb: {
      log: { warn: (message: string) => warnings.push(message), info: () => undefined },
      storage: { kv: { set: async (_key: string, value: unknown) => writes.push(value), get: async () => undefined } },
      sdk: { threads: { get: async () => ({ status: "idle" }) } },
    },
  } as never;
  return { ctx, warnings, writes };
}

beforeEach(() => {
  lookups.branchHeadPushed.mockReset();
  lookups.firstUserTurnSince.mockReset();
  lookups.quietSincePark.mockReset();
  lookups.turnChangedPaths.mockReset();
});

describe("parkRelease", () => {
  it("is a release when no user request came after the park snapshot", async () => {
    lookups.firstUserTurnSince.mockResolvedValue(null);
    expect(await parkRelease(context().ctx, thread, parked)).toBe("released");
    expect(lookups.firstUserTurnSince).toHaveBeenCalledWith(expect.anything(), "thr", 5);
  });

  it("is not one when the user wrote after the park snapshot", async () => {
    lookups.firstUserTurnSince.mockResolvedValue(7);
    expect(await parkRelease(context().ctx, thread, parked)).toBe("none");
  });

  it("reads nothing for a turn that was not parked, or has no park tree", async () => {
    const { ctx } = context();
    expect(await parkRelease(ctx, thread, { ...parked, phase: "idle" } as ThreadState)).toBe("none");
    expect(await parkRelease(ctx, thread, { ...parked, lastIdle: { sinceSeq: 5 } } as ThreadState)).toBe("none");
    expect(lookups.firstUserTurnSince).not.toHaveBeenCalled();
  });

  it("says so, and warns, when the lookup fails", async () => {
    lookups.firstUserTurnSince.mockRejectedValue(new Error("events unavailable"));
    const { ctx, warnings } = context();
    expect(await parkRelease(ctx, thread, parked)).toBe("unreadable");
    expect(warnings).toEqual([
      "auto-review: could not read whether the user wrote since thr was parked; reviewing anyway: events unavailable",
    ]);
  });

  it("warns the same whatever the error is", async () => {
    lookups.firstUserTurnSince.mockRejectedValue("kaboom");
    const { ctx, warnings } = context();
    expect(await parkRelease(ctx, thread, parked)).toBe("unreadable");
    expect(warnings).toEqual([
      "auto-review: could not read whether the user wrote since thr was parked; reviewing anyway: kaboom",
    ]);
  });
});

describe("parkBaseline", () => {
  it("is the park snapshot's time and tree for a released provider park", () => {
    expect(parkBaseline(parked, "released")).toEqual({ startedAt: 2_000, tree });
  });

  it.each([
    ["a user turn re-ran it", parked, "none"],
    ["the lookup failed", parked, "unreadable"],
    ["children hold it", { ...parked, heldBy: ["kid"] }, "released"],
    ["the park snapshot has no time", { ...parked, lastIdle: { sinceSeq: 5, tree } }, "released"],
    ["the park snapshot has no tree", { ...parked, lastIdle: { sinceSeq: 5, startedAt: 2_000 } }, "released"],
    ["the turn start has no tree", { ...parked, turnStart: { sinceSeq: 1, startedAt: 1_000 } }, "released"],
    ["there is no park snapshot", { ...parked, lastIdle: undefined }, "released"],
  ] as const)("is nothing when %s", (_name, state, release) => {
    expect(parkBaseline(state as unknown as ThreadState, release)).toBeUndefined();
  });
});

describe("staleRelease", () => {
  const park = { startedAt: 1_000_000, tree };

  it.each([
    ["29 minutes 59 seconds", 1_000_000 + 30 * 60_000 - 1_000, false],
    ["exactly 30 minutes", 1_000_000 + 30 * 60_000, true],
  ])("is judged on a park that waited %s", (_name, now, expected) => {
    expect(staleRelease(park, now)).toBe(expected);
  });
});

describe("pushedRelease", () => {
  it.each([
    ["no turn path is dirty", [], true],
    ["a dirty path is not the turn's", ["src/other.ts"], true],
    ["a turn path is dirty again after it was committed", ["src/a.ts", "src/other.ts"], false],
  ])("is judged on: %s", (_name, dirty, expected) => {
    expect(pushedRelease(["src/a.ts"], dirty)).toBe(expected);
  });
});

describe("parkStandDown", () => {
  const MIN = 60_000;
  const fresh = { startedAt: Date.now() - 5 * MIN, tree };
  const stale = { startedAt: Date.now() - 31 * MIN, tree };
  const workspace = {
    branch: { currentBranch: "feature/x", defaultBranch: "master" },
    checkout: { kind: "branch", branchName: "feature/x", headSha: "head" },
    mergeBase: { mergeBaseBranch: "master" },
    workingTree: { files: [{ path: "src/a.ts" }] },
  } as never;
  const input = {
    environmentId: "env",
    workspace,
    turn: { paths: ["src/a.ts"], commits: ["c1c1c1c1c1", "c2c2c2c2c2"] } as never,
    scope: ["src/a.ts"],
    merge: false,
    park: fresh as typeof fresh | undefined,
  };

  function harness(phase: "idle" | "deferred" = "idle") {
    const warnings: string[] = [];
    const infos: string[] = [];
    const writes: unknown[] = [];
    const metadata: unknown[] = [];
    const deleted: string[] = [];
    const ctx = {
      bb: {
        log: { warn: (message: string) => warnings.push(message), info: (message: string) => infos.push(message) },
        storage: {
          kv: { set: async (_key: string, value: unknown) => writes.push(value), get: async () => undefined, delete: async (key: string) => deleted.push(key) },
        },
        sdk: { threads: { updatePluginMetadata: async (args: unknown) => metadata.push(args) } },
        realtime: { publish: async () => undefined },
      },
    } as never;
    const state = { phase, lastIdle: { sinceSeq: 5, startedAt: 2_000, tree } } as unknown as ThreadState;
    return { ctx, state, warnings, infos, writes, metadata, deleted };
  }

  it("reads nothing for a turn that is not a released provider park", async () => {
    const { ctx, state, writes } = harness();
    expect(await parkStandDown(ctx, thread, state, { ...input, park: undefined })).toBe(false);
    expect(lookups.quietSincePark).not.toHaveBeenCalled();
    expect(lookups.branchHeadPushed).not.toHaveBeenCalled();
    expect(writes).toEqual([]);
  });

  it("leaves a park alone when a turn ran since it, or it has no cursor to read from", async () => {
    lookups.quietSincePark.mockResolvedValue(false);
    const { ctx, state, writes } = harness();
    expect(await parkStandDown(ctx, thread, state, { ...input, park: stale })).toBe(false);
    expect(lookups.quietSincePark).toHaveBeenCalledWith(expect.anything(), "thr", 5);
    expect(await parkStandDown(ctx, thread, { ...state, lastIdle: undefined } as ThreadState, { ...input, park: stale })).toBe(false);
    expect(lookups.branchHeadPushed).not.toHaveBeenCalled();
    expect(writes).toEqual([]);
  });

  it("stands a stale park down as stale-park, recording the skipped commits, scope and merge, with no remote read", async () => {
    lookups.quietSincePark.mockResolvedValue(true);
    const { ctx, state, warnings, writes } = harness();
    expect(await parkStandDown(ctx, thread, state, { ...input, park: stale, merge: true })).toBe(true);
    expect(warnings).toEqual([
      "auto-review: standing thr down as stale-park after 31 min; 2 commit(s) not reviewed or secret-scanned: c1c1c1c, c2c2c2c; merge into master skipped",
    ]);
    expect(writes).toMatchObject([
      { outcome: "stood-down", reason: "stale-park", skippedCommits: ["c1c1c1c1c1", "c2c2c2c2c2"], scopePaths: ["src/a.ts"], merge: true },
    ]);
    expect(lastFireSchema.safeParse(writes[0]).success).toBe(true);
    expect(lookups.branchHeadPushed).not.toHaveBeenCalled();
  });

  it("names only the example commits and omits the parts that do not apply", async () => {
    lookups.quietSincePark.mockResolvedValue(true);
    const { ctx, state, warnings } = harness();
    const commits = Array.from({ length: 7 }, (_, at) => `${at}abcdefabc`);
    await parkStandDown(ctx, thread, state, { ...input, park: stale, turn: { paths: [], commits } as never });
    expect(warnings).toEqual([
      "auto-review: standing thr down as stale-park after 31 min; 7 commit(s) not reviewed or secret-scanned: 0abcdef, 1abcdef, 2abcdef, 3abcdef, 4abcdef",
    ]);
    const bare = harness();
    await parkStandDown(bare.ctx, thread, bare.state, { ...input, park: stale, turn: { paths: [], commits: [] } as never });
    expect(bare.warnings).toEqual(["auto-review: standing thr down as stale-park after 31 min"]);
  });

  it("unparks a deferred turn it stands down", async () => {
    lookups.quietSincePark.mockResolvedValue(true);
    const { ctx, state, metadata, deleted } = harness("deferred");
    expect(await parkStandDown(ctx, thread, state, { ...input, park: stale })).toBe(true);
    expect(metadata).toMatchObject([{ threadId: "thr", set: { phase: "idle" }, remove: expect.arrayContaining(["deferredSince", "heldBy"]) }]);
    expect(deleted).toHaveLength(1);
  });

  it("stands a fresh park down as already-pushed when the remote holds HEAD, using the fresh dirty paths", async () => {
    lookups.quietSincePark.mockResolvedValue(true);
    lookups.branchHeadPushed.mockResolvedValue(["src/other.ts"]);
    const { ctx, state, infos, writes, deleted } = harness("deferred");
    expect(await parkStandDown(ctx, thread, state, input)).toBe(true);
    expect(lookups.branchHeadPushed).toHaveBeenCalledWith(expect.anything(), "env", "feature/x", "head");
    expect(infos).toEqual(["auto-review: standing thr down as already-pushed; head is on the remote branch"]);
    expect(writes).toMatchObject([
      { outcome: "stood-down", reason: "already-pushed", skippedCommits: ["c1c1c1c1c1", "c2c2c2c2c2"], scopePaths: ["src/a.ts"], merge: false },
    ]);
    expect(deleted).toHaveLength(1);
  });

  it("does not use the stale snapshot's dirty paths: a turn path dirty in the fresh read keeps the turn", async () => {
    lookups.quietSincePark.mockResolvedValue(true);
    lookups.branchHeadPushed.mockResolvedValue(["src/a.ts"]);
    const { ctx, state, writes } = harness();
    expect(await parkStandDown(ctx, thread, state, { ...input, workspace: { ...(workspace as object), workingTree: { files: [] } } as never })).toBe(false);
    expect(writes).toEqual([]);
  });

  it("keeps the turn when the remote does not hold HEAD", async () => {
    lookups.quietSincePark.mockResolvedValue(true);
    lookups.branchHeadPushed.mockResolvedValue(null);
    const { ctx, state, writes } = harness();
    expect(await parkStandDown(ctx, thread, state, input)).toBe(false);
    expect(writes).toEqual([]);
  });

  it.each([
    ["a local merge would run", { merge: true }],
    ["there is no current branch", { workspace: { ...(workspace as object), branch: { currentBranch: null } } as never }],
    ["the checkout has no head", { workspace: { ...(workspace as object), checkout: { kind: "unborn" } } as never }],
  ])("asks the remote nothing and keeps the turn when %s", async (_name, over) => {
    lookups.quietSincePark.mockResolvedValue(true);
    const { ctx, state, writes } = harness();
    expect(await parkStandDown(ctx, thread, state, { ...input, ...over })).toBe(false);
    expect(lookups.branchHeadPushed).not.toHaveBeenCalled();
    expect(writes).toEqual([]);
  });
});

describe("noNewWork and the shared release", () => {
  it("lets a turn whose release could not be read go on to review, with no park baseline to filter by", async () => {
    lookups.firstUserTurnSince.mockRejectedValue(new Error("events unavailable"));
    const { ctx } = context();
    const release = await parkRelease(ctx, thread, parked);
    expect(await noNewWork(ctx, thread, parked, "env", {} as never, [], release)).toBe(false);
    expect(parkBaseline(parked, release)).toBeUndefined();
    // One lookup served both, and the turn was not judged by the gate.
    expect(lookups.firstUserTurnSince).toHaveBeenCalledTimes(1);
    expect(lookups.turnChangedPaths).not.toHaveBeenCalled();
  });

  it("lets a released turn review and gives it the baseline", async () => {
    lookups.firstUserTurnSince.mockResolvedValue(null);
    const { ctx } = context();
    const release = await parkRelease(ctx, thread, parked);
    expect(await noNewWork(ctx, thread, parked, "env", {} as never, [], release)).toBe(false);
    expect(parkBaseline(parked, release)).toMatchObject({ startedAt: 2_000 });
    expect(lookups.turnChangedPaths).not.toHaveBeenCalled();
  });
});

describe("what a fire records of the changes left out as made while the turn waited", () => {
  it("is nothing when none were", () => {
    expect(parkedFire({ parkedPaths: [], parkedCommits: [] })).toEqual({});
  });

  it("keeps the count, the commits and up to five example paths", () => {
    const parkedPaths = Array.from({ length: 7 }, (_, at) => `src/f${at}.ts`);
    expect(parkedFire({ parkedPaths, parkedCommits: ["abcdef1"] })).toEqual({
      parkedCount: 7,
      parkedCommits: ["abcdef1"],
      parkedPaths: parkedPaths.slice(0, 5),
    });
  });

  it("survives recordFire and the stored schema, with the new stand-down reason", async () => {
    const { ctx, writes } = context();
    const extra = parkedFire({ parkedPaths: ["src/a.ts"], parkedCommits: ["abcdef1"] });
    await recordFire(ctx, "p", "thr", "stood-down", "changed-while-parked", extra);
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({
      outcome: "stood-down",
      reason: "changed-while-parked",
      parkedCount: 1,
      parkedCommits: ["abcdef1"],
      parkedPaths: ["src/a.ts"],
    });
    expect(lastFireSchema.safeParse(writes[0]).success).toBe(true);
  });
});
