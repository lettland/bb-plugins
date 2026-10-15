import { describe, expect, it } from "vitest";
import { turnChangedPaths } from "./detect.js";

const STARTED_AT = 10_000;
const LEAK = "leak-token-9a14";

type Pages = Array<{ rows: unknown[] }>;

const entry = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  parentThreadId: null,
  lifecycleOwnerThreadId: null,
  deletedAt: null,
  status: "active",
  updatedAt: 50_000,
  ...extra,
});
const self = entry("self", { status: "idle" });
const kid = entry("kid-1", { parentThreadId: "self", status: "idle" });
const sibling = entry("sib-1");

const base = { kind: "work", status: "completed", startedAt: 20_000, createdAt: 20_000, completedAt: 21_000 };
const command = (text: string, over: Record<string, unknown> = {}) => ({
  ...base,
  workKind: "command",
  approvalStatus: null,
  command: text,
  cwd: "/w",
  ...over,
});
const fileRead = (path: string) => ({ ...base, workKind: "file-read", path, cmd: `cat ${path}` });
const edit = (path: string, over: Record<string, unknown> = {}) => ({
  ...base,
  workKind: "file-change",
  approvalStatus: null,
  sourceSeqStart: 10,
  change: { path, movePath: null },
  ...over,
});
const tool = (toolArgs: unknown, over: Record<string, unknown> = {}) => ({
  ...base,
  workKind: "tool",
  approvalStatus: null,
  toolName: "apply",
  toolArgs,
  ...over,
});
const delegation = (childRows: unknown[], over: Record<string, unknown> = {}) => ({
  ...base,
  workKind: "delegation",
  callId: "c1",
  toolName: "Agent",
  childRef: null,
  childRows,
  ...over,
});
/** A command row of a shell that records no directory, as Claude Code's do, started at `startedAt`. */
const at = (text: string, startedAt: number, over: Record<string, unknown> = {}) =>
  command(text, { cwd: "", startedAt, createdAt: startedAt, completedAt: startedAt + 100, ...over });
const one = (...rows: unknown[]): Pages => [{ rows }];

interface Options {
  timelines?: Record<string, Pages | Error | ((call: number) => Pages | Error)>;
  entries?: unknown[];
  uncommitted?: string[];
  root?: string | null | Error;
  commits?: Array<{ sha: string; paths: string[] | null; authoredAt: number | null }>;
  turnStart?: Record<string, unknown>;
}

async function attribute(options: Options = {}) {
  const infos: string[] = [];
  const calls = new Map<string, number>();
  const commits = options.commits ?? [];
  const bb = {
    log: { info: (message: string) => infos.push(message), warn: (message: string) => infos.push(message) },
    sdk: {
      environments: {
        get: async () => {
          const path = "root" in options ? options.root : "/w";
          if (path instanceof Error) {
            throw path;
          }
          return { path };
        },
        diffFiles: async ({ sha }: { sha: string }) => {
          const paths = commits.find((commit) => commit.sha === sha)?.paths;
          if (paths === null || paths === undefined) {
            throw new Error("unreadable");
          }
          return { outcome: "available", files: paths.map((path) => ({ path, previousPath: null })) };
        },
      },
      threads: {
        timeline: async ({ threadId, beforeAnchorId }: { threadId: string; beforeAnchorId?: string }) => {
          const call = calls.get(threadId) ?? 0;
          calls.set(threadId, call + 1);
          const served = options.timelines?.[threadId] ?? [{ rows: [] }];
          const pages = typeof served === "function" ? served(call) : served;
          if (pages instanceof Error) {
            throw pages;
          }
          const at = beforeAnchorId === undefined ? 0 : Number(beforeAnchorId);
          const older = at + 1 < pages.length;
          return {
            rows: pages[at]?.rows ?? [],
            maxSeq: 0,
            timelinePage: { hasOlderRows: older, olderCursor: older ? { anchorId: String(at + 1), anchorSeq: at + 1 } : null },
          };
        },
      },
    },
  } as never;
  const result = await turnChangedPaths(bb, {
    threadId: "self",
    environmentId: "env",
    turnStart: { sinceSeq: 5, startedAt: STARTED_AT, tree: { headSha: "h0", files: {}, commits: [] }, ...options.turnStart },
    workspace: {
      workingTree: { files: (options.uncommitted ?? []).map((path) => ({ path, status: "M", insertions: 1, deletions: 0 })) },
      branch: { currentBranch: "b", defaultBranch: "master" },
      checkout: { kind: "branch", headSha: commits.at(-1)?.sha ?? "h0" },
      mergeBase: commits.length === 0 ? null : { files: [], commits: commits.map(({ sha, authoredAt }) => (authoredAt === null ? { sha } : { sha, authoredAt })) },
    } as never,
    threadEntries: (options.entries ?? [self, kid, sibling]) as never,
  });
  return { result, infos };
}

const claims = (lines: string[]) => lines.filter((line) => line.includes("by sweep") || line.includes("left out of the review: the"));

describe("exact attribution", () => {
  const external = ["lib/ide.ts"];

  it("claims nothing for a reply-only turn, and names what it left", async () => {
    const { result, infos } = await attribute({ uncommitted: external });
    expect(result).toMatchObject({ mode: "exact", paths: [], unclaimed: external, commits: [] });
    expect(infos.filter((line) => line.includes("left out"))).toEqual([
      "auto-review: attributing the turn's changes exactly; 1 change(s) the thread did not make are left out of the review: lib/ide.ts",
    ]);
  });

  it("claims nothing for a read-only turn of cd and rg", async () => {
    const { result } = await attribute({
      uncommitted: external,
      timelines: { self: one(command("cd /w && rg foo lib | head"), fileRead("lib/ide.ts"), command("npm test")) },
    });
    expect(result).toMatchObject({ mode: "exact", paths: [], unclaimed: external });
  });

  it("claims the file an own sed -i names and leaves an external edit", async () => {
    const { result } = await attribute({
      uncommitted: [...external, "lib/mine.ts"],
      timelines: { self: one(command("sed -i '' 's/a/b/' lib/mine.ts")) },
    });
    expect(result).toMatchObject({ mode: "exact", paths: ["lib/mine.ts"], unclaimed: external });
  });

  it("claims both sides of an own mv, and everything under an own rm -r directory", async () => {
    const { result } = await attribute({
      uncommitted: [...external, "lib/old.ts", "lib/new.ts", "src/legacy/a.ts", "src/legacy/deep/b.ts", "src/keep.ts"],
      timelines: { self: one(command("mv lib/old.ts lib/new.ts"), command("rm -r src/legacy")) },
    });
    expect([...result.paths].sort()).toEqual(["lib/new.ts", "lib/old.ts", "src/legacy/a.ts", "src/legacy/deep/b.ts"]);
    expect(result.unclaimed.sort()).toEqual(["lib/ide.ts", "src/keep.ts"]);
  });

  it("claims what only a child's targeted command wrote, and what its file-change row recorded", async () => {
    const { result } = await attribute({
      uncommitted: [...external, "lib/kid.ts", "lib/kid-edit.ts"],
      timelines: { kid: one(command("rm lib/kid.ts"), edit("lib/kid-edit.ts")) },
      entries: [self, entry("kid", { parentThreadId: "self", status: "idle" })],
    });
    expect(result).toMatchObject({ mode: "exact", unclaimed: external });
    expect([...result.paths].sort()).toEqual(["lib/kid-edit.ts", "lib/kid.ts"]);
  });

  it("claims a path a tool row's arguments name", async () => {
    const tool = { ...base, workKind: "tool", approvalStatus: null, toolName: "apply", toolArgs: { path: "lib/mine.ts" } };
    const { result } = await attribute({ uncommitted: [...external, "lib/mine.ts"], timelines: { self: one(tool) } });
    expect(result.paths).toEqual(["lib/mine.ts"]);
  });

  it("always claims the thread's own file-change rows", async () => {
    const { result } = await attribute({ uncommitted: [...external, "lib/own.ts"], timelines: { self: one(edit("lib/own.ts")) } });
    expect(result).toMatchObject({ mode: "exact", paths: ["lib/own.ts"], unclaimed: external });
  });

  it("names at most five examples and never a command", async () => {
    const many = Array.from({ length: 8 }, (_, at) => `lib/f${at}.ts`);
    const { infos } = await attribute({ uncommitted: many, timelines: { self: one(command(`echo ${LEAK}`)) } });
    expect(infos).toEqual([
      "auto-review: attributing the turn's changes exactly; 8 change(s) the thread did not make are left out of the review: lib/f0.ts, lib/f1.ts, lib/f2.ts, lib/f3.ts, lib/f4.ts and 3 more",
    ]);
    expect(JSON.stringify(infos)).not.toContain(LEAK);
  });
});

describe("sweep attribution", () => {
  const external = ["lib/ide.ts", "lib/mine.ts"];

  it("takes every unattributed change when something ran whose writes cannot be listed, naming only the program", async () => {
    const { result, infos } = await attribute({
      uncommitted: external,
      timelines: { self: one(command(`API_KEY=${LEAK} /opt/bin/builder --token ${LEAK}`)) },
    });
    expect(result).toMatchObject({ mode: "sweep", unclaimed: [] });
    expect([...result.paths].sort()).toEqual(external);
    expect(claims(infos)).toEqual(["auto-review: attributing the turn's changes by sweep: builder ran, and the files it writes cannot be listed"]);
    expect(JSON.stringify(infos)).not.toContain(LEAK);
  });

  it("logs the program of an opaque command, never one of its arguments", async () => {
    const { infos } = await attribute({
      uncommitted: external,
      timelines: { self: one(command("diff <(git show HEAD:lib/mine.ts) lib/mine.ts"), command(`./scripts/run.sh lib/mine.ts ${LEAK}`)) },
    });
    expect(claims(infos)).toEqual(["auto-review: attributing the turn's changes by sweep: (process substitution) ran, and the files it writes cannot be listed"]);
    expect(JSON.stringify(infos)).not.toContain("mine.ts");
    const second = await attribute({ uncommitted: external, timelines: { self: one(command(`./scripts/run.sh lib/mine.ts ${LEAK}`)) } });
    expect(claims(second.infos)).toEqual(["auto-review: attributing the turn's changes by sweep: run.sh ran, and the files it writes cannot be listed"]);
  });

  it("sweeps for a tool whose script field or other string runs something opaque, though it names a changed path", async () => {
    for (const args of [{ file: "lib/mine.ts", script: "npm run codegen" }, { file: "lib/mine.ts", note: "npx prisma generate" }, { command: ["bash", "-lc", "npm run codegen"] }]) {
      const { result, infos } = await attribute({ uncommitted: external, timelines: { self: one(tool(args)) } });
      expect(result.mode).toBe("sweep");
      expect(claims(infos)[0]).toMatch(/by sweep: (?:npm|prisma) ran, and the files it writes cannot be listed$/u);
    }
  });

  it("takes a child's opaque run as the turn's too", async () => {
    const { result } = await attribute({ uncommitted: external, timelines: { "kid-1": one(command("npm run build")) } });
    expect(result.mode).toBe("sweep");
    expect([...result.paths].sort()).toEqual(external);
  });

  it("does not sweep for an opaque row that began before the turn and is still open", async () => {
    const stale = command("npm run dev", { status: "pending", completedAt: null, startedAt: 2_000, createdAt: 2_000 });
    const { result, infos } = await attribute({ uncommitted: external, timelines: { self: one(stale) } });
    expect(result).toMatchObject({ mode: "exact", paths: [], unclaimed: external });
    expect(infos).toContain("auto-review: an open command from before the turn claims nothing: npm");
  });

  it.each([
    ["this thread's timeline is truncated", { self: Array.from({ length: 60 }, () => ({ rows: [edit("lib/x.ts")] })) }, /timeline of thread self is truncated/u],
    ["this thread's earlier timeline cannot be read", { self: (call: number) => (call === 0 ? one() : new Error("gone")) }, /thread self: .*could not be read/u],
    ["a child cannot be read in full", { "kid-1": new Error("gone") }, /spawned or owns could not be read/u],
  ])("sweeps, and says why, when %s", async (_name, timelines, reason) => {
    const { result, infos } = await attribute({ uncommitted: external, timelines: timelines as never });
    expect(result.mode).toBe("sweep");
    expect([...result.paths].sort()).toEqual(expect.arrayContaining(external));
    expect(claims(infos)[0]).toMatch(reason);
  });

  it.each([
    ["unknown", null],
    ["unavailable", new Error("no environment")],
  ])("sweeps when the checkout path is %s and a command wrote by name", async (_name, root) => {
    const { result, infos } = await attribute({
      uncommitted: external,
      root,
      timelines: { self: one(command("rm lib/mine.ts")) },
    });
    expect(result.mode).toBe("sweep");
    expect([...result.paths].sort()).toEqual(external);
    expect(claims(infos)[0]).toMatch(/checkout path is unknown/u);
  });

  it("sweeps for a write after a cd that did not return to the checkout root", async () => {
    const { result } = await attribute({ uncommitted: external, timelines: { self: one(command("cd lib && rm mine.ts")) } });
    expect(result.mode).toBe("sweep");
  });

  it("sweeps for a delegation that shows nothing of what its subagent ran, with no git row of the thread's own", async () => {
    const { result, infos } = await attribute({ uncommitted: external, timelines: { self: one(delegation([])) } });
    expect(result.mode).toBe("sweep");
    expect([...result.paths].sort()).toEqual(external);
    expect(claims(infos)).toEqual(["auto-review: attributing the turn's changes by sweep: delegation ran, and the files it writes cannot be listed"]);
  });

  it("claims by what a delegation's nested rows ran when it shows them", async () => {
    const { result } = await attribute({
      uncommitted: external,
      timelines: { self: one(delegation([command("cat lib/ide.ts"), command("sed -i '' 's/a/b/' lib/mine.ts")])) },
    });
    expect(result).toMatchObject({ mode: "exact", paths: ["lib/mine.ts"], unclaimed: ["lib/ide.ts"] });
  });

  it("sweeps when the turn start time is unknown", async () => {
    const { result } = await attribute({ uncommitted: external, turnStart: { startedAt: undefined } });
    expect(result).toMatchObject({ mode: "sweep", unclaimed: [] });
    expect([...result.paths].sort()).toEqual(external);
  });
});

describe("commits", () => {
  const commit = (sha: string, authoredAt: number | null = 20_500, paths: string[] | null = ["lib/c.ts"]) => ({ sha, paths, authoredAt });

  it("keeps the commit that follows an exact-mode sed -i, since the family ran git that writes history", async () => {
    const { result } = await attribute({
      timelines: { self: one(command("sed -i '' 's/a/b/' lib/mine.ts"), command("git commit -qam x", { startedAt: 22_000, completedAt: 23_000 })) },
      commits: [commit("c1", 40_000)],
    });
    expect(result).toMatchObject({ mode: "exact", commits: ["c1"], committedPaths: ["lib/c.ts"], paths: ["lib/c.ts"] });
  });

  it.each(["bash -lc 'git commit -qam x'", "git cherry-pick abc", "git pull --rebase", "git stash pop", "git reset --soft HEAD~1"])(
    "keeps a commit when the family ran `%s`",
    async (text) => {
      const { result } = await attribute({ timelines: { self: one(command(text)) }, commits: [commit("c1", 40_000)] });
      expect(result.commits).toEqual(["c1"]);
    },
  );

  it("keeps a commit a child made", async () => {
    const { result } = await attribute({ timelines: { "kid-1": one(command("git commit -m x")) }, commits: [commit("c1", 40_000)] });
    expect(result.commits).toEqual(["c1"]);
  });

  it("drops a commit made during an inert-only turn, logging its sha and why, never a command", async () => {
    const { result, infos } = await attribute({
      timelines: { self: one(command(`cat lib/c.ts # ${LEAK}`)) },
      commits: [commit("c1", 25_000)],
    });
    expect(result).toMatchObject({ commits: [], committedPaths: [], paths: [] });
    expect(claims(infos)).toEqual([
      "auto-review: commit c1 left out of the review: the family ran no git that writes history, and no command or tool of theirs was running then",
    ]);
    expect(JSON.stringify(infos)).not.toContain(LEAK);
  });

  it("keeps every commit in a sweep, whenever it was authored: an opaque script can make one that keeps an old author date", async () => {
    const { result, infos } = await attribute({
      timelines: { self: one(command("npm run build", { startedAt: 24_000, completedAt: 26_000 })) },
      commits: [commit("c1", 25_000), commit("c2", 12_000, ["lib/other.ts"]), commit("c3", 30_000, ["lib/late.ts"])],
    });
    expect(result).toMatchObject({ mode: "sweep", commits: ["c1", "c2", "c3"] });
    expect([...result.committedPaths].sort()).toEqual(["lib/c.ts", "lib/late.ts", "lib/other.ts"]);
    expect(infos.some((line) => line.includes("left out of the review"))).toBe(false);
  });

  it("drops a commit authored outside every window only in exact mode", async () => {
    const { result, infos } = await attribute({
      timelines: { self: one(command("cat lib/c.ts"), tool({ path: "lib/c.ts" }, { startedAt: 24_000, completedAt: 26_000 })) },
      commits: [commit("c1", 25_000), commit("c2", 30_000, ["lib/other.ts"])],
    });
    expect(result).toMatchObject({ mode: "exact", commits: ["c1"] });
    expect(claims(infos)).toEqual(["auto-review: commit c2 left out of the review: the family ran no git that writes history, and no command or tool of theirs was running then"]);
  });

  it("keeps a commit with no author date or unread paths, and one touching a claimed path", async () => {
    const { result } = await attribute({
      timelines: { self: one(command("cat lib/c.ts"), edit("lib/claimed.ts")) },
      commits: [commit("c1", null), commit("c2", 30_000, null), commit("c3", 31_000, ["lib/claimed.ts"]), commit("c4", 32_000)],
    });
    expect(result.commits).toEqual(["c1", "c2", "c3"]);
  });
});

describe("a thread's shell keeps its directory between rows", () => {
  const external = ["lib/ide.ts", "lib/mine.ts"];

  it("does not drop a write made after a cd in an earlier row: it is a sweep, and the file is kept", async () => {
    const { result, infos } = await attribute({
      uncommitted: ["sub/a.ts", "lib/ide.ts"],
      timelines: { self: one(at("cd sub", 20_000), at("sed -i s/a/b/ a.ts", 21_000)) },
    });
    expect(result.mode).toBe("sweep");
    expect([...result.paths].sort()).toEqual(["lib/ide.ts", "sub/a.ts"]);
    expect(claims(infos)[0]).toMatch(/cd/u);
  });

  it("carries a cd made in an earlier turn", async () => {
    const { result } = await attribute({
      uncommitted: external,
      timelines: { self: one(at("cd lib", 2_000), at("rm mine.ts", 21_000)) },
    });
    expect(result.mode).toBe("sweep");
  });

  it("claims what ends in a relative path when no cwd and no cd says where the shell was, and nothing else", async () => {
    const { result } = await attribute({
      uncommitted: external,
      timelines: { self: one(at("sed -i '' 's/a/b/' mine.ts", 20_000)) },
    });
    expect(result).toMatchObject({ mode: "exact", paths: ["lib/mine.ts"], unclaimed: ["lib/ide.ts"] });
  });

  it("claims by the end of the path when the cwd is absolute and not under the checkout", async () => {
    const { result } = await attribute({
      uncommitted: external,
      timelines: { self: one(at("rm mine.ts", 20_000, { cwd: "/elsewhere/repo/lib" })) },
    });
    expect(result).toMatchObject({ mode: "exact", paths: ["lib/mine.ts"], unclaimed: ["lib/ide.ts"] });
  });

  it("claims a write to a checkout that lies in scratch space, and ignores scratch writes elsewhere", async () => {
    const root = "/private/var/folders/ab/cd/T/repo";
    const { result } = await attribute({
      root,
      uncommitted: external,
      timelines: { self: one(command(`echo x > ${root}/lib/mine.ts && echo y > /tmp/ide.ts`)) },
    });
    expect(result).toMatchObject({ mode: "exact", paths: ["lib/mine.ts"], unclaimed: ["lib/ide.ts"] });
  });
});

describe("a directory moved by a command", () => {
  it("claims the destination's files when the source directory was made by the thread's file-change rows", async () => {
    const { result } = await attribute({
      uncommitted: ["src/feature/a.ts", "src/feature/deep/b.ts", "lib/ide.ts"],
      timelines: { self: one(edit("tmpdir/a.ts"), edit("tmpdir/deep/b.ts"), command("mv tmpdir src/feature")) },
    });
    expect(result).toMatchObject({ mode: "exact", unclaimed: ["lib/ide.ts"] });
    expect([...result.paths].sort()).toEqual(["src/feature/a.ts", "src/feature/deep/b.ts", "tmpdir/a.ts", "tmpdir/deep/b.ts"]);
  });

  it("claims the destination's files when nothing knows the source", async () => {
    const { result } = await attribute({
      uncommitted: ["src/feature/a.ts", "lib/ide.ts"],
      timelines: { self: one(command("mv tmpdir src/feature")) },
    });
    expect(result).toMatchObject({ mode: "exact", paths: ["src/feature/a.ts"], unclaimed: ["lib/ide.ts"] });
  });
});

describe("a path a sibling changed through its own tools", () => {
  const siblingEdit = { "sib-1": one(edit("src/b.ts")) };
  const uncommitted = ["src/b.ts", "lib/ide.ts"];

  it("is not claimed when this thread's tool row only names it", async () => {
    const { result } = await attribute({ uncommitted, timelines: { self: one(tool({ path: "src/b.ts" })), ...siblingEdit } });
    expect(result).toMatchObject({ mode: "exact", paths: [] });
    expect([...result.unclaimed].sort()).toEqual(["lib/ide.ts", "src/b.ts"]);
  });

  it("is claimed when this thread's own targeted command writes it", async () => {
    const { result } = await attribute({ uncommitted, timelines: { self: one(command("sed -i '' 's/a/b/' src/b.ts")), ...siblingEdit } });
    expect(result).toMatchObject({ mode: "exact", paths: ["src/b.ts"], unclaimed: ["lib/ide.ts"] });
  });

  it("is claimed when a child's file-change row names it, or this thread's own", async () => {
    const kidEdits = await attribute({ uncommitted, timelines: { "kid-1": one(edit("src/b.ts")), ...siblingEdit } });
    expect(kidEdits.result).toMatchObject({ mode: "exact", paths: ["src/b.ts"] });
    const ownEdits = await attribute({ uncommitted, timelines: { self: one(edit("src/b.ts")), ...siblingEdit } });
    expect(ownEdits.result).toMatchObject({ mode: "exact", paths: ["src/b.ts"] });
  });

  it("is still claimed when no sibling changed it", async () => {
    const { result } = await attribute({ uncommitted, timelines: { self: one(tool({ path: "src/b.ts" })), "sib-1": one(edit("src/other.ts")) } });
    expect(result.paths).toEqual(["src/b.ts"]);
  });
});
