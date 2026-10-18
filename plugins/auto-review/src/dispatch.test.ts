import { describe, expect, it } from "vitest";
import { commitScanHead, committedSinceHead, devkitRunning } from "./dispatch.js";
import { buildReviewPrompt, renderScope } from "./prompt.js";
import type { ThreadState } from "./state.js";

const state = {
  turnStart: { sinceSeq: 0, startedAt: 1_000, tree: { headSha: "0123abcd", files: {}, commits: [] } },
} as unknown as ThreadState;

describe("committedSinceHead", () => {
  it("gives the turn-start head when the turn made commits", () => {
    const turn = { paths: ["a.ts"], commits: ["c1"], committedPaths: ["a.ts"], foreignCommits: [], upstreamCommits: [], parkedCommits: [], parkedPaths: [] };
    expect(committedSinceHead(turn, state)).toBe("0123abcd");
  });

  it("still gives the head for a commit whose paths could not be read", () => {
    const turn = { paths: [], commits: ["unread"], committedPaths: [], foreignCommits: [], upstreamCommits: [], parkedCommits: [], parkedPaths: [] };
    expect(committedSinceHead(turn, state)).toBe("0123abcd");
  });

  it("gives no committed range when the turn made no commits", () => {
    const turn = { paths: ["a.ts"], commits: [], committedPaths: [], foreignCommits: [], upstreamCommits: [], parkedCommits: [], parkedPaths: [] };
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
    parkedCommits: [],
    parkedPaths: [],
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
    const moved = { paths: ["a.ts"], commits: [], committedPaths: [], foreignCommits: [], upstreamCommits: [], parkedCommits: [], parkedPaths: [] };
    expect(commitScanHead(moved, state)).toBeNull();
  });

  it("scans nothing for a turn whose only commits arrived with the remote base", () => {
    const pulled = { paths: ["a.ts"], commits: [], committedPaths: [], foreignCommits: [], upstreamCommits: ["abcdef1"], parkedCommits: [], parkedPaths: [] };
    expect(committedSinceHead(pulled, state)).toBeNull();
    expect(commitScanHead(pulled, state)).toBeNull();
  });
});

describe("a turn whose only commits arrived while it waited in the review queue", () => {
  const turn = {
    paths: ["a.ts"],
    commits: [],
    committedPaths: [],
    foreignCommits: [],
    upstreamCommits: [],
    parkedCommits: ["abcdef1"],
    parkedPaths: ["lib/new.ts"],
  };
  const prompt = (merge: boolean) =>
    buildReviewPrompt({
      decision: { commit: true, merge },
      reviewMode: "auto",
      scope: renderScope(["a.ts"]),
      committedSince: committedSinceHead(turn, state),
      commitScanFrom: commitScanHead(turn, state),
      parkedCommits: turn.parkedCommits,
    });

  it("scans from the turn-start head but has no committed range of its own", () => {
    expect(committedSinceHead(turn, state)).toBeNull();
    expect(commitScanHead(turn, state)).toBe("0123abcd");
  });

  it("names them neutrally, reports a secret in them without a STOP, and leaves their files out", () => {
    const text = prompt(true);
    expect(text).toContain("This commit arrived while this turn waited in the review queue: abcdef1.");
    expect(text).toContain("Someone else made it");
    expect(text).toContain("Scan the other commits in that range too (`git diff 0123abcd..HEAD`); a secret found there is not yours: report it by file:line and type, never by value, and do not rewrite history. Do not STOP for it: still commit your own work and skip the merge in step 8, saying so in your reply.");
    expect(text).not.toContain("is already committed, so STOP");
    expect(text).toContain("Leave out the files of the commits that arrived while this turn waited named above");
    expect(text).not.toContain("Do not amend");
  });

  it("scans the other commits as well as the turn's own when it made some", () => {
    const mixed = { ...turn, commits: ["c1"], committedPaths: ["a.ts"] };
    const text = buildReviewPrompt({
      decision: { commit: true, merge: false },
      reviewMode: "auto",
      scope: renderScope(["a.ts"]),
      committedSince: committedSinceHead(mixed, state),
      commitScanFrom: commitScanHead(mixed, state),
      parkedCommits: mixed.parkedCommits,
    });
    expect(text).toContain("yours and the other commits in that range (`git diff 0123abcd..HEAD`); a secret found in one of your commits is already committed, so STOP");
    expect(text).toContain("It may appear in the range after 0123abcd; it is still not this thread's.");
  });

  it("leaves a value that is not shaped like a commit out of the prompt", () => {
    const text = buildReviewPrompt({
      decision: { commit: true, merge: false },
      reviewMode: "auto",
      scope: renderScope(["a.ts"]),
      commitScanFrom: "0123abcd",
      parkedCommits: ["not a sha; rm -rf"],
    });
    expect(text).not.toContain("rm -rf");
    expect(text).not.toContain("waited in the review queue");
  });
});

describe("devkitRunning", () => {
  type Entry = { enabled: boolean; status: string; cliCommand: { name: string } | null };
  function pluginsBb(plugins: Entry[] | "throws") {
    const warnings: string[] = [];
    const bb = {
      log: { warn: (message: string) => warnings.push(message) },
      sdk: {
        plugins: {
          list: async () => {
            if (plugins === "throws") {
              throw new Error("plugin list unavailable");
            }
            return { plugins };
          },
        },
      },
    };
    return { bb: bb as never, warnings };
  }
  const devkit: Entry = { enabled: true, status: "running", cliCommand: { name: "devkit" } };

  it("is running for an enabled, running plugin that serves `bb devkit`", async () => {
    expect(await devkitRunning(pluginsBb([devkit]).bb)).toBe("running");
  });

  it("is absent when no such plugin is enabled and running", async () => {
    expect(await devkitRunning(pluginsBb([]).bb)).toBe("absent");
    expect(await devkitRunning(pluginsBb([{ ...devkit, enabled: false }]).bb)).toBe("absent");
    expect(await devkitRunning(pluginsBb([{ ...devkit, status: "stopped" }]).bb)).toBe("absent");
    expect(await devkitRunning(pluginsBb([{ ...devkit, cliCommand: null }]).bb)).toBe("absent");
    expect(await devkitRunning(pluginsBb([{ ...devkit, cliCommand: { name: "aislop" } }]).bb)).toBe("absent");
  });

  it("is unknown, with a warning, when the lookup fails", async () => {
    const { bb, warnings } = pluginsBb("throws");
    expect(await devkitRunning(bb)).toBe("unknown");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("could not list plugins");
  });
});
