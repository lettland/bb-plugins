import { beforeEach, describe, expect, it, vi } from "vitest";
import { lastFireSchema } from "./config.js";
import { recordFire } from "./context.js";
import { parkedFire } from "./detect-park.js";
import { pushedStandDown, staleStandDown } from "./park-stand-down.js";
import { noNewWork, parkBaseline, parkRelease, pushedRelease, staleRelease } from "./no-new-work.js";
import type { ThreadState } from "./state.js";

const lookups = vi.hoisted(() => ({ branchHeadPushed: vi.fn(), firstUserTurnSince: vi.fn(), turnChangedPaths: vi.fn() }));
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
    ["there is no park baseline", undefined, true, 1_000_000 + 60 * 60_000, false],
    ["a turn ran since the park (a wake-up or a tell)", park, false, 1_000_000 + 60 * 60_000, false],
    ["it waited 29 minutes 59 seconds", park, true, 1_000_000 + 30 * 60_000 - 1_000, false],
    ["it waited exactly 30 minutes", park, true, 1_000_000 + 30 * 60_000, true],
  ])("is judged on %s", (_name, baseline, quiet, now, expected) => {
    expect(staleRelease(baseline, quiet, now)).toBe(expected);
  });

  it("is never true for a turn with no park baseline, however old the park", () => {
    expect(staleRelease(parkBaseline(parked, "none"), true, 2_000 + 2 * 60 * 60_000)).toBe(false);
    expect(staleRelease(parkBaseline(parked, "unreadable"), true, 2_000 + 2 * 60 * 60_000)).toBe(false);
  });
});

describe("pushedRelease", () => {
  const park = { startedAt: 2_000, tree };
  const input = { park, quiet: true, turnPaths: ["src/a.ts"], dirty: [], merge: false, headHeld: true };

  it.each([
    ["every condition holds", {}, true],
    ["a dirty path is not the turn's", { dirty: ["src/other.ts"] }, true],
    ["there is no park baseline", { park: undefined }, false],
    ["a turn ran since the park", { quiet: false }, false],
    ["a local merge would run", { merge: true }, false],
    ["the remote does not hold HEAD", { headHeld: false }, false],
    ["a turn path is dirty again after it was committed", { dirty: ["src/a.ts", "src/other.ts"] }, false],
  ])("is judged on: %s", (_name, over, expected) => {
    expect(pushedRelease({ ...input, ...over })).toBe(expected);
  });
});

describe("staleStandDown", () => {
  const park = { startedAt: Date.now() - 31 * 60_000, tree };
  const idle = { phase: "idle" } as unknown as ThreadState;

  it("warns and records a stale-park stand-down for a quiet park that waited 30 minutes", async () => {
    const { ctx, warnings, writes } = context();
    expect(await staleStandDown(ctx, thread, idle, park, true)).toBe(true);
    expect(warnings).toEqual(["auto-review: standing thr down as stale-park; it waited 31 min since it was parked"]);
    expect(writes).toMatchObject([{ outcome: "stood-down", reason: "stale-park" }]);
  });

  it.each([
    ["it is not a released provider park", undefined, true],
    ["a turn ran since the park", park, false],
    ["it waited under 30 minutes", { startedAt: Date.now() - 5 * 60_000, tree }, true],
  ])("leaves the turn alone when %s", async (_name, baseline, quiet) => {
    const { ctx, warnings, writes } = context();
    expect(await staleStandDown(ctx, thread, idle, baseline, quiet)).toBe(false);
    expect(warnings).toEqual([]);
    expect(writes).toEqual([]);
  });
});

describe("pushedStandDown", () => {
  const park = { startedAt: 2_000, tree };
  const idle = { phase: "idle" } as unknown as ThreadState;
  const workspace = {
    branch: { currentBranch: "feature/x" },
    checkout: { kind: "branch", branchName: "feature/x", headSha: "head" },
    workingTree: { files: [{ path: "src/other.ts" }] },
  } as never;
  const input = { environmentId: "env", workspace, turnPaths: ["src/a.ts"], merge: false, park, quiet: true };

  function contextWithInfos() {
    const infos: string[] = [];
    const base = context();
    const ctx = { bb: { ...(base.ctx as { bb: object }).bb, log: { warn: () => undefined, info: (message: string) => infos.push(message) } } } as never;
    return { ctx, infos, writes: base.writes };
  }

  it("records an already-pushed stand-down when the remote holds HEAD and the turn's paths are clean", async () => {
    lookups.branchHeadPushed.mockResolvedValue(true);
    const { ctx, infos, writes } = contextWithInfos();
    expect(await pushedStandDown(ctx, thread, idle, input)).toBe(true);
    expect(lookups.branchHeadPushed).toHaveBeenCalledWith(expect.anything(), "env", "feature/x", "head");
    expect(infos).toEqual(["auto-review: standing thr down as already-pushed; head is on the remote branch"]);
    expect(writes).toMatchObject([{ outcome: "stood-down", reason: "already-pushed" }]);
  });

  it.each([
    ["the remote does not hold HEAD", { ...input }, false],
    ["a local merge would run", { ...input, merge: true }, true],
    ["a turn ran since the park", { ...input, quiet: false }, true],
    ["it is not a released provider park", { ...input, park: undefined }, true],
    ["the checkout is detached from a branch", { ...input, workspace: { ...(workspace as object), branch: { currentBranch: null } } as never }, true],
    ["the checkout has no head", { ...input, workspace: { ...(workspace as object), checkout: { kind: "unborn" } } as never }, true],
    ["a turn path is dirty again", { ...input, workspace: { ...(workspace as object), workingTree: { files: [{ path: "src/a.ts" }] } } as never }, true],
  ])("leaves the turn alone when %s", async (_name, over, pushed) => {
    lookups.branchHeadPushed.mockResolvedValue(pushed);
    const { ctx, writes } = contextWithInfos();
    expect(await pushedStandDown(ctx, thread, idle, over)).toBe(false);
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
