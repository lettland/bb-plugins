import { describe, expect, it } from "vitest";
import { lastParkedAtOf, lastParkedLine, providerParkReleaseText, skippedText } from "./cli-park.js";
import type { ThreadState } from "./state.js";

const tree = { headSha: "h0", files: {}, commits: [] };
const parked = {
  phase: "deferred",
  turnStart: { sinceSeq: 1, startedAt: 1_000, tree },
  lastIdle: { sinceSeq: 5, startedAt: 2_000, tree },
} as unknown as ThreadState;

describe("lastParkedAtOf", () => {
  it("is the idle snapshot's time for a provider park with both trees", () => {
    expect(lastParkedAtOf(parked)).toBe(2_000);
  });

  it("is null for a phase that is not a park, a child-held turn, or a snapshot without a tree", () => {
    expect(lastParkedAtOf({ ...parked, phase: "idle" } as ThreadState)).toBeNull();
    expect(lastParkedAtOf({ ...parked, heldBy: ["kid-1"] } as unknown as ThreadState)).toBeNull();
    expect(lastParkedAtOf({ ...parked, lastIdle: { sinceSeq: 5 } } as ThreadState)).toBeNull();
    expect(lastParkedAtOf({ ...parked, turnStart: { sinceSeq: 1 } } as ThreadState)).toBeNull();
  });
});

describe("lastParkedLine", () => {
  it("is empty without a park, and names the clock's stale mark", () => {
    expect(lastParkedLine(null)).toBe("");
    const line = lastParkedLine(Date.now() - 60_000);
    expect(line).toContain("last parked: 1 min ago");
    expect(line).toContain("may stand down if released");
  });

  it("says a past-the-window park may stand down", () => {
    const line = lastParkedLine(Date.now() - 45 * 60_000);
    expect(line).toContain("45 min ago (past 30 min: may stand down when released)");
  });
});

describe("providerParkReleaseText", () => {
  it("tells the two release stories apart", () => {
    expect(providerParkReleaseText(true)).toContain("may stand down instead");
    expect(providerParkReleaseText(false)).toBe("It fires automatically as soon as that review ends.\n");
  });
});

describe("skippedText", () => {
  it("names the commits a park skipped and a skipped merge only for a stale park", () => {
    expect(skippedText({} as never)).toBe("");
    const commits = { skippedCommits: ["0f1e2d3a4b5", "1234567890a"] };
    expect(skippedText(commits as never)).toContain(", commit(s) 0f1e2d3, 1234567 not reviewed");
    expect(skippedText({ ...commits, reason: "stale-park", merge: true } as never)).toContain(
      "not reviewed, merge skipped",
    );
    expect(skippedText({ ...commits, reason: "fired", merge: true } as never)).not.toContain("merge skipped");
  });
});

describe("lastParkedAtOf: a park snapshot without a time", () => {
  it("is null when the idle snapshot has trees but no time", () => {
    const tree = { headSha: "h0", files: {}, commits: [] };
    expect(
      lastParkedAtOf({
        phase: "deferred",
        turnStart: { sinceSeq: 1, tree },
        lastIdle: { sinceSeq: 5, tree },
      } as unknown as ThreadState),
    ).toBeNull();
  });
});
