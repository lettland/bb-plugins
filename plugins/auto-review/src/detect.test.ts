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
import { isHistoryWritingGit, mayMoveRemoteRef } from "./detect-shell.js";
import { commitScanHead, committedSinceHead } from "./dispatch.js";
import { buildReviewPrompt, renderScope } from "./prompt.js";
import type { ThreadState } from "./state.js";

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
    expect([...(await siblingAuthoredPaths(bb, entries, "self", 1_000)).paths]).toEqual([]);
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
    expect([...foreign.paths]).toEqual(["sib.ts"]);
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
    const infos: string[] = [];
    const diffFileCalls: string[] = [];
    const diffFilesCalls: string[] = [];
    const timelineCalls: Array<Record<string, unknown>> = [];
    const bb = {
      log: {
        warn: (message: string) => {
          warnings.push(message);
        },
        info: (message: string) => {
          infos.push(message);
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
    return { bb, warnings, infos, diffFileCalls, diffFilesCalls, timelineCalls };
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
      expect(changed).toEqual({
        paths: [],
        commits: [],
        committedPaths: [],
        commitChanges: [],
        uncommittedPaths: [],
      });
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
        commitChanges: [{ sha: "replay", paths: ["src/a.ts"], authoredAt: null }],
        uncommittedPaths: [],
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
          commits: [{ sha: "own", authoredAt: 2_000 }, { sha: "pulled" }, { sha: "unlisted" }],
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
          commitChanges: [
            { sha: "own", paths: ["own.ts"], authoredAt: 2_000 },
            { sha: "unlisted", paths: ["unlisted.ts"], authoredAt: null },
          ],
          uncommittedPaths: [],
        });
      });

      it("claims every commit when the turn start time is unknown", async () => {
        const changed = await treeChangedPaths(fastForward(), "env", before, current);
        expect(changed.commits).toEqual(["own", "pulled", "unlisted"]);
        expect(changed.committedPaths).toEqual(["own.ts", "pulled.ts", "unlisted.ts"]);
      });
    });

    it("drops a commit that touched no path but keeps one whose paths could not be read", async () => {
      const { bb } = fakeBb({
        diffFiles: async ({ sha }) => {
          if (sha === "merge") {
            return { outcome: "available", files: [] };
          }
          if (sha === "unread") {
            throw new Error("transient");
          }
          return { outcome: "available", files: [{ path: `${sha}.ts`, previousPath: null }] };
        },
      });
      const changed = await treeChangedPaths(
        bb,
        "env",
        { headSha: "h0", files: {}, commits: ["old"] },
        ws({
          checkout: { kind: "branch", headSha: "own" },
          mergeBase: {
            files: [],
            commits: [{ sha: "own" }, { sha: "merge" }, { sha: "unread" }],
          },
        }),
      );
      expect(changed.commits).toEqual(["own", "unread"]);
      expect(changed.committedPaths).toEqual(["own.ts"]);
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
      expect(changed).toEqual({
        paths: ["h1.ts"],
        commits: ["h1"],
        committedPaths: ["h1.ts"],
        commitChanges: [{ sha: "h1", paths: ["h1.ts"], authoredAt: null }],
        uncommittedPaths: [],
      });
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
      expect([...paths.paths].sort()).toEqual(["from.ts", "to.ts"]);
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
      expect([...paths.paths].sort()).toEqual(["p0.ts", "p1.ts", "p2b.ts"]);
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
      expect([...paths.paths]).toEqual(["later.ts"]);
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
      expect(paths).toEqual({ paths: ["own.ts"], commits: [], committedPaths: [], foreignCommits: [], upstreamCommits: [], mode: "exact", unclaimed: [] });
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
        foreignCommits: [],
        upstreamCommits: [],
        mode: "exact",
        unclaimed: [],
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
  describe("commits made by a sibling thread's git", () => {
    const startedAt = 10_000;
    const LEAK = "leak-token-7c41";
    const entry = (id: string, extra: Record<string, unknown> = {}) => ({
      id,
      parentThreadId: null,
      lifecycleOwnerThreadId: null,
      deletedAt: null,
      status: "idle",
      updatedAt: 50_000,
      ...extra,
    });
    const self = entry("thr_self");
    const sibling = entry("thr_sibling", { status: "active" });
    const child = entry("thr_child", { parentThreadId: "thr_self" });
    const command = (text: string, over: Record<string, unknown> = {}) => ({
      kind: "work",
      workKind: "command",
      status: "completed",
      approvalStatus: null,
      createdAt: 20_000,
      startedAt: 20_000,
      completedAt: 21_000,
      command: text,
      ...over,
    });
    // A search row carries the shell text in `cmd` and has no approvalStatus.
    const search = (cmd: string | null, over: Record<string, unknown> = {}) => ({
      kind: "work",
      workKind: "search",
      mode: "search",
      status: "completed",
      createdAt: 20_000,
      startedAt: 20_000,
      completedAt: 21_000,
      cmd,
      ...over,
    });
    const edit = (path: string) => ({
      kind: "work",
      workKind: "file-change",
      status: "completed",
      approvalStatus: null,
      sourceSeqStart: 10,
      createdAt: 15_000,
      startedAt: 15_000,
      change: { path, movePath: null },
    });
    // A thread that makes a commit has run git; this one did at the start of the turn, outside every commit's window, so that the cases below, which are about who made a commit, start from a thread that could have.
    const startOfTurnGit = command("git commit -q -m x", { startedAt: 10_000, createdAt: 10_000, completedAt: 10_050 });
    // A tool call that names a path, at the start of the turn: the family claims that path without touching any commit's window.
    const names = (path: string) => ({
      kind: "work",
      workKind: "tool",
      status: "completed",
      approvalStatus: null,
      createdAt: 10_100,
      startedAt: 10_100,
      completedAt: 10_150,
      toolName: "apply",
      toolArgs: { path },
    });
    const commit = (sha: string, paths: string[] | null, authoredAt: number | null = 20_500) => ({
      sha,
      paths,
      authoredAt,
    });
    const gitCommit = `cd /w && git add -- src/a.ts src/b.ts && git commit -q -m "${LEAK}"; git log --oneline | grep ${LEAK}`;
    const page = (rows: unknown[]) => ({
      rows,
      maxSeq: 0,
      timelinePage: { hasOlderRows: false, olderCursor: null },
    });

    /** What `status` answers for `origin/<base>`: the commits still ahead of it, with HEAD where the checkout is. */
    const remoteStatus = (
      ref: string,
      ahead: readonly { sha: string }[],
      over: Record<string, unknown> = {},
      checkout: Record<string, unknown> = { kind: "branch", branchName: "b", headSha: "head" },
    ) => ({
      outcome: "available",
      workspace: ws({
        checkout,
        mergeBase: {
          files: [],
          mergeBaseBranch: ref,
          baseRef: "head",
          aheadCount: ahead.length,
          commits: ahead.map(({ sha }) => ({ sha })),
          ...over,
        },
      }),
    });

    /** What `status` answers for the turn-start head: the commits since it. */
    const turnStartStatus = (commits: ReturnType<typeof commit>[]) => ({
      outcome: "available",
      workspace: ws({
        mergeBase: {
          files: [],
          commits: commits.map(({ sha, authoredAt }) => (authoredAt === null ? { sha } : { sha, authoredAt })),
        },
      }),
    });

    async function attribute(options: {
      timelines?: Record<string, unknown[] | Error>;
      entries?: unknown[];
      commits?: ReturnType<typeof commit>[];
      uncommitted?: string[];
      timeline?: (args: Record<string, unknown>) => Promise<unknown>;
      /** The mainline the checkout's default branch names. */
      base?: string;
      /** Shas the remote base already holds; by default none, so every commit is still ahead of it. */
      upstream?: string[];
      /** The checkout's own branch; the base unless given. */
      branch?: string;
      /** Shas only the remote-tracking ref of `branch` holds, when it is not the base. */
      ownRemote?: string[];
      /** Replaces the answer for every `origin/` ref asked about; it gets the ref and the commits ahead of it. */
      remote?: (ref: string, ahead: readonly { sha: string }[]) => unknown;
      turnStart?: Record<string, unknown>;
      /** Whether the thread's own timeline gets the git row at the start of the turn; on unless false. */
      startOfTurnGit?: boolean;
    }) {
      const commits = options.commits ?? [];
      const remoteCalls: string[] = [];
      const { bb, warnings, infos, timelineCalls } = fakeBb({
        status: async (args) => {
          const ref = args?.mergeBaseBranch;
          if (typeof ref !== "string" || !ref.startsWith("origin/")) {
            return turnStartStatus(commits);
          }
          remoteCalls.push(ref);
          const held = (ref === `origin/${options.branch}` ? options.ownRemote : options.upstream) ?? [];
          const ahead = commits.filter(({ sha }) => !held.includes(sha));
          return options.remote === undefined ? remoteStatus(ref, ahead) : options.remote(ref, ahead);
        },
        diffFiles: async ({ sha }) => {
          const paths = commits.find((candidate) => candidate.sha === sha)?.paths;
          if (paths === null || paths === undefined) {
            throw new Error("unreadable");
          }
          return { outcome: "available", files: paths.map((path) => ({ path, previousPath: null })) };
        },
        timeline:
          options.timeline ??
          (async ({ threadId }) => {
            const rows = options.timelines?.[String(threadId)];
            if (rows instanceof Error) {
              throw rows;
            }
            return page([...(rows ?? []), ...(threadId === "thr_self" && options.startOfTurnGit !== false ? [startOfTurnGit] : [])]);
          }),
      });
      const result = await turnChangedPaths(bb, {
        threadId: "thr_self",
        environmentId: "env",
        turnStart: { sinceSeq: 5, startedAt, tree: { headSha: "h0", files: {}, commits: [] }, ...options.turnStart },
        workspace: ws({
          branch: { currentBranch: options.branch ?? options.base ?? "master", defaultBranch: options.base ?? "master" },
          checkout: { kind: "branch", headSha: "head" },
          mergeBase: null,
          workingTree: { files: (options.uncommitted ?? []).map((path) => tracked(path)) },
        }),
        threadEntries: (options.entries ?? [self, sibling]) as never,
      });
      return { result, warnings, infos: infos.filter((line) => !/attributing the turn|left out of the review/u.test(line)), allInfos: infos, timelineCalls, remoteCalls };
    }

    const siblingRuns = (row: unknown) => ({ thr_sibling: [row] });
    const foreign = (sha: string) => ({ sha, threadId: "thr_sibling" });

    it("leaves two commits to the sibling whose search row ran git, without logging its command", async () => {
      const { result, warnings, infos } = await attribute({
        timelines: siblingRuns(search(gitCommit)),
        commits: [commit("c1", ["src/a.ts"], 20_000), commit("c2", ["src/b.ts"], 20_800)],
      });
      // No path is left, so the evaluation stands down with `no-authorship`.
      expect(result).toEqual({
        paths: [],
        commits: [],
        committedPaths: [],
        foreignCommits: [foreign("c1"), foreign("c2")],
        upstreamCommits: [],
        mode: "exact",
        unclaimed: [],
      });
      expect(infos).toEqual([
        "auto-review: commit c1 was made by thread thr_sibling during the turn; left to that thread",
        "auto-review: commit c2 was made by thread thr_sibling during the turn; left to that thread",
      ]);
      expect(JSON.stringify([result, warnings, infos])).not.toContain(LEAK);
    });

    it("leaves a commit to the sibling whose command row ran git", async () => {
      const { result } = await attribute({
        timelines: siblingRuns(command(gitCommit)),
        commits: [commit("c1", ["src/a.ts"])],
      });
      expect(result.foreignCommits).toEqual([foreign("c1")]);
      expect(result.commits).toEqual([]);
    });

    it("keeps a commit a bb child of this thread made while a sibling's window overlaps", async () => {
      const { result } = await attribute({
        entries: [self, child, sibling],
        timelines: {
          thr_sibling: [command(gitCommit)],
          thr_child: [command("git commit -m x")],
        },
        commits: [commit("c1", ["src/a.ts"])],
      });
      expect(result).toMatchObject({ commits: ["c1"], foreignCommits: [] });
    });

    it("keeps a commit made while one of this thread's own rows ran, whatever it was", async () => {
      const { result } = await attribute({
        timelines: { thr_self: [command("npm version patch")], thr_sibling: [command(gitCommit)] },
        commits: [commit("c1", ["src/a.ts"])],
      });
      expect(result).toMatchObject({ commits: ["c1"], foreignCommits: [] });
    });

    it("keeps an own commit whose truncated author date precedes its own row by up to 999 ms", async () => {
      const { result } = await attribute({
        timelines: {
          thr_self: [command("git commit -m x", { startedAt: 20_000, completedAt: 20_100 })],
          thr_sibling: [command(gitCommit, { startedAt: 18_000, completedAt: 22_000 })],
        },
        commits: [commit("c1", ["src/a.ts"], 19_001)],
      });
      expect(result).toMatchObject({ commits: ["c1"], foreignCommits: [] });
    });

    it("keeps a sibling's sweep of a path this thread edited, and reviews it", async () => {
      const { result } = await attribute({
        timelines: { thr_self: [edit("src/own.ts")], thr_sibling: [command(gitCommit)] },
        commits: [commit("c1", ["src/own.ts", "src/a.ts"])],
      });
      expect(result).toEqual({
        paths: ["src/own.ts", "src/a.ts"],
        commits: ["c1"],
        committedPaths: ["src/own.ts", "src/a.ts"],
        foreignCommits: [],
        upstreamCommits: [],
        mode: "exact",
        unclaimed: [],
      });
    });

    it("keeps a sibling's sweep of a path this thread's child edited", async () => {
      const { result } = await attribute({
        entries: [self, child, sibling],
        timelines: { thr_child: [edit("src/child.ts")], thr_sibling: [command(gitCommit)] },
        commits: [commit("c1", ["src/child.ts"])],
      });
      expect(result).toMatchObject({
        paths: ["src/child.ts"],
        commits: ["c1"],
        committedPaths: ["src/child.ts"],
        foreignCommits: [],
        upstreamCommits: [],
      });
    });

    it("splits own and foreign commits and keeps a path still changed uncommitted", async () => {
      const { result, infos } = await attribute({
        timelines: { thr_self: [edit("src/own.ts"), names("src/b.ts")], thr_sibling: [command(gitCommit)] },
        commits: [commit("mine", ["src/own.ts"], 30_000), commit("theirs", ["src/a.ts", "src/b.ts"])],
        uncommitted: ["src/b.ts"],
      });
      expect(result).toEqual({
        paths: ["src/own.ts", "src/b.ts"],
        commits: ["mine"],
        committedPaths: ["src/own.ts"],
        foreignCommits: [foreign("theirs")],
        upstreamCommits: [],
        mode: "exact",
        unclaimed: [],
      });
      expect(infos).toHaveLength(1);
    });

    it("reports a foreign-only turn with the thread's own uncommitted edits", async () => {
      const { result } = await attribute({
        timelines: { thr_self: [edit("src/own.ts")], thr_sibling: [command(gitCommit)] },
        commits: [commit("theirs", ["src/a.ts"])],
        uncommitted: ["src/own.ts"],
      });
      expect(result).toEqual({
        paths: ["src/own.ts"],
        commits: [],
        committedPaths: [],
        foreignCommits: [foreign("theirs")],
        upstreamCommits: [],
        mode: "exact",
        unclaimed: [],
      });
    });

    it("leaves a commit nothing of the family could have made out of the review, in exact mode, next to the one left to the sibling", async () => {
      const { result, allInfos } = await attribute({
        startOfTurnGit: false,
        timelines: siblingRuns(command(gitCommit)),
        commits: [commit("c1", ["src/a.ts"], 20_500), commit("c2", ["src/b.ts"], 30_000)],
      });
      expect(result).toEqual({
        paths: [],
        commits: [],
        committedPaths: [],
        foreignCommits: [foreign("c1")],
        upstreamCommits: [],
        mode: "exact",
        unclaimed: [],
      });
      expect(allInfos.filter((line) => line.includes("left out of the review"))).toEqual([
        "auto-review: commit c2 left out of the review: the family ran no git that writes history, and no command or tool of theirs was running then",
      ]);
      expect(JSON.stringify(allInfos)).not.toContain(LEAK);
    });

    describe("commits that arrived with the remote base", () => {
      const mergedFile = (sha: string) => (sha === "u1" ? "lib/merged.ts" : "lib/upstream.ts");
      const upstreamCommit = (sha: string, authoredAt: number | null = 20_000) =>
        commit(sha, [mergedFile(sha)], authoredAt);
      const state = {
        turnStart: { sinceSeq: 5, startedAt, tree: { headSha: "0123abcd", files: {}, commits: [] } },
      } as unknown as ThreadState;
      const rowAt = (startedAtMs: number, completedAt: number, text: string) =>
        command(text, { createdAt: startedAtMs, startedAt: startedAtMs, completedAt });
      // An earlier review turn ended at 13 s; the thread sat idle until the user's turn at 30 s.
      const incident = {
        base: "dev",
        timelines: {
          thr_self: [
            rowAt(12_000, 13_000, "git commit -m review"),
            rowAt(30_000, 30_500, "git checkout -b feat/x origin/dev"),
          ],
        },
        commits: [upstreamCommit("u1"), upstreamCommit("u2", 20_100)],
        upstream: ["u1", "u2"],
        uncommitted: ["lib/own.ts"],
      };

      it("leaves out commits merged into the remote base while the thread was idle", async () => {
        const { result, infos, remoteCalls } = await attribute(incident);
        expect(remoteCalls).toEqual(["origin/dev"]);
        expect(result).toEqual({
          paths: ["lib/own.ts"],
          commits: [],
          committedPaths: [],
          foreignCommits: [],
          upstreamCommits: ["u1", "u2"],
          mode: "sweep",
          unclaimed: [],
        });
        expect(infos).toEqual([
          "auto-review: commit u1 came from origin/dev; not this turn's",
          "auto-review: commit u2 came from origin/dev; not this turn's",
        ]);
        expect(committedSinceHead(result, state)).toBeNull();
        expect(commitScanHead(result, state)).toBeNull();
      });

      it("leaves out a commit pulled from the remote-tracking ref of the checkout's own branch", async () => {
        const { result, infos, remoteCalls } = await attribute({
          branch: "develop",
          commits: [upstreamCommit("u1")],
          ownRemote: ["u1"],
        });
        expect(remoteCalls).toEqual(["origin/master", "origin/develop"]);
        expect(result).toMatchObject({ commits: [], committedPaths: [], upstreamCommits: ["u1"] });
        expect(infos).toEqual(["auto-review: commit u1 came from origin/develop; not this turn's"]);
      });

      it("names the mainline when it holds a commit the checkout's own branch does not", async () => {
        const { result, infos } = await attribute({
          branch: "develop",
          commits: [upstreamCommit("u1")],
          upstream: ["u1"],
        });
        expect(result).toMatchObject({ commits: [], upstreamCommits: ["u1"] });
        expect(infos).toEqual(["auto-review: commit u1 came from origin/master; not this turn's"]);
      });

      it("still leaves out what the mainline holds when the checkout's own remote-tracking ref cannot be read", async () => {
        const { result, allInfos } = await attribute({
          branch: "develop",
          commits: [upstreamCommit("u1")],
          upstream: ["u1"],
          remote: (ref, ahead) => (ref === "origin/develop" ? { outcome: "unavailable" } : remoteStatus(ref, ahead)),
        });
        expect(result).toMatchObject({ commits: [], upstreamCommits: ["u1"] });
        expect(allInfos.filter((line) => line.includes("came from"))).toEqual([
          "auto-review: not checking whether the turn's commits came from origin/develop: no origin/develop to compare against",
          "auto-review: commit u1 came from origin/master; not this turn's",
        ]);
      });

      it("keeps a commit the thread authored in an earlier turn that is on the checkout's own remote-tracking ref", async () => {
        const { result, remoteCalls } = await attribute({
          branch: "develop",
          timelines: { thr_self: [rowAt(5_000, 6_000, "git commit -m original")] },
          commits: [upstreamCommit("u1", 5_500)],
          ownRemote: ["u1"],
        });
        expect(remoteCalls).toEqual(["origin/master", "origin/develop"]);
        expect(result).toMatchObject({ commits: ["u1"], upstreamCommits: [] });
      });

      describe("when the family may have moved a remote-tracking ref", () => {
        // u1 is held only by origin/develop, u2 only by origin/master; both were authored before the turn.
        const options = {
          branch: "develop",
          commits: [upstreamCommit("u1", 5_500), upstreamCommit("u2", 5_600)],
          upstream: ["u2"],
          ownRemote: ["u1"],
        };
        const since = new Date(5_500).toISOString();
        const skipLine = (refs: string, who = "thread thr_self") =>
          `auto-review: not checking whether the turn's commits came from ${refs}: the thread's family may have pushed or moved a remote-tracking ref since ${since} (${who})`;
        const ran = (thread: "thr_self" | "thr_child" | "thr_sibling", text: string, over: Record<string, unknown> = {}) => ({
          entries: [self, child, sibling],
          timelines: { [thread]: [command(text, { createdAt: 30_000, startedAt: 30_000, completedAt: 30_500, ...over })] },
        });

        it.each([
          ["the thread pushed", "thr_self", "git push origin develop"],
          ["a child thread pushed", "thr_child", "git push origin develop"],
          ["the thread wrote the remote-tracking ref", "thr_self", "git update-ref refs/remotes/origin/develop HEAD"],
        ] as const)("drops no commit as upstream when %s", async (_what, thread, text) => {
          const { result, infos } = await attribute({ ...options, ...ran(thread, text) });
          expect(result).toMatchObject({ commits: ["u1", "u2"], upstreamCommits: [] });
          expect(infos).toEqual([skipLine("origin/master or origin/develop", `thread ${thread}`)]);
        });

        it("names every thread of the family whose rows tripped the guard", async () => {
          const push = (over: Record<string, unknown> = {}) =>
            command("git push", { createdAt: 30_000, startedAt: 30_000, completedAt: 30_500, ...over });
          const { infos } = await attribute({
            ...options,
            entries: [self, child],
            timelines: { thr_self: [push()], thr_child: [push()] },
          });
          expect(infos).toEqual([skipLine("origin/master or origin/develop", "threads thr_self, thr_child")]);
        });

        it("counts a push of a thread the checkout's thread owns through its lifecycle", async () => {
          const owned = entry("thr_owned", { lifecycleOwnerThreadId: "thr_self" });
          const { result, infos } = await attribute({
            ...options,
            entries: [self, owned],
            timelines: { thr_owned: [command("git push origin develop", { createdAt: 30_000, startedAt: 30_000, completedAt: 30_500 })] },
          });
          expect(result).toMatchObject({ commits: ["u1", "u2"], upstreamCommits: [] });
          expect(infos).toEqual([skipLine("origin/master or origin/develop", "thread thr_owned")]);
        });

        it("counts a search row that carries a push", async () => {
          const { result, infos } = await attribute({
            ...options,
            timelines: { thr_self: [search("git push origin develop", { createdAt: 30_000, startedAt: 30_000, completedAt: 30_500 })] },
          });
          expect(result).toMatchObject({ commits: ["u1", "u2"], upstreamCommits: [] });
          expect(infos).toEqual([skipLine("origin/master or origin/develop")]);
        });

        it("counts a push made after the earliest commit was authored but before the turn started", async () => {
          const { result, infos } = await attribute({
            ...options,
            ...ran("thr_self", "git push origin develop", { createdAt: 7_000, startedAt: 7_000, completedAt: 7_500 }),
          });
          expect(result).toMatchObject({ commits: ["u1", "u2"], upstreamCommits: [] });
          expect(infos).toEqual([skipLine("origin/master or origin/develop")]);
        });

        // A row's window reaches one second either side of it, so a push that ended a second before the earliest commit still counts.
        it.each([
          ["a second before", 4_500, true],
          ["more than a second before", 4_499, false],
        ])("treats a push that ended %s the earliest commit's author date accordingly", async (_when, completedAt, trips) => {
          const { infos } = await attribute({
            ...options,
            ...ran("thr_self", "git push origin develop", { createdAt: 4_000, startedAt: 4_000, completedAt }),
          });
          expect(infos).toEqual(
            trips
              ? [skipLine("origin/master or origin/develop")]
              : [
                  "auto-review: commit u1 came from origin/develop; not this turn's",
                  "auto-review: commit u2 came from origin/master; not this turn's",
                ],
          );
        });

        it.each([".git/refs/remotes/origin/develop", ".git/packed-refs"])(
          "drops no commit as upstream when a tool edited %s",
          async (path) => {
            const { result, infos } = await attribute({ ...options, timelines: { thr_self: [edit(path)] } });
            expect(result).toMatchObject({ commits: ["u1", "u2"], upstreamCommits: [] });
            expect(infos).toEqual([
              "auto-review: not checking whether the turn's commits came from origin/master or origin/develop: the thread's family edited a file that holds remote-tracking refs",
            ]);
          },
        );

        it("keeps a commit only the mainline holds, on a branch checkout, after a push", async () => {
          const { result, infos } = await attribute({
            ...options,
            commits: [upstreamCommit("u2", 5_500)],
            ...ran("thr_self", "git push origin develop"),
          });
          expect(result).toMatchObject({ commits: ["u2"], upstreamCommits: [] });
          expect(infos).toEqual([skipLine("origin/master or origin/develop")]);
        });

        it("keeps a commit on the mainline checkout itself after a push", async () => {
          const { result, infos } = await attribute({
            base: "dev",
            commits: [upstreamCommit("u1", 5_500)],
            upstream: ["u1"],
            ...ran("thr_self", "git push origin dev"),
          });
          expect(result).toMatchObject({ commits: ["u1"], upstreamCommits: [] });
          expect(infos).toEqual([skipLine("origin/dev")]);
        });

        it.each([
          ["git that does not push", ran("thr_self", "git pull origin develop")],
          ["a push that ended before the earliest commit", ran("thr_self", "git push", { createdAt: 1_000, startedAt: 1_000, completedAt: 1_500 })],
          ["a push of a sibling outside the family", ran("thr_sibling", "git push origin develop")],
          ["a push that was denied", ran("thr_self", "git push", { approvalStatus: "denied" })],
          ["a push still waiting for approval", ran("thr_self", "git push", { status: "pending", approvalStatus: "pending" })],
        ])("still drops what the remote holds after %s", async (_what, family) => {
          const { result, infos } = await attribute({ ...options, ...family });
          expect(result).toMatchObject({ commits: [], upstreamCommits: ["u1", "u2"] });
          expect(infos).toEqual([
            "auto-review: commit u1 came from origin/develop; not this turn's",
            "auto-review: commit u2 came from origin/master; not this turn's",
          ]);
        });
      });

      it("leaves a commit nothing of the family could have made out of the review, in exact mode, next to the upstream one", async () => {
        const { result, allInfos } = await attribute({
          startOfTurnGit: false,
          base: "dev",
          commits: [upstreamCommit("u1"), commit("c2", ["lib/stray.ts"], 30_000)],
          upstream: ["u1"],
        });
        expect(result).toMatchObject({ mode: "exact", paths: [], commits: [], upstreamCommits: ["u1"] });
        expect(allInfos.filter((line) => line.includes("left out of the review"))).toEqual([
          "auto-review: commit c2 left out of the review: the family ran no git that writes history, and no command or tool of theirs was running then",
        ]);
      });

      it("keeps a commit authored while one of the thread's rows of any kind ran", async () => {
        const { result } = await attribute({
          timelines: { thr_self: [search(null, { startedAt: 19_500, completedAt: 21_000 })] },
          commits: [upstreamCommit("u1", 20_500)],
          upstream: ["u1"],
        });
        expect(result).toMatchObject({ commits: ["u1"], upstreamCommits: [] });
      });

      it("keeps a commit a child thread pushed to the remote base inside its window", async () => {
        const { result } = await attribute({
          entries: [self, child],
          timelines: { thr_child: [command("git push origin HEAD:master")] },
          commits: [upstreamCommit("u1", 20_500)],
          upstream: ["u1"],
        });
        expect(result).toMatchObject({ commits: ["u1"], upstreamCommits: [] });
      });

      it("still drops a commit that falls outside the child's window too", async () => {
        const { result } = await attribute({
          entries: [self, child],
          // Not a push: after one nothing is dropped as upstream, whatever the commit's date.
          timelines: { thr_child: [command("git commit -m child")] },
          commits: [upstreamCommit("u1", 15_000)],
          upstream: ["u1"],
        });
        expect(result).toMatchObject({ commits: [], upstreamCommits: ["u1"] });
      });

      it("keeps everything when a related thread could not be read in full", async () => {
        const { result, infos } = await attribute({
          entries: [self, child],
          timelines: { thr_child: new Error("gone") },
          commits: [upstreamCommit("u1", 15_000)],
          upstream: ["u1"],
        });
        expect(result).toMatchObject({ commits: ["u1"], upstreamCommits: [] });
        expect(infos).toEqual([
          "auto-review: not checking whether the turn's commits came from origin/master: a related thread could not be read in full",
        ]);
      });

      const doubts: Array<[string, Parameters<typeof attribute>[0], string]> = [
        ["status throws", { remote: () => { throw new Error("no ref"); } }, "the status call failed"],
        ["the merge base is null", { remote: () => ({ outcome: "available", workspace: ws({ mergeBase: null }) }) }, "no origin/master to compare against"],
        ["the answer is for another ref", { remote: (_ref, ahead) => remoteStatus("origin/other", ahead) }, "the answer was not for that ref"],
        ["the ahead list is incomplete", { remote: (ref, ahead) => remoteStatus(ref, ahead, { aheadCount: ahead.length + 1 }) }, "the list of commits ahead is incomplete"],
        ["the ref is unavailable", { remote: () => ({ outcome: "unavailable" }) }, "no origin/master to compare against"],
        ["the base ref is null", { remote: (ref, ahead) => remoteStatus(ref, ahead, { baseRef: null }) }, "the answer was not for that ref"],
        ["the checkout moved to another head", { remote: (ref, ahead) => remoteStatus(ref, ahead, {}, { kind: "branch", branchName: "b", headSha: "moved" }) }, "the checkout moved while the remote base was checked"],
        ["the checkout is no longer a branch", { remote: (ref, ahead) => remoteStatus(ref, ahead, {}, { kind: "unborn" }) }, "the checkout moved while the remote base was checked"],
        [
          "an empty list of commits ahead is not HEAD held by the remote",
          { remote: (ref, ahead) => remoteStatus(ref, ahead, { baseRef: "base0" }) },
          "an empty list of commits ahead may be a squash merge, not HEAD held by the remote",
        ],
        [
          "the thread's timeline is truncated",
          {
            timeline: async () => ({
              rows: [],
              maxSeq: 0,
              timelinePage: {
                hasOlderRows: true,
                olderCursor: { anchorId: "a", anchorSeq: 9 },
                olderRowsSourceSeqEnd: 9,
              },
            }),
          },
          "the thread's timeline is truncated",
        ],
      ];
      it.each(doubts)("keeps everything when %s", async (_name, options, reason) => {
        const { result, infos } = await attribute({
          ...options,
          commits: [upstreamCommit("u1")],
          upstream: ["u1"],
        });
        expect(result).toMatchObject({ commits: ["u1"], upstreamCommits: [] });
        expect(infos).toEqual([
          `auto-review: not checking whether the turn's commits came from origin/master: ${reason}`,
        ]);
      });

      it("keeps a commit the thread authored in an earlier turn and then rewrote and pushed", async () => {
        const earlier = { thr_self: [rowAt(5_000, 6_000, "git commit -m original")] };
        const amended = await attribute({
          timelines: earlier,
          commits: [upstreamCommit("u1", 5_500)],
          upstream: ["u1"],
        });
        expect(amended.remoteCalls).toEqual(["origin/master"]);
        expect(amended.result).toMatchObject({ commits: ["u1"], upstreamCommits: [] });
        // The same row does not cover a commit authored later, which was merged by someone else.
        const merged = await attribute({
          timelines: earlier,
          commits: [upstreamCommit("u1", 8_000)],
          upstream: ["u1"],
        });
        expect(merged.result).toMatchObject({ commits: [], upstreamCommits: ["u1"] });
      });

      it("keeps everything when the thread's timeline cannot be read back to the earliest commit", async () => {
        const { result, infos } = await attribute({
          timeline: async () => ({
            rows: [command("ls", { createdAt: 9_000, startedAt: 9_000, completedAt: 9_200 })],
            maxSeq: 0,
            timelinePage: {
              hasOlderRows: true,
              olderCursor: { anchorId: "a", anchorSeq: 9 },
              olderRowsSourceSeqEnd: 3,
            },
          }),
          commits: [upstreamCommit("u1", 5_500)],
          upstream: ["u1"],
        });
        expect(result).toMatchObject({ commits: ["u1"], upstreamCommits: [] });
        expect(infos).toEqual([
          "auto-review: not checking whether the turn's commits came from origin/master: the thread's timeline back to the earliest commit is truncated",
        ]);
      });

      it("keeps a commit touching a file the thread or its child edited through its tools", async () => {
        const own = await attribute({
          timelines: { thr_self: [edit("lib/merged.ts")] },
          commits: [upstreamCommit("u1")],
          upstream: ["u1"],
        });
        expect(own.result).toMatchObject({ commits: ["u1"], upstreamCommits: [] });
        const kin = await attribute({
          entries: [self, child],
          timelines: { thr_child: [edit("lib/merged.ts")] },
          commits: [upstreamCommit("u1")],
          upstream: ["u1"],
        });
        expect(kin.result).toMatchObject({ commits: ["u1"], upstreamCommits: [] });
        const elsewhere = await attribute({
          timelines: { thr_self: [edit("lib/other.ts")] },
          commits: [upstreamCommit("u1")],
          upstream: ["u1"],
        });
        expect(elsewhere.result).toMatchObject({ commits: [], upstreamCommits: ["u1"] });
      });

      it("keeps a commit touching a file the thread edited through its tools in an earlier turn", async () => {
        const earlierEdit = (path: string) => ({ ...edit(path), sourceSeqStart: 2 });
        const own = await attribute({
          timelines: { thr_self: [earlierEdit("lib/merged.ts")] },
          commits: [upstreamCommit("u1", 5_500)],
          upstream: ["u1"],
        });
        expect(own.result).toMatchObject({ commits: ["u1"], upstreamCommits: [] });
        const elsewhere = await attribute({
          timelines: { thr_self: [earlierEdit("lib/other.ts")] },
          commits: [upstreamCommit("u1", 5_500)],
          upstream: ["u1"],
        });
        expect(elsewhere.result).toMatchObject({ commits: [], upstreamCommits: ["u1"] });
      });

      it("keeps a teammate's commit authored inside an earlier, unrelated row of the thread", async () => {
        // The deliberate conservative choice: an author date alone cannot tell it from a rewrite of the thread's own commit.
        const { result } = await attribute({
          timelines: { thr_self: [search(null, { createdAt: 5_000, startedAt: 5_000, completedAt: 6_000 })] },
          commits: [upstreamCommit("u1", 5_500)],
          upstream: ["u1"],
        });
        expect(result).toMatchObject({ commits: ["u1"], upstreamCommits: [] });
      });

      it("keeps a path in scope that an upstream commit and a kept own commit both touched", async () => {
        const { result } = await attribute({
          timelines: { thr_self: [rowAt(30_000, 31_000, "git commit -m own")] },
          commits: [commit("u1", ["lib/shared.ts"], 20_000), commit("c1", ["lib/shared.ts"], 30_500)],
          upstream: ["u1"],
        });
        expect(result).toEqual({
          paths: ["lib/shared.ts"],
          commits: ["c1"],
          committedPaths: ["lib/shared.ts"],
          foreignCommits: [],
          upstreamCommits: ["u1"],
          mode: "exact",
          unclaimed: [],
        });
      });

      it("keeps a commit whose paths could not be read", async () => {
        const { result } = await attribute({
          commits: [commit("u1", null, 20_000)],
          upstream: ["u1"],
        });
        expect(result).toMatchObject({ commits: ["u1"], upstreamCommits: [] });
      });

      it("does not ask the remote when every commit lies inside one of the thread's windows", async () => {
        const { result, remoteCalls } = await attribute({
          timelines: { thr_self: [search(null, { startedAt: 19_500, completedAt: 21_000 })] },
          commits: [upstreamCommit("u1", 20_500)],
          upstream: ["u1"],
        });
        expect(remoteCalls).toEqual([]);
        expect(result).toMatchObject({ commits: ["u1"], upstreamCommits: [] });
      });

      it("reads a child thread once for the upstream and the foreign check together", async () => {
        const { result, remoteCalls, timelineCalls } = await attribute({
          entries: [self, sibling, child],
          timelines: {
            thr_sibling: [command(gitCommit)],
            thr_child: [command("ls", { createdAt: 12_000, startedAt: 12_000, completedAt: 12_500 })],
          },
          commits: [upstreamCommit("u1", 15_000), commit("theirs", ["src/b.ts"], 20_500)],
          upstream: ["u1"],
        });
        expect(remoteCalls).toEqual(["origin/master"]);
        expect(result).toMatchObject({ commits: [], foreignCommits: [foreign("theirs")], upstreamCommits: ["u1"] });
        expect(timelineCalls.filter(({ threadId }) => threadId === "thr_child")).toHaveLength(1);
      });

      it("reads the foreign check's evidence from the turn start when the upstream check read an earlier one", async () => {
        // The child went idle at 7 s with a stale pending row: read from 5.5 s it spans the sibling's commit, read from the turn start it is not read at all.
        const { result } = await attribute({
          entries: [self, sibling, { ...child, updatedAt: 7_000 }],
          timelines: {
            thr_sibling: [command(gitCommit)],
            thr_child: [command("ls", { createdAt: 8_000, startedAt: 8_000, status: "pending", completedAt: null })],
          },
          commits: [upstreamCommit("u1", 5_500), commit("theirs", ["src/b.ts"], 20_500)],
          upstream: ["u1"],
        });
        expect(result).toMatchObject({ commits: [], foreignCommits: [foreign("theirs")], upstreamCommits: ["u1"] });
      });

      it("keeps a commit whose author date is unknown", async () => {
        const { result } = await attribute({
          commits: [upstreamCommit("u1", null)],
          upstream: ["u1"],
        });
        expect(result).toMatchObject({ commits: ["u1"], upstreamCommits: [] });
      });

      it("keeps a commit made straight onto the mainline that is not pushed", async () => {
        const { result, infos } = await attribute({
          commits: [commit("c1", ["src/a.ts"], 20_000)],
        });
        expect(result).toMatchObject({ commits: ["c1"], upstreamCommits: [] });
        expect(infos).toEqual([]);
      });

      it("reports a commit authored during a sibling's git window as upstream, not foreign", async () => {
        const { result } = await attribute({
          timelines: siblingRuns(command(gitCommit)),
          commits: [upstreamCommit("u1", 20_500)],
          upstream: ["u1"],
        });
        expect(result).toEqual({
          paths: [],
          commits: [],
          committedPaths: [],
          foreignCommits: [],
          upstreamCommits: ["u1"],
          mode: "exact",
          unclaimed: [],
        });
      });

      it("keeps the thread's own commit next to upstream ones and words the prompt for both", async () => {
        const { result } = await attribute({
          timelines: { thr_self: [rowAt(30_000, 31_000, "git commit -m own")] },
          commits: [upstreamCommit("deadbee"), commit("c0ffee1", ["src/own.ts"], 30_500)],
          upstream: ["deadbee"],
        });
        expect(result).toMatchObject({ commits: ["c0ffee1"], upstreamCommits: ["deadbee"], foreignCommits: [] });
        const text = buildReviewPrompt({
          decision: { commit: true, merge: true },
          reviewMode: "auto",
          scope: renderScope(result.paths),
          committedSince: committedSinceHead(result, state),
          commitScanFrom: commitScanHead(result, state),
          upstreamCommits: result.upstreamCommits,
          ownCommits: result.commits,
        });
        expect(text).toContain("merged from the remote base, not made by this thread: deadbee.");
        expect(text).toContain("This thread's own commit is c0ffee1");
        expect(text).toContain("A secret found only in one of the other commits is not yours");
        expect(text).toContain("skip the merge in step 8");
      });

      it("takes a base that already names the remote ref as it is", async () => {
        const { result, remoteCalls } = await attribute({
          base: "origin/dev",
          commits: [upstreamCommit("u1")],
          upstream: ["u1"],
        });
        expect(remoteCalls).toEqual(["origin/dev"]);
        expect(result.upstreamCommits).toEqual(["u1"]);
      });

      it("does not ask the remote without a turn start time or without commits", async () => {
        const unknownStart = await attribute({
          turnStart: { startedAt: undefined },
          commits: [upstreamCommit("u1")],
          upstream: ["u1"],
        });
        expect(unknownStart.remoteCalls).toEqual([]);
        expect(unknownStart.result.commits).toEqual(["u1"]);
        const noCommits = await attribute({ uncommitted: ["lib/own.ts"] });
        expect(noCommits.remoteCalls).toEqual([]);
      });

      it("keeps a path in scope through the thread's own edit when an upstream commit touched it too", async () => {
        const { result } = await attribute({
          timelines: { thr_self: [names("lib/shared.ts")] },
          commits: [commit("u1", ["lib/shared.ts"], 20_000)],
          upstream: ["u1"],
          uncommitted: ["lib/shared.ts"],
        });
        expect(result).toEqual({
          paths: ["lib/shared.ts"],
          commits: [],
          committedPaths: [],
          foreignCommits: [],
          upstreamCommits: ["u1"],
          mode: "exact",
          unclaimed: [],
        });
      });
    });

    describe("window edges", () => {
      const siblingRow = (over: Record<string, unknown>) =>
        siblingRuns(command(gitCommit, { startedAt: 20_000, completedAt: 21_000, ...over }));

      it("lets git's whole-second truncation reach 999 ms before the row, and not 1001", async () => {
        const { result } = await attribute({
          timelines: siblingRow({}),
          commits: [commit("inside", ["src/a.ts"], 19_001), commit("outside", ["src/b.ts"], 18_999)],
        });
        expect(result.foreignCommits).toEqual([foreign("inside")]);
        expect(result.commits).toEqual(["outside"]);
      });

      it("counts a pending row of a running sibling up to now", async () => {
        const { result } = await attribute({
          timelines: siblingRow({ status: "pending", completedAt: null }),
          commits: [commit("c1", ["src/a.ts"], 25_000)],
        });
        expect(result.foreignCommits).toEqual([foreign("c1")]);
      });

      it("skips an interrupted row that has no end", async () => {
        const { result } = await attribute({
          timelines: siblingRow({ status: "interrupted", completedAt: null }),
          commits: [commit("c1", ["src/a.ts"], 25_000)],
        });
        expect(result).toMatchObject({ commits: ["c1"], foreignCommits: [] });
      });

      it("skips a pending row left on a sibling that is idle", async () => {
        const { result } = await attribute({
          entries: [self, entry("thr_sibling", { updatedAt: 50_000 })],
          timelines: siblingRow({ status: "pending", completedAt: null }),
          commits: [commit("c1", ["src/a.ts"], 25_000)],
        });
        expect(result).toMatchObject({ commits: ["c1"], foreignCommits: [] });
      });

      it.each(["denied", "waiting_for_approval"])("skips a command row that was %s", async (approvalStatus) => {
        const { result } = await attribute({
          timelines: siblingRow({ approvalStatus }),
          commits: [commit("c1", ["src/a.ts"])],
        });
        expect(result).toMatchObject({ commits: ["c1"], foreignCommits: [] });
      });

      it("counts a sibling row created before the turn that is still running", async () => {
        const { result } = await attribute({
          timelines: siblingRow({ createdAt: 5_000, startedAt: 5_000, status: "pending", completedAt: null }),
          commits: [commit("c1", ["src/a.ts"], 25_000)],
        });
        expect(result.foreignCommits).toEqual([foreign("c1")]);
      });
    });

    describe("nested and open rows", () => {
      const delegation = (childRows: unknown[], over: Record<string, unknown> = {}) => ({
        kind: "work",
        workKind: "delegation",
        status: "completed",
        approvalStatus: null,
        createdAt: 5_000,
        startedAt: 5_000,
        completedAt: 6_000,
        childRows,
        ...over,
      });
      const siblingGit = command(gitCommit);

      it("keeps a commit covered only by the child row of this thread's own delegation", async () => {
        const { result } = await attribute({
          timelines: { thr_self: [delegation([command("git commit -m x")])], thr_sibling: [siblingGit] },
          commits: [commit("c1", ["src/a.ts"])],
        });
        expect(result).toMatchObject({ commits: ["c1"], foreignCommits: [] });
      });

      it("keeps a commit covered only by the span of this thread's own delegation", async () => {
        const { result } = await attribute({
          timelines: {
            thr_self: [delegation([], { startedAt: 19_500, completedAt: 21_500 })],
            thr_sibling: [siblingGit],
          },
          commits: [commit("c1", ["src/a.ts"])],
        });
        expect(result).toMatchObject({ commits: ["c1"], foreignCommits: [] });
      });

      it("keeps a commit while an own row of any kind finished without recording an end", async () => {
        const { result } = await attribute({
          timelines: {
            thr_self: [command("npm test", { startedAt: 5_000, completedAt: null })],
            thr_sibling: [siblingGit],
          },
          commits: [commit("c1", ["src/a.ts"])],
        });
        expect(result).toMatchObject({ commits: ["c1"], foreignCommits: [] });
      });

      it("keeps a commit while a child's row finished without recording an end", async () => {
        const { result } = await attribute({
          entries: [self, child, sibling],
          timelines: {
            thr_child: [command("npm test", { startedAt: 5_000, completedAt: null })],
            thr_sibling: [siblingGit],
          },
          commits: [commit("c1", ["src/a.ts"])],
        });
        expect(result).toMatchObject({ commits: ["c1"], foreignCommits: [] });
      });

      it("still leaves a commit to a sibling whose git command is nested under its delegation", async () => {
        const { result } = await attribute({
          timelines: { thr_sibling: [delegation([siblingGit])] },
          commits: [commit("c1", ["src/a.ts"])],
        });
        expect(result.foreignCommits).toEqual([foreign("c1")]);
      });

      it("reads a sibling's file-read row for git, but not one with no command", async () => {
        const fileRead = (cmd: string | null) => ({ ...search(cmd), workKind: "file-read" });
        const git = await attribute({
          timelines: siblingRuns(fileRead(gitCommit)),
          commits: [commit("c1", ["src/a.ts"])],
        });
        expect(git.result.foreignCommits).toEqual([foreign("c1")]);
        const none = await attribute({
          timelines: siblingRuns(search(null)),
          commits: [commit("c1", ["src/a.ts"])],
        });
        expect(none.result).toMatchObject({ commits: ["c1"], foreignCommits: [] });
      });
    });

    describe("fails safe", () => {
      const siblingGit = siblingRuns(command(gitCommit));

      it("keeps a foreign candidate whose paths could not be read", async () => {
        const { result } = await attribute({ timelines: siblingGit, commits: [commit("c1", null)] });
        expect(result).toMatchObject({ commits: ["c1"], foreignCommits: [] });
      });

      it("keeps a commit with no author date", async () => {
        const { result } = await attribute({
          timelines: siblingGit,
          commits: [commit("c1", ["src/a.ts"], null)],
        });
        expect(result).toMatchObject({ commits: ["c1"], foreignCommits: [] });
      });

      it("keeps every commit when paging this thread's timeline hits the page cap", async () => {
        const { result, timelineCalls } = await attribute({
          commits: [commit("c1", ["src/a.ts"])],
          timeline: async ({ threadId }) =>
            threadId === "thr_self"
              ? {
                  rows: [],
                  maxSeq: 0,
                  timelinePage: {
                    hasOlderRows: true,
                    olderCursor: { anchorId: "a", anchorSeq: 50 },
                    olderRowsSourceSeqEnd: 100,
                  },
                }
              : page([command(gitCommit)]),
        });
        expect(result).toMatchObject({ commits: ["c1"], foreignCommits: [] });
        expect(timelineCalls.filter((call) => call.threadId === "thr_self")).toHaveLength(50);
      });

      it("keeps every commit when a deleted child's timeline cannot be read", async () => {
        const { result } = await attribute({
          entries: [self, entry("thr_child", { parentThreadId: "thr_self", deletedAt: 30_000 }), sibling],
          timelines: { ...siblingGit, thr_child: new Error("thread not found") },
          commits: [commit("c1", ["src/a.ts"])],
        });
        expect(result).toMatchObject({ commits: ["c1"], foreignCommits: [] });
      });

      it("reads no other timeline of this family when no commit lies in a sibling window", async () => {
        const { timelineCalls } = await attribute({
          entries: [self, child, sibling],
          timelines: siblingGit,
          commits: [commit("c1", ["src/a.ts"], 40_000)],
        });
        // The foreign check reads the sibling alone; this thread and its child are read only afterwards, for the commit rule.
        expect(timelineCalls.map((call) => call.threadId)).toEqual(["thr_self", "thr_sibling", "thr_self", "thr_child"]);
      });

      it("treats a sibling that cannot be read as having made no commit", async () => {
        const { result } = await attribute({
          timelines: { thr_sibling: new Error("thread not found") },
          commits: [commit("c1", ["src/a.ts"])],
        });
        expect(result).toMatchObject({ commits: ["c1"], foreignCommits: [] });
      });
    });
  });
});

describe("isHistoryWritingGit", () => {
  it.each([
    "git commit -m x",
    "git commit",
    "git merge topic",
    "git revert HEAD",
    "git pull --ff-only",
    "git -C x commit -m y",
    "git -c user.name=a commit -m y",
    "git --no-pager -P commit",
    "git --git-dir=.git --work-tree=. commit",
    "GIT_AUTHOR_NAME=a FOO=b git commit -m x",
    "cd /w && git add -- a b && git commit -q -m x; git log | grep x",
    "git status || git commit -m x",
    "git diff | cat\ngit commit -m x",
    "git add a \\\n  && git commit -m x",
    "git status  \n  git commit -m x",
    "git commit\\\n  -m x",
    `${"x".repeat(8_000)} ; git commit`,
  ])("detects %j", (text) => {
    expect(isHistoryWritingGit(text)).toBe(true);
  });

  it.each([
    "git merge-base main HEAD",
    "git log --grep=merge",
    "git diff -- src/merge.ts",
    "ls .git/rebase-merge",
    'echo "git pull"',
    'echo "done; git commit"',
    "echo 'a && git commit'",
    'echo "unterminated; git commit',
    "echo a\\; git commit",
    "pnpm commit-lint",
    "git rebase main",
    "git cherry-pick abc",
    "git commit-tree HEAD^{tree}",
    "grep -r 'git commit' docs",
    `${"x".repeat(8_192)} && git commit`,
    "",
  ])("ignores %j", (text) => {
    expect(isHistoryWritingGit(text)).toBe(false);
  });
});

describe("mayMoveRemoteRef", () => {
  it.each([
    "git push",
    "git push origin develop",
    "git -C repo push",
    "GIT_SSH_COMMAND=x git push",
    "cd x && git push",
    "sh -c 'git push'",
    "env git push",
    "/usr/bin/git push origin HEAD",
    "git --git-dir .git push",
    "git stash push",
    "echo push",
    "git update-ref refs/remotes/origin/develop HEAD",
    "git update-ref -d refs/heads/x",
    "git branch -f x refs/remotes/origin/develop",
    "git fetch . HEAD:refs/remotes/origin/develop",
    "git fetch --force . a:b",
    "gh repo sync",
    "gh repo sync owner/repo",
    'git fetch "." a:b',
    "git fetch ./ a:b",
    'git fetch "$PWD" a:b',
    "git fetch $(pwd) a:b",
    "git fetch . ",
    "git fetch '.' HEAD",
    "git fetch origin develop:refs/remotes/origin/develop",
    "git branch -f x remotes/origin/develop",
    "git send-pack ../other HEAD",
    "git remote set-url origin .",
    "git config remote.origin.url .",
    "git -c url.x.insteadOf=y fetch",
    "git config --global url.x.insteadOf y",
    "rm .git/packed-refs",
  ])("matches %j", (text) => {
    expect(mayMoveRemoteRef(text)).toBe(true);
  });

  it.each([
    "git pull origin develop",
    "git fetch origin",
    "git fetch",
    "git status",
    "git log --oneline",
    "git commit -m x",
    "pushd /tmp",
    "gh repo view",
    "npm run pushy",
    "git fetch --all --prune",
    'rg "\\.push\\("',
    "git remote -v",
    "",
  ])("ignores %j", (text) => {
    expect(mayMoveRemoteRef(text)).toBe(false);
  });

  it("answers for a long line without separators in linear time", () => {
    const started = Date.now();
    expect(mayMoveRemoteRef(`fetch ${"a ".repeat(100_000)}`)).toBe(false);
    expect(mayMoveRemoteRef(`${"remote.".repeat(30_000)} fetch`)).toBe(false);
    expect(mayMoveRemoteRef(`fetch ${"a ".repeat(100_000)}b:c`)).toBe(true);
    expect(Date.now() - started).toBeLessThan(2_000);
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
