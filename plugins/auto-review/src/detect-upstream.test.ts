import { describe, expect, it, vi } from "vitest";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { withoutUpstream, type TreeChanges, type UpstreamInput } from "./detect-upstream.js";

const lookups = vi.hoisted(() => ({
  remoteReachableShas: vi.fn(),
  mayHaveMovedRemoteRef: vi.fn(),
  kinEvidence: vi.fn(),
}));
vi.mock("./detect-commits.js", async (original) => ({
  ...(await original<typeof import("./detect-commits.js")>()),
  remoteReachableShas: lookups.remoteReachableShas,
}));
vi.mock("./detect-timeline.js", async (original) => ({
  ...(await original<typeof import("./detect-timeline.js")>()),
  mayHaveMovedRemoteRef: lookups.mayHaveMovedRemoteRef,
  kinEvidence: lookups.kinEvidence,
}));

function fakeBb() {
  const infos: string[] = [];
  const bb = { log: { info: (message: string) => infos.push(message) } } as unknown as BbPluginApi;
  return { bb, infos };
}

const workspace = {
  checkout: { kind: "branch", branchName: "feature/x", headSha: "head" },
  workingTree: { files: [] },
  mergeBase: { files: [], mergeBaseBranch: "master", baseRef: "head", aheadCount: 0, commits: [] },
  branch: { currentBranch: "feature/x", defaultBranch: "master" },
};

const startedAt = 1_000_000;
const turnStart = { sinceSeq: 5, startedAt };

const context = (bb: BbPluginApi, over: Record<string, unknown> = {}): Omit<UpstreamInput, "startedAt" | "commits"> =>
  ({
    bb,
    input: {
      threadId: "thr",
      environmentId: "env",
      turnStart,
      workspace,
      threadEntries: [],
      ...over,
    },
    ownRows: { rows: [], truncated: false },
    ownPaths: new Set(["src/own.ts"]),
  }) as unknown as Omit<UpstreamInput, "startedAt" | "commits">;

const fetched = (): TreeChanges => ({
  paths: ["src/a.ts"],
  commits: ["abc1234"],
  committedPaths: ["src/a.ts"],
  commitChanges: [{ sha: "abc1234", paths: ["src/a.ts"], authoredAt: startedAt + 1_000 }],
  uncommittedPaths: [],
});

describe("withoutUpstream", () => {
  it("drops a commit the remote base's ref holds that nobody here authored", async () => {
    const { bb, infos } = fakeBb();
    lookups.remoteReachableShas.mockResolvedValueOnce(new Set(["abc1234"]));
    lookups.mayHaveMovedRemoteRef.mockReturnValue(false);
    // Two thread row lists against one id: the sweep reads what it can.
    lookups.kinEvidence.mockResolvedValueOnce({
      complete: true,
      windows: [],
      paths: [],
      threads: [[], []],
      threadIds: ["thr_kin"],
    });
    const { tree, shas, kin } = await withoutUpstream(context(bb), fetched());
    expect(shas).toEqual(["abc1234"]);
    expect(tree.commits).toEqual([]);
    expect(tree.paths).toEqual([]);
    expect(tree.committedPaths).toEqual([]);
    expect(infos.some((message) => message.includes("commit abc1234 came from origin/master"))).toBe(true);
    expect(kin).toBeDefined();
  });

  it("stops checking when a member of the family may have moved a remote ref, naming only those", async () => {
    const { bb, infos } = fakeBb();
    const kinRows = [{ seq: 1 }];
    const quietRows = [{ seq: 2 }];
    lookups.remoteReachableShas.mockResolvedValueOnce(new Set(["abc1234"]));
    // The main thread's and the second kin's rows move no ref; the first kin's do.
    lookups.mayHaveMovedRemoteRef.mockImplementation((rows: unknown) => rows === kinRows);
    lookups.kinEvidence.mockResolvedValueOnce({
      complete: true,
      windows: [],
      paths: [],
      threads: [kinRows, quietRows],
      threadIds: ["thr_kin"],
    });
    const { shas } = await withoutUpstream(context(bb), fetched());
    expect(shas).toEqual([]);
    const skip = infos.find((message) => message.includes("may have pushed or moved a remote-tracking ref"));
    expect(skip).toContain("(thread thr_kin)");
    expect(skip).not.toContain("threads");
  });

  it("keeps the checkout branch's own ref beside the base's, and reads on without it when there is none", async () => {
    const { bb } = fakeBb();
    lookups.remoteReachableShas.mockResolvedValue(new Set(["abc1234"]));
    lookups.mayHaveMovedRemoteRef.mockReturnValue(false);
    lookups.kinEvidence.mockResolvedValue({
      complete: true,
      windows: [],
      paths: [],
      threads: [[]],
      threadIds: ["thr_kin"],
    });
    await withoutUpstream(context(bb), fetched());
    expect(lookups.remoteReachableShas.mock.calls.slice(0, 2).map((call) => call.slice(1))).toEqual([
      ["env", "origin/master", ["abc1234"], "head"],
      ["env", "origin/feature/x", ["abc1234"], "head"],
    ]);
    const bare = { ...workspace, branch: { currentBranch: null, defaultBranch: "master" } };
    lookups.remoteReachableShas.mockClear();
    await withoutUpstream(context(bb, { workspace: bare }), fetched());
    expect(lookups.remoteReachableShas).toHaveBeenCalledTimes(1);
    expect(lookups.remoteReachableShas.mock.calls[0]?.slice(1)).toEqual([
      "env",
      "origin/master",
      ["abc1234"],
      "head",
    ]);
  });
});
