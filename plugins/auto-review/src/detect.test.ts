import { describe, expect, it } from "vitest";
import {
  AUTHORSHIP_SEGMENT_LIMIT,
  authoredPaths,
  authoredPathsFromRows,
  captureTree,
  computeScope,
  dirtyOrAheadPaths,
  fetchWorkspace,
  fingerprintsMatch,
  isBranchCheckout,
  mainlineBase,
  runningChildIds,
  siblingAuthoredPaths,
  snapshotTree,
  treeChangedPaths,
  turnChangedPaths,
  type AvailableWorkspace,
} from "./detect.js";

type Rows = Parameters<typeof authoredPathsFromRows>[0];

function fileChange(
  path: string,
  movePath: string | null = null,
  sourceSeqStart = 100,
): unknown {
  return {
    id: `row-${path}-${sourceSeqStart}`,
    kind: "work",
    workKind: "file-change",
    turnId: "turn-1",
    sourceSeqStart,
    sourceSeqEnd: sourceSeqStart,
    change: { path, movePath },
  };
}

function rows(items: unknown[]): Rows {
  return items as unknown as Rows;
}

describe("authoredPathsFromRows", () => {
  it("collects file-change paths and their move targets after the cursor", () => {
    const result = authoredPathsFromRows(
      rows([fileChange("src/a.ts"), fileChange("old.ts", "new.ts")]),
      50,
    );
    expect(result.sort()).toEqual(["new.ts", "old.ts", "src/a.ts"]);
  });

  it("excludes rows at or before the turn-start cursor", () => {
    const result = authoredPathsFromRows(
      rows([
        fileChange("before.ts", null, 40),
        fileChange("at.ts", null, 50),
        fileChange("after.ts", null, 60),
      ]),
      50,
    );
    expect(result).toEqual(["after.ts"]);
  });

  it("dedups repeated paths within a turn", () => {
    expect(
      authoredPathsFromRows(
        rows([fileChange("src/a.ts", null, 60), fileChange("src/a.ts", null, 70)]),
        50,
      ),
    ).toEqual(["src/a.ts"]);
  });

  it("ignores non file-change rows", () => {
    expect(
      authoredPathsFromRows(
        rows([
          { id: "r", kind: "work", workKind: "tool", sourceSeqStart: 60 },
          fileChange("x.ts"),
        ]),
        50,
      ),
    ).toEqual(["x.ts"]);
  });

  it("walks nested childRows and children", () => {
    const nested = rows([
      {
        id: "d",
        kind: "work",
        workKind: "delegation",
        sourceSeqStart: 60,
        childRows: [fileChange("child.ts")],
      },
      { id: "t", kind: "turn", sourceSeqStart: 60, children: [fileChange("turn.ts")] },
    ]);
    expect(authoredPathsFromRows(nested, 50).sort()).toEqual([
      "child.ts",
      "turn.ts",
    ]);
  });
});

describe("computeScope", () => {
  it("keeps only authored paths that are currently dirty or ahead", () => {
    expect(
      computeScope(["a.ts", "b.ts", "c.ts"], new Set(["b.ts", "c.ts", "d.ts"])),
    ).toEqual(["b.ts", "c.ts"]);
  });

  it("is empty when nothing authored is still changed", () => {
    expect(computeScope(["a.ts"], new Set(["b.ts"]))).toEqual([]);
  });
});

function workspace(over: Record<string, unknown>): AvailableWorkspace {
  return {
    workingTree: { files: [] },
    branch: { currentBranch: "bb/feature", defaultBranch: "master" },
    checkout: { kind: "branch" },
    mergeBase: null,
    ...over,
  } as unknown as AvailableWorkspace;
}

describe("dirtyOrAheadPaths", () => {
  it("unions working-tree and ahead-commit files", () => {
    const ws = workspace({
      workingTree: { files: [{ path: "w.ts" }] },
      mergeBase: { files: [{ path: "a.ts" }], mergeBaseBranch: "master" },
    });
    expect([...dirtyOrAheadPaths(ws)].sort()).toEqual(["a.ts", "w.ts"]);
  });

  it("handles a null merge base", () => {
    const ws = workspace({ workingTree: { files: [{ path: "w.ts" }] } });
    expect([...dirtyOrAheadPaths(ws)]).toEqual(["w.ts"]);
  });

  it("counts paths committed during the turn, which a mainline never shows ahead", () => {
    const ws = workspace({ workingTree: { files: [{ path: "w.ts" }] } });
    expect([...dirtyOrAheadPaths(ws, ["c.ts"])].sort()).toEqual(["c.ts", "w.ts"]);
  });
});

describe("mainlineBase", () => {
  it("prefers the merge-base branch", () => {
    expect(
      mainlineBase(workspace({ mergeBase: { files: [], mergeBaseBranch: "trunk" } })),
    ).toBe("trunk");
  });

  it("falls back to the default branch", () => {
    expect(mainlineBase(workspace({ mergeBase: null }))).toBe("master");
  });
});

describe("isBranchCheckout", () => {
  it("is true only for a branch checkout", () => {
    expect(isBranchCheckout(workspace({ checkout: { kind: "branch" } }))).toBe(
      true,
    );
    expect(isBranchCheckout(workspace({ checkout: { kind: "detached" } }))).toBe(
      false,
    );
  });
});

describe("authoredPaths", () => {
  function row(path: string, seq: number) {
    return {
      id: `row-${path}`,
      kind: "work",
      workKind: "file-change",
      turnId: "t",
      sourceSeqStart: seq,
      sourceSeqEnd: seq,
      change: { path, movePath: null },
    };
  }

  function fakeBb(pages: Array<{ rows: unknown[]; olderEnd: number | null }>) {
    const calls: Array<Record<string, unknown>> = [];
    const bb = {
      sdk: {
        threads: {
          timeline: async (args: Record<string, unknown>) => {
            const index = calls.length;
            calls.push(args);
            const page = pages[index] ?? { rows: [], olderEnd: null };
            const hasOlder = page.olderEnd !== null;
            return {
              rows: page.rows,
              maxSeq: 999,
              timelinePage: {
                hasOlderRows: hasOlder,
                olderCursor: hasOlder ? { anchorId: `a${index}`, anchorSeq: page.olderEnd } : null,
                olderRowsSourceSeqEnd: page.olderEnd,
              },
            };
          },
        },
      },
    } as never;
    return { bb, calls };
  }

  it("pages back until the page boundary reaches the turn start", async () => {
    const { bb, calls } = fakeBb([
      { rows: [row("late.ts", 300)], olderEnd: 250 },
      { rows: [row("mid.ts", 200)], olderEnd: 90 },
      { rows: [row("before-turn.ts", 50)], olderEnd: 10 },
    ]);
    const paths = await authoredPaths(bb, "thr", 100);
    expect(paths.sort()).toEqual(["late.ts", "mid.ts"]);
    expect(calls).toHaveLength(2);
    expect(calls[1]).toMatchObject({ beforeAnchorId: "a0", beforeAnchorSeq: "250" });
    for (const call of calls) {
      expect(Number(call.segmentLimit)).toBeLessThanOrEqual(AUTHORSHIP_SEGMENT_LIMIT);
    }
  });

  it("stops after one page when there is no older history", async () => {
    const { bb, calls } = fakeBb([{ rows: [row("a.ts", 150)], olderEnd: null }]);
    expect(await authoredPaths(bb, "thr", 100)).toEqual(["a.ts"]);
    expect(calls).toHaveLength(1);
  });
});

describe("fingerprintsMatch", () => {
  it("matches equal stats and hashes", () => {
    expect(fingerprintsMatch("M:1:0|abc", "M:1:0|abc")).toBe(true);
  });

  it("differs on line stats alone", () => {
    expect(fingerprintsMatch("M:1:0|", "M:2:0|")).toBe(false);
  });

  it("differs on content when both sides were hashed", () => {
    expect(fingerprintsMatch("M:1:0|abc", "M:1:0|def")).toBe(false);
  });

  it("falls back to stats when a side could not be hashed", () => {
    expect(fingerprintsMatch("M:1:0|abc", "M:1:0|")).toBe(true);
  });
});

describe("treeChangedPaths and siblingAuthoredPaths", () => {
  function file(path: string, content: string | null, insertions = 1) {
    return { path, status: "M", insertions, deletions: 0, content };
  }

  function workspaceOf(
    files: Array<ReturnType<typeof file>>,
    headSha = "h0",
    commits: string[] = [],
  ): AvailableWorkspace {
    return {
      workingTree: { files },
      checkout: { kind: "branch", branchName: "b", headSha },
      mergeBase: { files: [], commits: commits.map((sha) => ({ sha })) },
    } as unknown as AvailableWorkspace;
  }

  function fakeBb(
    live: () => AvailableWorkspace,
    commitFiles: Record<string, string[]> = {},
    timelines: Record<string, unknown[]> = {},
  ) {
    const timelineCalls: string[] = [];
    const bb = {
      sdk: {
        environments: {
          diffFile: async ({ path }: { path: string }) => {
            const hit = (
              live().workingTree.files as Array<ReturnType<typeof file>>
            ).find((entry) => entry.path === path);
            if (hit?.content === null || hit === undefined) {
              throw new Error("unreadable");
            }
            return { content: hit.content };
          },
          diffFiles: async ({ sha }: { sha: string }) => ({
            outcome: "available",
            files: (commitFiles[sha] ?? []).map((path) => ({
              path,
              previousPath: null,
            })),
          }),
        },
        threads: {
          timeline: async ({ threadId }: { threadId: string }) => {
            timelineCalls.push(threadId);
            return {
              rows: timelines[threadId] ?? [],
              maxSeq: 0,
              timelinePage: { hasOlderRows: false, olderCursor: null },
            };
          },
        },
      },
    } as never;
    return { bb, timelineCalls };
  }

  it("claims new, rewritten and committed paths but not untouched dirty ones", async () => {
    let current = workspaceOf([file("kept.ts", "k"), file("edited.ts", "v1")]);
    const { bb } = fakeBb(() => current, { c1: ["committed.ts"] });
    const before = await snapshotTree(bb, "env", current);
    current = workspaceOf(
      [file("kept.ts", "k"), file("edited.ts", "v2"), file("new.ts", "n")],
      "c1",
      ["c1"],
    );
    const changed = await treeChangedPaths(bb, "env", before, current);
    expect(changed.paths.sort()).toEqual(["committed.ts", "edited.ts", "new.ts"]);
    expect(changed.commits).toEqual(["c1"]);
    expect(changed.committedPaths).toEqual(["committed.ts"]);
  });

  it("leaves untracked harness output out of the snapshot but keeps tracked harness files", async () => {
    const untracked = (path: string) => ({
      path,
      status: "??",
      insertions: null,
      deletions: null,
      content: "x",
    });
    const current = workspaceOf([
      ...Array.from({ length: 300 }, (_, i) =>
        untracked(`.claude/backups/f${i}.bak`),
      ),
      file(".claude/settings.json", "s"),
      untracked("src/new.ts"),
    ] as never);
    const { bb } = fakeBb(() => current);
    const snapshot = await snapshotTree(bb, "env", current);
    expect(Object.keys(snapshot.files).sort()).toEqual([
      ".claude/settings.json",
      "src/new.ts",
    ]);
    expect(snapshot.files["src/new.ts"]).not.toMatch(/\|$/u);
  });

  it("skips a sibling whose timeline can no longer be read", async () => {
    const entries = [
      { id: "self", parentThreadId: null, lifecycleOwnerThreadId: null, deletedAt: null, status: "idle", updatedAt: 3_000 },
      { id: "gone", parentThreadId: null, lifecycleOwnerThreadId: null, deletedAt: null, status: "active", updatedAt: 3_000 },
    ] as never;
    const bb = {
      sdk: {
        threads: {
          timeline: async () => {
            throw new Error("thread not found");
          },
        },
      },
    } as never;
    expect([...(await siblingAuthoredPaths(bb, entries, "self", 1_000))]).toEqual([]);
  });

  it("treats this thread's subagents and owned helpers as its own, not siblings", async () => {
    const startedAt = 1_000;
    const change = (path: string) => ({
      kind: "work",
      workKind: "file-change",
      createdAt: 2_000,
      change: { path, movePath: null },
    });
    const { bb, timelineCalls } = fakeBb(() => workspaceOf([]), {}, {
      sub: [change("sub.ts")],
      advisor: [change("advisor.ts")],
      sib: [change("sib.ts"), { ...change("old.ts"), createdAt: 500 }],
    });
    const entry = (
      id: string,
      extra: Record<string, unknown> = {},
    ): Record<string, unknown> => ({
      id,
      parentThreadId: null,
      lifecycleOwnerThreadId: null,
      deletedAt: null,
      status: "idle",
      updatedAt: 3_000,
      ...extra,
    });
    const entries = [
      entry("self"),
      entry("sub", { parentThreadId: "self" }),
      entry("advisor", { parentThreadId: "elsewhere", lifecycleOwnerThreadId: "self" }),
      entry("sib"),
      entry("quiet", { updatedAt: 500 }),
    ] as never;
    const foreign = await siblingAuthoredPaths(bb, entries, "self", startedAt);
    expect([...foreign]).toEqual(["sib.ts"]);
    expect(timelineCalls).toEqual(["sib"]);
  });
});

describe("workspace capture edge cases", () => {
  interface Env {
    status?: (args?: Record<string, unknown>) => Promise<unknown>;
    diffFile?: (args: { path: string }) => Promise<unknown>;
    diffFiles?: (args: { sha: string }) => Promise<unknown>;
    diffPatch?: (args: { target: { sha: string } }) => Promise<unknown>;
    timeline?: (args: Record<string, unknown>) => Promise<unknown>;
  }

  function fakeBb(env: Env) {
    const warnings: string[] = [];
    const diffFileCalls: string[] = [];
    const diffFilesCalls: string[] = [];
    const timelineCalls: Array<Record<string, unknown>> = [];
    const bb = {
      log: {
        warn: (message: string) => {
          warnings.push(message);
        },
      },
      sdk: {
        environments: {
          status: env.status ?? (async () => ({ outcome: "unavailable" })),
          diffFile: async (args: { path: string }) => {
            diffFileCalls.push(args.path);
            if (env.diffFile === undefined) {
              return { content: `content of ${args.path}` };
            }
            return env.diffFile(args);
          },
          diffFiles: async (args: { sha: string }) => {
            diffFilesCalls.push(args.sha);
            if (env.diffFiles === undefined) {
              return { outcome: "available", files: [] };
            }
            return env.diffFiles(args);
          },
          diffPatch: async (args: { target: { sha: string } }) =>
            env.diffPatch?.(args) ?? { outcome: "unavailable" },
        },
        threads: {
          timeline: async (args: Record<string, unknown>) => {
            timelineCalls.push(args);
            if (env.timeline === undefined) {
              return {
                rows: [],
                maxSeq: 0,
                timelinePage: { hasOlderRows: false, olderCursor: null },
              };
            }
            return env.timeline(args);
          },
        },
      },
    } as never;
    return { bb, warnings, diffFileCalls, diffFilesCalls, timelineCalls };
  }

  function ws(over: Record<string, unknown> = {}): AvailableWorkspace {
    return {
      workingTree: { files: [] },
      branch: { currentBranch: "b", defaultBranch: "master" },
      checkout: { kind: "branch", branchName: "b", headSha: "h0" },
      mergeBase: { files: [], commits: [] },
      ...over,
    } as unknown as AvailableWorkspace;
  }

  function tracked(path: string, status = "M", insertions = 1) {
    return { path, status, insertions, deletions: 0 };
  }

  describe("fetchWorkspace", () => {
    it("returns the workspace only when the status is available", async () => {
      const workspace = ws();
      const available = fakeBb({
        status: async () => ({ outcome: "available", workspace }),
      });
      expect(await fetchWorkspace(available.bb, "env")).toBe(workspace);
      const missing = fakeBb({ status: async () => ({ outcome: "not-found" }) });
      expect(await fetchWorkspace(missing.bb, "env")).toBeNull();
    });
  });

  describe("captureTree", () => {
    it("is undefined when the workspace is unavailable, without warning", async () => {
      const { bb, warnings } = fakeBb({});
      expect(await captureTree(bb, "env")).toBeUndefined();
      expect(warnings).toEqual([]);
    });

    it("snapshots an available workspace", async () => {
      const { bb } = fakeBb({
        status: async () => ({
          outcome: "available",
          workspace: ws({ workingTree: { files: [tracked("a.ts")] } }),
        }),
      });
      const tree = await captureTree(bb, "env");
      expect(tree?.headSha).toBe("h0");
      expect(Object.keys(tree?.files ?? {})).toEqual(["a.ts"]);
    });

    it("never throws: a failing status read is logged and left to the timeline", async () => {
      const failing = fakeBb({
        status: async () => {
          throw new Error("daemon down");
        },
      });
      expect(await captureTree(failing.bb, "env-7")).toBeUndefined();
      expect(failing.warnings).toHaveLength(1);
      expect(failing.warnings[0]).toContain("could not snapshot the working tree of env-7");
      expect(failing.warnings[0]).toContain("daemon down");

      const oddThrow = fakeBb({
        status: async () => {
          throw "plain string";
        },
      });
      expect(await captureTree(oddThrow.bb, "env")).toBeUndefined();
      expect(oddThrow.warnings[0]).toContain("plain string");
    });
  });

  describe("snapshotTree", () => {
    it("does not read a deleted file's content", async () => {
      const { bb, diffFileCalls } = fakeBb({});
      const snapshot = await snapshotTree(
        bb,
        "env",
        ws({ workingTree: { files: [tracked("gone.ts", "D"), tracked("kept.ts")] } }),
      );
      expect(diffFileCalls).toEqual(["kept.ts"]);
      expect(snapshot.files["gone.ts"]).toBe("D:1:0|");
      expect(snapshot.files["kept.ts"]).toMatch(/^M:1:0\|[0-9a-f]{16}$/u);
    });

    it("stores an empty hash for a file whose content cannot be read", async () => {
      const { bb } = fakeBb({
        diffFile: async () => {
          throw new Error("binary too large");
        },
      });
      const snapshot = await snapshotTree(
        bb,
        "env",
        ws({ workingTree: { files: [tracked("big.bin")] } }),
      );
      expect(snapshot.files["big.bin"]).toBe("M:1:0|");
    });

    it("records a detached head, and no head at all for other checkouts", async () => {
      const { bb } = fakeBb({});
      const detached = await snapshotTree(
        bb,
        "env",
        ws({ checkout: { kind: "detached", headSha: "d1" } }),
      );
      expect(detached.headSha).toBe("d1");
      const unborn = await snapshotTree(bb, "env", ws({ checkout: { kind: "unborn" } }));
      expect(unborn.headSha).toBeNull();
    });

    it("records the commits already ahead, and none without a merge base", async () => {
      const { bb } = fakeBb({});
      const ahead = await snapshotTree(
        bb,
        "env",
        ws({ mergeBase: { files: [], commits: [{ sha: "c1" }, { sha: "c2" }] } }),
      );
      expect(ahead.commits).toEqual(["c1", "c2"]);
      const snapshot = await snapshotTree(bb, "env", ws({ mergeBase: null }));
      expect(snapshot.commits).toEqual([]);
    });
  });

  describe("treeChangedPaths", () => {
    it("claims a file whose line stats changed without re-reading its content", async () => {
      const { bb, diffFileCalls } = fakeBb({});
      const before = {
        headSha: "h0",
        files: { "a.ts": "M:1:0|abcdef0123456789" },
        commits: [],
      };
      const changed = await treeChangedPaths(
        bb,
        "env",
        before,
        ws({ workingTree: { files: [tracked("a.ts", "M", 5)] } }),
      );
      expect(changed.paths).toEqual(["a.ts"]);
      expect(diffFileCalls).toEqual([]);
    });

    it("does not re-read a file that was unhashed at turn start and kept its stats", async () => {
      const { bb, diffFileCalls } = fakeBb({});
      const before = { headSha: "h0", files: { "a.ts": "M:1:0|" }, commits: [] };
      const changed = await treeChangedPaths(
        bb,
        "env",
        before,
        ws({ workingTree: { files: [tracked("a.ts")] } }),
      );
      expect(changed.paths).toEqual([]);
      expect(diffFileCalls).toEqual([]);
    });

    it("reports both sides of a rename committed during the turn", async () => {
      const { bb } = fakeBb({
        diffFiles: async () => ({
          outcome: "available",
          files: [{ path: "new.ts", previousPath: "old.ts" }],
        }),
      });
      const before = { headSha: "h0", files: {}, commits: [] };
      const changed = await treeChangedPaths(
        bb,
        "env",
        before,
        ws({
          checkout: { kind: "branch", headSha: "c1" },
          mergeBase: { files: [], commits: [{ sha: "c1" }] },
        }),
      );
      expect(changed.paths.sort()).toEqual(["new.ts", "old.ts"]);
    });

    it("does not attribute unchanged patches replayed by a rebase", async () => {
      const patches: Record<string, string> = {
        old: "diff --git a/src/a.ts b/src/a.ts\nindex aaa..bbb 100644\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -2,1 +2,1 @@\n-old\n+new\n",
        replay: "diff --git a/src/a.ts b/src/a.ts\nindex ccc..ddd 100644\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -9,1 +9,1 @@\n-old\n+new\n",
      };
      const { bb } = fakeBb({
        diffFiles: async () => ({
          outcome: "available",
          truncated: false,
          files: [{ path: "src/a.ts", previousPath: null }],
        }),
        diffPatch: async ({ target }) => ({
          outcome: "available",
          patches: [{ path: "src/a.ts", patch: patches[target.sha], truncated: false }],
        }),
      });
      const changed = await treeChangedPaths(
        bb,
        "env",
        { headSha: "old", files: {}, commits: ["old"] },
        ws({
          checkout: { kind: "branch", headSha: "replay" },
          mergeBase: { files: [], commits: [{ sha: "replay" }] },
        }),
      );
      expect(changed).toEqual({ paths: [], commits: [], committedPaths: [] });
    });

    it("attributes a replay whose patch changed while resolving a conflict", async () => {
      const { bb } = fakeBb({
        diffFiles: async () => ({
          outcome: "available",
          truncated: false,
          files: [{ path: "src/a.ts", previousPath: null }],
        }),
        diffPatch: async ({ target }) => ({
          outcome: "available",
          patches: [{
            path: "src/a.ts",
            patch: target.sha === "old" ? "-before\n+after\n" : "-before\n+different\n",
            truncated: false,
          }],
        }),
      });
      const changed = await treeChangedPaths(
        bb,
        "env",
        { headSha: "old", files: {}, commits: ["old"] },
        ws({
          checkout: { kind: "branch", headSha: "replay" },
          mergeBase: { files: [], commits: [{ sha: "replay" }] },
        }),
      );
      expect(changed).toEqual({
        paths: ["src/a.ts"],
        commits: ["replay"],
        committedPaths: ["src/a.ts"],
      });
    });

    it("does not use a binary diff to prove a replay is unchanged", async () => {
      const { bb } = fakeBb({
        diffFiles: async () => ({
          outcome: "available",
          truncated: false,
          files: [{ path: "asset.bin", previousPath: null, binary: true }],
        }),
      });
      const changed = await treeChangedPaths(
        bb,
        "env",
        { headSha: "old", files: {}, commits: ["old"] },
        ws({
          checkout: { kind: "branch", headSha: "replay" },
          mergeBase: { files: [], commits: [{ sha: "replay" }] },
        }),
      );
      expect(changed.committedPaths).toEqual(["asset.bin"]);
    });

    it("skips a commit it cannot read and still counts the others", async () => {
      const { bb, diffFilesCalls } = fakeBb({
        diffFiles: async ({ sha }) => {
          if (sha === "bad") {
            throw new Error("object missing");
          }
          if (sha === "gone") {
            return { outcome: "not-found" };
          }
          return { outcome: "available", files: [{ path: `${sha}.ts`, previousPath: null }] };
        },
      });
      const before = { headSha: "h0", files: {}, commits: ["old"] };
      const changed = await treeChangedPaths(
        bb,
        "env",
        before,
        ws({
          checkout: { kind: "branch", headSha: "good" },
          mergeBase: {
            files: [],
            commits: [{ sha: "good" }, { sha: "bad" }, { sha: "gone" }, { sha: "old" }],
          },
        }),
      );
      expect(changed.paths).toEqual(["good.ts"]);
      // The old commit is read to compare patch identity, then left unclaimed.
      expect(diffFilesCalls.sort()).toEqual(["bad", "bad", "gone", "gone", "good", "good", "old"]);
    });

    describe("fast forward from the turn-start head", () => {
      const current = ws({
        checkout: { kind: "branch", headSha: "own" },
        mergeBase: {
          files: [],
          commits: [{ sha: "own" }, { sha: "pulled" }, { sha: "unlisted" }],
        },
      });
      // The ancestry lookup carries authoredAt, but has no entry for "unlisted".
      const ancestry = ws({
        mergeBase: {
          baseRef: "h0",
          files: [],
          commits: [
            { sha: "own", authoredAt: 2_000 },
            { sha: "pulled", authoredAt: 500 },
          ],
        },
      });
      const fastForward = () =>
        fakeBb({
          status: async () => ({ outcome: "available", workspace: ancestry }),
          diffFiles: async ({ sha }) => ({
            outcome: "available",
            files: [{ path: `${sha}.ts`, previousPath: null }],
          }),
        }).bb;
      const before = { headSha: "h0", files: {}, commits: ["old"] };

      it("ignores commits authored before the turn began, such as pulled ones", async () => {
        const changed = await treeChangedPaths(fastForward(), "env", before, current, 1_000);
        expect(changed).toEqual({
          paths: ["own.ts", "unlisted.ts"],
          commits: ["own", "unlisted"],
          committedPaths: ["own.ts", "unlisted.ts"],
        });
      });

      it("claims every commit when the turn start time is unknown", async () => {
        const changed = await treeChangedPaths(fastForward(), "env", before, current);
        expect(changed.commits).toEqual(["own", "pulled", "unlisted"]);
        expect(changed.committedPaths).toEqual(["own.ts", "pulled.ts", "unlisted.ts"]);
      });
    });

    it("reads no commits when the head did not move", async () => {
      const { bb, diffFilesCalls } = fakeBb({});
      const before = { headSha: "h0", files: {}, commits: [] };
      await treeChangedPaths(
        bb,
        "env",
        before,
        ws({ mergeBase: { files: [], commits: [{ sha: "c1" }] } }),
      );
      expect(diffFilesCalls).toEqual([]);
    });

    it("reads commits made straight onto the mainline from the turn-start head", async () => {
      const statusCalls: Array<Record<string, unknown>> = [];
      const { bb, diffFilesCalls } = fakeBb({
        status: async (args?: Record<string, unknown>) => {
          statusCalls.push(args ?? {});
          return {
            outcome: "available",
            workspace: ws({ mergeBase: { files: [], commits: [{ sha: "h1" }] } }),
          };
        },
        diffFiles: async ({ sha }) => ({
          outcome: "available",
          files: [{ path: `${sha}.ts`, previousPath: null }],
        }),
      });
      const before = { headSha: "h0", files: {}, commits: [] };
      const changed = await treeChangedPaths(
        bb,
        "env",
        before,
        ws({ checkout: { kind: "branch", headSha: "h1" }, mergeBase: null }),
      );
      expect(statusCalls).toEqual([{ environmentId: "env", mergeBaseBranch: "h0" }]);
      expect(diffFilesCalls).toEqual(["h1"]);
      expect(changed).toEqual({ paths: ["h1.ts"], commits: ["h1"], committedPaths: ["h1.ts"] });
    });

    it("tolerates a moved mainline head whose turn-start head cannot be compared", async () => {
      for (const status of [
        async () => ({ outcome: "unavailable" }),
        async () => {
          throw new Error("unknown revision");
        },
      ]) {
        const { bb, diffFilesCalls } = fakeBb({ status });
        const before = { headSha: "h0", files: {}, commits: [] };
        const changed = await treeChangedPaths(
          bb,
          "env",
          before,
          ws({ checkout: { kind: "branch", headSha: "h1" }, mergeBase: null }),
        );
        expect(changed.paths).toEqual([]);
        expect(diffFilesCalls).toEqual([]);
      }
    });

    it("has no turn-start head to compare from on an unborn branch", async () => {
      const statusCalls: unknown[] = [];
      const { bb } = fakeBb({
        status: async () => {
          statusCalls.push(1);
          return { outcome: "unavailable" };
        },
      });
      const before = { headSha: null, files: {}, commits: [] };
      const changed = await treeChangedPaths(
        bb,
        "env",
        before,
        ws({ checkout: { kind: "branch", headSha: "h1" }, mergeBase: null }),
      );
      expect(changed.commits).toEqual([]);
      expect(statusCalls).toEqual([]);
    });
  });

  describe("siblingAuthoredPaths", () => {
    const startedAt = 1_000;
    const entry = (id: string, extra: Record<string, unknown> = {}) => ({
      id,
      parentThreadId: null,
      lifecycleOwnerThreadId: null,
      deletedAt: null,
      status: "active",
      updatedAt: 3_000,
      ...extra,
    });
    const change = (path: string, createdAt: number, movePath: string | null = null) => ({
      kind: "work",
      workKind: "file-change",
      createdAt,
      change: { path, movePath },
    });

    it("counts both sides of a sibling's move", async () => {
      const { bb } = fakeBb({
        timeline: async () => ({
          rows: [change("from.ts", 2_000, "to.ts")],
          maxSeq: 0,
          timelinePage: { hasOlderRows: false, olderCursor: null },
        }),
      });
      const paths = await siblingAuthoredPaths(
        bb,
        [entry("self"), entry("sib")] as never,
        "self",
        startedAt,
      );
      expect([...paths].sort()).toEqual(["from.ts", "to.ts"]);
    });

    it("pages back only while the oldest row on the page is inside the turn", async () => {
      const pages = [
        { rows: [change("p0.ts", 2_000)], cursor: { anchorId: "a0", anchorSeq: 50 } },
        { rows: [{ kind: "turn" }, change("p1.ts", 1_500)], cursor: { anchorId: "a1", anchorSeq: 40 } },
        { rows: [change("p2.ts", 900), change("p2b.ts", 1_200)], cursor: { anchorId: "a2", anchorSeq: 30 } },
        { rows: [change("never.ts", 1_100)], cursor: null },
      ];
      const { bb, timelineCalls } = fakeBb({
        timeline: async () => {
          const page = pages[timelineCalls.length - 1] ?? pages[3];
          return {
            rows: page?.rows ?? [],
            maxSeq: 0,
            timelinePage: {
              hasOlderRows: page?.cursor !== null,
              olderCursor: page?.cursor ?? null,
            },
          };
        },
      });
      const paths = await siblingAuthoredPaths(
        bb,
        [entry("self"), entry("sib")] as never,
        "self",
        startedAt,
      );
      // Page 2 reaches before the turn, so paging stops there; its in-turn row still counts.
      expect(timelineCalls).toHaveLength(3);
      expect(timelineCalls[1]).toMatchObject({ beforeAnchorId: "a0", beforeAnchorSeq: "50" });
      expect([...paths].sort()).toEqual(["p0.ts", "p1.ts", "p2b.ts"]);
    });

    it("keeps paging through pages that carry no timestamps", async () => {
      const { bb, timelineCalls } = fakeBb({
        timeline: async () => {
          const first = timelineCalls.length === 1;
          return {
            rows: first ? [{ kind: "turn" }] : [change("later.ts", 2_000)],
            maxSeq: 0,
            timelinePage: {
              hasOlderRows: first,
              olderCursor: first ? { anchorId: "a0", anchorSeq: 5 } : null,
            },
          };
        },
      });
      const paths = await siblingAuthoredPaths(
        bb,
        [entry("self"), entry("sib")] as never,
        "self",
        startedAt,
      );
      expect(timelineCalls).toHaveLength(2);
      expect([...paths]).toEqual(["later.ts"]);
    });

    it("never reads a deleted sibling", async () => {
      const { bb, timelineCalls } = fakeBb({});
      await siblingAuthoredPaths(
        bb,
        [entry("self"), entry("dead", { deletedAt: 2_000 })] as never,
        "self",
        startedAt,
      );
      expect(timelineCalls).toEqual([]);
    });
  });

  describe("turnChangedPaths", () => {
    const ownRows = (paths: string[]) => ({
      rows: paths.map((path, i) => ({
        kind: "work",
        workKind: "file-change",
        sourceSeqStart: 10 + i,
        createdAt: 2_000,
        change: { path, movePath: null },
      })),
      maxSeq: 0,
      timelinePage: { hasOlderRows: false, olderCursor: null },
    });

    it("uses the timeline alone when the turn-start tree is missing", async () => {
      const { bb, diffFileCalls } = fakeBb({ timeline: async () => ownRows(["own.ts"]) });
      const paths = await turnChangedPaths(bb, {
        threadId: "self",
        environmentId: "env",
        turnStart: { sinceSeq: 0 },
        workspace: ws({ workingTree: { files: [tracked("shell.ts")] } }),
        threadEntries: [],
      });
      expect(paths).toEqual({ paths: ["own.ts"], commits: [], committedPaths: [] });
      expect(diffFileCalls).toEqual([]);
    });

    it("does not read siblings when the tree shows nothing beyond the thread's own edits", async () => {
      const { bb, timelineCalls } = fakeBb({ timeline: async () => ownRows(["own.ts"]) });
      const paths = await turnChangedPaths(bb, {
        threadId: "self",
        environmentId: "env",
        turnStart: { sinceSeq: 0, startedAt: 1_000, tree: { headSha: "h0", files: {}, commits: [] } },
        workspace: ws({
          workingTree: {
            files: [
              tracked("own.ts"),
              { path: ".codex/log.txt", status: "??", insertions: null, deletions: null },
            ],
          },
        }),
        threadEntries: [
          { id: "sib", parentThreadId: null, lifecycleOwnerThreadId: null, deletedAt: null, status: "active", updatedAt: 3_000 },
        ] as never,
      });
      expect(paths.paths).toEqual(["own.ts"]);
      expect(timelineCalls.map((call) => call.threadId)).toEqual(["self"]);
    });

    it("leaves a sibling's committed path to the sibling but keeps its own", async () => {
      const { bb } = fakeBb({
        timeline: async ({ threadId }) =>
          threadId === "sib"
            ? {
                rows: [
                  {
                    kind: "work",
                    workKind: "file-change",
                    sourceSeqStart: 1,
                    createdAt: 2_000,
                    change: { path: "sib.ts", movePath: null },
                  },
                ],
                maxSeq: 0,
                timelinePage: { hasOlderRows: false, olderCursor: null },
              }
            : ownRows(["own.ts"]),
        diffFiles: async () => ({
          outcome: "available",
          files: ["own.ts", "sib.ts", "shell.ts"].map((path) => ({ path, previousPath: null })),
        }),
      });
      const changes = await turnChangedPaths(bb, {
        threadId: "self",
        environmentId: "env",
        turnStart: { sinceSeq: 0, startedAt: 1_000, tree: { headSha: "h0", files: {}, commits: [] } },
        workspace: ws({
          checkout: { kind: "branch", headSha: "c1" },
          mergeBase: { files: [], commits: [{ sha: "c1" }] },
        }),
        threadEntries: [
          { id: "sib", parentThreadId: null, lifecycleOwnerThreadId: null, deletedAt: null, status: "active", updatedAt: 3_000 },
        ] as never,
      });
      expect(changes).toEqual({
        paths: ["own.ts", "shell.ts"],
        commits: ["c1"],
        committedPaths: ["own.ts", "shell.ts"],
      });
    });

    it("claims unattributed tree changes outright when the turn start time is unknown", async () => {
      const { bb, timelineCalls } = fakeBb({ timeline: async () => ownRows([]) });
      const paths = await turnChangedPaths(bb, {
        threadId: "self",
        environmentId: "env",
        turnStart: { sinceSeq: 0, tree: { headSha: "h0", files: {}, commits: [] } },
        workspace: ws({ workingTree: { files: [tracked("shell.ts")] } }),
        threadEntries: [
          { id: "sib", parentThreadId: null, lifecycleOwnerThreadId: null, deletedAt: null, status: "active", updatedAt: 3_000 },
        ] as never,
      });
      expect(paths.paths).toEqual(["shell.ts"]);
      expect(timelineCalls.map((call) => call.threadId)).toEqual(["self"]);
    });
  });
});

describe("runningChildIds", () => {
  interface ChildEntry {
    id: string;
    parentThreadId: string | null;
    originPluginId?: string | null;
    archivedAt?: number | null;
    deletedAt?: number | null;
    status: string;
  }

  function fakeBb(entries: ChildEntry[]) {
    const listCalls: Array<string | undefined> = [];
    const bb = {
      sdk: {
        threads: {
          list: async (args: { parentThreadId?: string }) => {
            listCalls.push(args.parentThreadId);
            return entries
              .filter((entry) => entry.parentThreadId === args.parentThreadId)
              .map((entry) => ({
                originPluginId: null,
                archivedAt: null,
                deletedAt: null,
                ...entry,
              }));
          },
        },
      },
    } as never;
    return { bb, listCalls };
  }

  it("counts running children transitively, including a running grandchild under an idle child", async () => {
    const entries: ChildEntry[] = [
      { id: "active-child", parentThreadId: "self", status: "active" },
      { id: "pending-child", parentThreadId: "self", status: "pending" },
      { id: "idle-child", parentThreadId: "self", status: "idle" },
      { id: "running-grandchild", parentThreadId: "idle-child", status: "active" },
      { id: "error-child", parentThreadId: "self", status: "error" },
      { id: "archived-child", parentThreadId: "self", status: "active", archivedAt: 1 },
      { id: "deleted-child", parentThreadId: "self", status: "active", deletedAt: 1 },
      { id: "advisor", parentThreadId: "self", status: "active", originPluginId: "advisor" },
    ];
    const { bb } = fakeBb(entries);
    const running = await runningChildIds(bb, "self");
    expect(running.sort()).toEqual(
      ["active-child", "pending-child", "running-grandchild"].sort(),
    );
  });

  it("descends through an archived child to find a running grandchild", async () => {
    const entries: ChildEntry[] = [
      { id: "archived-child", parentThreadId: "self", status: "active", archivedAt: 1 },
      { id: "running-grandchild", parentThreadId: "archived-child", status: "active" },
    ];
    const { bb } = fakeBb(entries);
    expect(await runningChildIds(bb, "self")).toEqual(["running-grandchild"]);
  });

  it("does not loop forever on a cycle in the spawn graph", async () => {
    const entries: ChildEntry[] = [
      { id: "cA", parentThreadId: "self", status: "active" },
      { id: "cB", parentThreadId: "cA", status: "active" },
      // cB's own children "include" self again, simulating a cycle back to the root.
      { id: "self", parentThreadId: "cB", status: "active" },
    ];
    const { bb, listCalls } = fakeBb(entries);
    const running = await runningChildIds(bb, "self");
    expect(running.sort()).toEqual(["cA", "cB"]);
    // Each thread's children are listed exactly once despite the cycle.
    expect(listCalls.filter((id) => id === "self").length).toBe(1);
  });

  it("filters out rows the list fake returns regardless of parentThreadId", async () => {
    const entries: ChildEntry[] = [
      { id: "child-1", parentThreadId: "self", status: "active" },
      { id: "unrelated-active", parentThreadId: null, status: "active" },
      { id: "root-sibling", parentThreadId: "root-parent", status: "active" },
    ];
    const bb = {
      sdk: {
        threads: {
          // Ignores the parentThreadId filter entirely, as a buggy list call might.
          list: async () =>
            entries.map((entry) => ({
              originPluginId: null,
              archivedAt: null,
              deletedAt: null,
              ...entry,
            })),
        },
      },
    } as never;
    expect(await runningChildIds(bb, "self")).toEqual(["child-1"]);
  });
});
