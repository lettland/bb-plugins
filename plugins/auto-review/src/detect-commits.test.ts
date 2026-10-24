import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { describe, expect, it } from "vitest";
import { branchHeadPushed, novelCommits } from "./detect-commits.js";

const REF = "origin/feature/x";

/** What `status` answers for `origin/<branch>`: HEAD at `head`, with the merge base and the commits ahead as given. */
const status = (
  over: Record<string, unknown> = {},
  checkout: Record<string, unknown> = { kind: "branch", branchName: "feature/x", headSha: "head" },
  dirty: string[] = [],
) => ({
  outcome: "available",
  workspace: {
    checkout,
    workingTree: { files: dirty.map((path) => ({ path })) },
    mergeBase: { files: [], mergeBaseBranch: REF, baseRef: "head", aheadCount: 0, commits: [], ...over },
  },
});

async function pushed(answer: () => unknown, expectedHead = "head") {
  const infos: string[] = [];
  const bb = {
    log: { info: (message: string) => infos.push(message) },
    sdk: { environments: { status: async () => answer() } },
  } as unknown as BbPluginApi;
  return { result: await branchHeadPushed(bb, "env", "feature/x", expectedHead), infos };
}

describe("branchHeadPushed", () => {
  it("returns the fresh dirty paths when nothing is ahead of the remote branch and HEAD is its merge base", async () => {
    expect(await pushed(() => status())).toEqual({ result: [], infos: [] });
    expect(await pushed(() => status({}, undefined, ["src/a.ts", "src/b.ts"]))).toEqual({
      result: ["src/a.ts", "src/b.ts"],
      infos: [],
    });
  });

  const doubts: Array<[string, () => unknown, string]> = [
    [
      "commits are still ahead",
      () => status({ aheadCount: 2, commits: [{ sha: "a" }, { sha: "b" }] }),
      "2 commits are still ahead of it",
    ],
    [
      "HEAD is missing from the commits ahead as patch-equivalent while older ones are unpushed",
      () => status({ aheadCount: 1, commits: [{ sha: "older" }] }),
      "1 commit is still ahead of it",
    ],
    ["HEAD is not the merge base", () => status({ baseRef: "base0" }), "HEAD is not an ancestor of it"],
    ["the answer is for another ref", () => status({ mergeBaseBranch: "origin/other" }), "the answer was not for that ref"],
    ["the base ref is null", () => status({ baseRef: null }), "the answer was not for that ref"],
    [
      "the checkout moved to another head",
      () => status({}, { kind: "branch", branchName: "feature/x", headSha: "moved" }),
      "the checkout moved while the remote base was checked",
    ],
    ["the status is unavailable", () => ({ outcome: "unavailable" }), `no ${REF} to compare against`],
    [
      "there is no merge base",
      () => ({ outcome: "available", workspace: { checkout: {}, mergeBase: null } }),
      `no ${REF} to compare against`,
    ],
    [
      "the status call throws",
      () => {
        throw new Error("no ref");
      },
      "the status call failed",
    ],
  ];
  it.each(doubts)("is null when %s", async (_name, answer, reason) => {
    expect(await pushed(answer)).toEqual({
      result: null,
      infos: [`auto-review: not treating HEAD as pushed to ${REF}: ${reason}`],
    });
  });
});

describe("novelCommits against a rebased or replayed range", () => {
  const startedAt = 1_000;
  const beforeCommit = (sha: string) => ({ sha, authorName: "Ada", authoredAt: 5, subject: "the work" });
  const metadata = (sha: string) => ({ sha, authorName: "Ada", authoredAt: 5, subject: "the work" });

  function replayBb(statusAnswer: unknown, patchFails: ReadonlySet<string> = new Set()) {
    const bb = {
      sdk: {
        environments: {
          status: async () => {
            if (statusAnswer instanceof Error) {
              throw statusAnswer;
            }
            return statusAnswer;
          },
          diffFiles: async () => ({ outcome: "available", files: [{ path: "a.ts" }] }),
          diffPatch: async ({ target }: { target: { sha: string } }) => {
            if (patchFails.has(target.sha)) {
              throw new Error("no patch");
            }
            return {
              outcome: "available",
              patches: [{ path: "a.ts", patch: "the same work", truncated: false }],
            };
          },
        },
      },
    } as unknown as BbPluginApi;
    return bb;
  }

  const before = (headSha: string | null, recentCommits: ReturnType<typeof beforeCommit>[]) => ({
    headSha,
    commits: [],
    files: {},
    recentCommits,
  });

  it("claims the turn's commits when the old head's ancestry cannot be read", async () => {
    const bb = replayBb({ outcome: "unavailable" });
    const made = [{ sha: "c1", authoredAt: 5 }];
    expect(await novelCommits(bb, "env", before("oldhead", [beforeCommit("old1")]), made, startedAt)).toEqual(made);
  });

  it("claims the turn's commits when the ancestry read fails", async () => {
    const bb = replayBb(new Error("status down"));
    const made = [{ sha: "c1", authoredAt: 5 }];
    expect(await novelCommits(bb, "env", before("oldhead", [beforeCommit("old1")]), made, startedAt)).toEqual(made);
  });

  it("claims everything when the turn start left no head to compare by", async () => {
    const bb = replayBb({ outcome: "available", workspace: { checkout: {}, mergeBase: null } });
    const made = [{ sha: "c1", authoredAt: 5 }];
    expect(await novelCommits(bb, "env", before(null, [beforeCommit("old1")]), made, undefined)).toEqual(made);
  });

  it("drops a commit the old base already held by identity, and skips an unfingerprinted old one", async () => {
    const bb = replayBb(
      {
        outcome: "available",
        workspace: {
          checkout: { kind: "branch", branchName: "feature/x", headSha: "head" },
          mergeBase: { baseRef: "elsewhere", commits: [metadata("c1")], files: [], aheadCount: 0 },
        },
      },
      new Set(["old2"]),
    );
    const made = [{ sha: "c1", authoredAt: 5 }];
    expect(
      await novelCommits(bb, "env", before("oldhead", [beforeCommit("old1"), beforeCommit("old2")]), made, startedAt),
    ).toEqual([]);
  });

  it("keeps the turn's commits when none replay the old base", async () => {
    const bb = replayBb({
      outcome: "available",
      workspace: {
        checkout: { kind: "branch", branchName: "feature/x", headSha: "head" },
        mergeBase: {
          baseRef: "elsewhere",
          commits: [{ sha: "c1", authorName: "Bob", authoredAt: 6, subject: "other" }],
          files: [],
          aheadCount: 0,
        },
      },
    });
    const made = [{ sha: "c1", authoredAt: 5 }];
    expect(await novelCommits(bb, "env", before("oldhead", [beforeCommit("old1")]), made, startedAt)).toEqual(made);
  });

  it("keeps a replaying commit whose patch could not be read", async () => {
    const bb = replayBb(
      {
        outcome: "available",
        workspace: {
          checkout: { kind: "branch", branchName: "feature/x", headSha: "head" },
          mergeBase: { baseRef: "elsewhere", commits: [metadata("c1")], files: [], aheadCount: 0 },
        },
      },
      new Set(["c1"]),
    );
    const made = [{ sha: "c1", authoredAt: 5 }];
    expect(await novelCommits(bb, "env", before("oldhead", [beforeCommit("old1")]), made, startedAt)).toEqual(made);
  });
});
