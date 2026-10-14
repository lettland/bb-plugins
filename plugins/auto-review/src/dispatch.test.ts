import { describe, expect, it } from "vitest";
import { commitScanHead, committedSinceHead } from "./dispatch.js";
import { buildReviewPrompt, renderScope } from "./prompt.js";
import type { ThreadState } from "./state.js";

const state = {
  turnStart: { sinceSeq: 0, startedAt: 1_000, tree: { headSha: "0123abcd", files: {}, commits: [] } },
} as unknown as ThreadState;

describe("committedSinceHead", () => {
  it("gives the turn-start head when the turn made commits", () => {
    const turn = { paths: ["a.ts"], commits: ["c1"], committedPaths: ["a.ts"], foreignCommits: [], upstreamCommits: [] };
    expect(committedSinceHead(turn, state)).toBe("0123abcd");
  });

  it("still gives the head for a commit whose paths could not be read", () => {
    const turn = { paths: [], commits: ["unread"], committedPaths: [], foreignCommits: [], upstreamCommits: [] };
    expect(committedSinceHead(turn, state)).toBe("0123abcd");
  });

  it("gives no committed range when the turn made no commits", () => {
    const turn = { paths: ["a.ts"], commits: [], committedPaths: [], foreignCommits: [], upstreamCommits: [] };
    const committedSince = committedSinceHead(turn, state);
    expect(committedSince).toBeNull();
    const text = buildReviewPrompt({
      decision: { commit: true, merge: false },
      reviewMode: "auto",
      scope: renderScope(["a.ts"]),
      committedSince,
      aislopScan: true,
    });
    expect(text).not.toContain("0123abcd");
    expect(text).not.toContain("Do not amend");
    expect(text).toContain("`bb aislop scan`");
  });
});

describe("a turn that made only another thread's commits", () => {
  const turn = {
    paths: ["a.ts"],
    commits: [],
    committedPaths: [],
    foreignCommits: [{ sha: "abcdef1", threadId: "thr_sibling" }],
    upstreamCommits: [],
  };

  it("has no committed range of its own but scans from the turn-start head", () => {
    expect(committedSinceHead(turn, state)).toBeNull();
    expect(commitScanHead(turn, state)).toBe("0123abcd");
  });

  it("names the foreign commits in the prompt and words the scan for both threads", () => {
    const text = buildReviewPrompt({
      decision: { commit: true, merge: false },
      reviewMode: "auto",
      scope: renderScope(["a.ts"]),
      committedSince: committedSinceHead(turn, state),
      commitScanFrom: commitScanHead(turn, state),
      foreignCommits: turn.foreignCommits.map(({ sha }) => sha),
    });
    expect(text).toContain("made this commit during this turn: abcdef1.");
    expect(text).toContain("Scan the commits the other thread made this turn too (`git diff 0123abcd..HEAD`)");
    expect(text).not.toContain("yours and the other thread's");
    expect(text).not.toContain("thr_sibling");
    expect(text).not.toContain("Do not amend");
  });

  it("scans from the head for a mix of own and foreign commits and keeps the own range", () => {
    const mixed = { ...turn, commits: ["c1"], committedPaths: ["a.ts"] };
    expect(committedSinceHead(mixed, state)).toBe("0123abcd");
    expect(commitScanHead(mixed, state)).toBe("0123abcd");
  });

  it("does not widen the scan for a head that moved without a commit of the turn", () => {
    const moved = { paths: ["a.ts"], commits: [], committedPaths: [], foreignCommits: [], upstreamCommits: [] };
    expect(commitScanHead(moved, state)).toBeNull();
  });
});
