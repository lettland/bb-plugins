import { describe, expect, it } from "vitest";
import { commitScan, foreignCommitNote, parkedCommitNote, turnCommitText, upstreamCommitNote } from "./prompt-commits.js";

describe("commit notes", () => {
  it("names one and many foreign commits", () => {
    expect(foreignCommitNote(["abc1234"], null)).toContain("Another thread in this checkout made this commit during this turn: abc1234.");
    expect(foreignCommitNote(["abc1234", "def5678"], null)).toContain("made these commits");
    expect(foreignCommitNote(["abc1234"], null)).toContain("do not review, stage, complete, amend, or otherwise rewrite it");
    expect(foreignCommitNote(["abc1234", "def5678"], null)).toContain("rewrite them");
  });

  it("points foreign commits at the range when one exists", () => {
    expect(foreignCommitNote(["abc1234"], "fedcba0")).toContain("They may appear in the range after fedcba0");
    expect(foreignCommitNote(["abc1234"], "fedcba0")).toContain("It is not part of your work");
  });

  it("names one and many parked commits, in and out of a range", () => {
    expect(parkedCommitNote(["abc1234"], null)).toContain("This commit arrived while this turn waited");
    expect(parkedCommitNote(["abc1234"], null)).toContain("Someone else made it, so it is not part of your work");
    const many = parkedCommitNote(["abc1234", "def5678"], "fedcba0");
    expect(many).toContain("These commits arrived while this turn waited");
    expect(many).toContain(" They may appear in the range after fedcba0; they are still not this thread's.");
    expect(many).toContain("Someone else made them, so they are not part of your work");
    const manyNoRange = parkedCommitNote(["abc1234", "def5678"], null);
    expect(manyNoRange).toContain("rewrite them");
    expect(manyNoRange).not.toContain("range after");
  });

  it("names upstream commits with or without this thread's own", () => {
    const alone = upstreamCommitNote(["abc1234"], [], "fedcba0");
    expect(alone).toContain("also holds a commit merged from the remote base");
    expect(alone).not.toContain("own commit");
    const withOwn = upstreamCommitNote(["abc1234", "def5678"], ["0f1e2d3"], "fedcba0");
    expect(withOwn).toContain("also holds commits merged from the remote base");
    expect(withOwn).toContain("This thread's own commit is 0f1e2d3: review exactly that one");
    expect(withOwn).toContain("They may appear in that range");
  });
});

describe("commitScan", () => {
  it("is empty without a range", () => {
    expect(commitScan({ scanSince: null, hasForeign: false, hasUpstream: false, hasParked: false, hasOwn: false, merge: false })).toBe("");
  });

  it("scans the turn's own commits when there are no other commits", () => {
    const scan = commitScan({ scanSince: "aaa0000", hasForeign: false, hasUpstream: false, hasParked: false, hasOwn: true, merge: false });
    expect(scan).toContain("git diff aaa0000..HEAD");
    expect(scan).toContain("Scan this turn's commits too");
  });

  it("names yours and the other commits when the queue or the remote base added some", () => {
    const own = commitScan({ scanSince: "aaa0000", hasForeign: false, hasUpstream: true, hasParked: false, hasOwn: true, merge: false });
    expect(own).toContain("yours and the other commits in that range");
    const other = commitScan({ scanSince: "aaa0000", hasForeign: true, hasUpstream: false, hasParked: false, hasOwn: false, merge: false });
    expect(other).toContain("Scan the commits the other thread made this turn too");
    const generic = commitScan({ scanSince: "aaa0000", hasForeign: false, hasUpstream: false, hasParked: true, hasOwn: false, merge: false });
    expect(generic).toContain("Scan the other commits in that range too");
  });

  it("tells the reviewer not to stop for a secret in the other commits, and to skip a merge", () => {
    const plain = commitScan({ scanSince: "aaa0000", hasForeign: true, hasUpstream: false, hasParked: false, hasOwn: true, merge: false });
    expect(plain).toContain("Do not STOP for it: still commit your own work.");
    const merged = commitScan({ scanSince: "aaa0000", hasForeign: true, hasUpstream: false, hasParked: false, hasOwn: true, merge: true });
    expect(merged).toContain("skip the merge in step 8");
  });
});

describe("turnCommitText", () => {
  it("drops values that are not commit shas and skips empty notes", () => {
    const text = turnCommitText({
      foreign: ["not a sha", "abc1234"],
      upstream: [],
      parked: [],
      own: [],
      committedSince: null,
      scanSince: "aaa0000",
      merge: false,
    });
    expect(text.notes).toHaveLength(1);
    expect(text.notes[0]).toContain("abc1234");
    expect(text.skipFiles).toContain("the other thread's commits");
  });

  it("names upstream commits only when a range holds them", () => {
    const ranged = turnCommitText({
      foreign: [],
      upstream: ["abc1234"],
      parked: [],
      own: ["0f1e2d3"],
      committedSince: "fedcba0",
      scanSince: "aaa0000",
      merge: false,
    });
    expect(ranged.notes).toHaveLength(1);
    expect(ranged.notes[0]).toContain("0f1e2d3");
    const unRanged = turnCommitText({
      foreign: [],
      upstream: ["abc1234"],
      parked: [],
      own: [],
      committedSince: null,
      scanSince: null,
      merge: false,
    });
    expect(unRanged.notes).toEqual([]);
    expect(unRanged.scan).toBe("");
    expect(unRanged.skipFiles).toBe("");
  });

  it("leaves the files of parked commits out too", () => {
    const text = turnCommitText({
      foreign: [],
      upstream: [],
      parked: ["abc1234"],
      own: [],
      committedSince: null,
      scanSince: "aaa0000",
      merge: false,
    });
    expect(text.skipFiles).toContain("the commits that arrived while this turn waited");
  });
});
