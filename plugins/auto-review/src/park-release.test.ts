import { beforeEach, describe, expect, it, vi } from "vitest";
import { lastFireSchema } from "./config.js";
import { recordFire } from "./context.js";
import { parkedFire } from "./detect-park.js";
import { noNewWork, parkBaseline, parkRelease } from "./no-new-work.js";
import type { ThreadState } from "./state.js";

const lookups = vi.hoisted(() => ({ firstUserTurnSince: vi.fn(), turnChangedPaths: vi.fn() }));
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
