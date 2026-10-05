import { describe, expect, it } from "vitest";
import { committedSinceHead } from "./dispatch.js";
import { buildReviewPrompt, renderScope } from "./prompt.js";
import type { ThreadState } from "./state.js";

const state = {
  turnStart: { sinceSeq: 0, startedAt: 1_000, tree: { headSha: "0123abcd", files: {}, commits: [] } },
} as unknown as ThreadState;

describe("committedSinceHead", () => {
  it("gives the turn-start head when the turn's own commits touched paths", () => {
    const turn = { paths: ["a.ts"], commits: ["c1"], committedPaths: ["a.ts"] };
    expect(committedSinceHead(turn, state)).toBe("0123abcd");
  });

  it("gives no committed range when the commits touched no path of their own", () => {
    const turn = { paths: ["a.ts"], commits: ["merge"], committedPaths: [] };
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
