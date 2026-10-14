import { describe, expect, it } from "vitest";
import { siblingAuthoredPaths, turnChangedPaths } from "./detect.js";
import { rowTexts } from "./detect-rows.js";

const STARTED_AT = 10_000;
const LEAK = "leak-token-3d92";

interface Page {
  rows: unknown[];
}

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
const sibling = entry("sib-1");
const kid = entry("kid-1", { parentThreadId: "self" });

const base = {
  kind: "work",
  status: "completed",
  startedAt: 20_000,
  createdAt: 20_000,
  completedAt: 21_000,
};
const command = (text: string, over: Record<string, unknown> = {}) => ({
  ...base,
  workKind: "command",
  approvalStatus: null,
  command: text,
  cwd: "/w",
  ...over,
});
const fileRead = (path: string, over: Record<string, unknown> = {}) => ({
  ...base,
  workKind: "file-read",
  path,
  cmd: null,
  ...over,
});
const search = (query: string, over: Record<string, unknown> = {}) => ({
  ...base,
  workKind: "search",
  mode: "content",
  path: null,
  cmd: null,
  query,
  ...over,
});
const tool = (toolArgs: unknown, over: Record<string, unknown> = {}) => ({
  ...base,
  workKind: "tool",
  approvalStatus: null,
  toolName: "write",
  toolArgs,
  ...over,
});
const edit = (path: string, over: Record<string, unknown> = {}) => ({
  ...base,
  workKind: "file-change",
  approvalStatus: null,
  sourceSeqStart: 10,
  change: { path, movePath: null },
  ...over,
});

/** A timeline served in pages, newest first, the way the server pages it. */
function fakeBb(
  timelines: Record<string, Page[] | Error>,
  environment: { path?: string | null | Error; commit?: { sha: string; paths: string[] } } = {},
) {
  const infos: string[] = [];
  const environmentGets: unknown[] = [];
  const bb = {
    log: { info: (message: string) => infos.push(message), warn: (message: string) => infos.push(message) },
    sdk: {
      environments: {
        get: async (args: unknown) => {
          environmentGets.push(args);
          const path = "path" in environment ? environment.path : "/w";
          if (path instanceof Error) {
            throw path;
          }
          return { path };
        },
        diffFiles: async () => ({
          outcome: "available",
          files: (environment.commit?.paths ?? []).map((path) => ({ path, previousPath: null })),
        }),
      },
      threads: {
        timeline: async ({ threadId, beforeAnchorId }: { threadId: string; beforeAnchorId?: string }) => {
          const pages = timelines[threadId] ?? [{ rows: [] }];
          if (pages instanceof Error) {
            throw pages;
          }
          const at = beforeAnchorId === undefined ? 0 : Number(beforeAnchorId);
          const older = at + 1 < pages.length;
          return {
            rows: pages[at]?.rows ?? [],
            maxSeq: 0,
            timelinePage: {
              hasOlderRows: older,
              olderCursor: older ? { anchorId: String(at + 1), anchorSeq: at + 1 } : null,
            },
          };
        },
      },
    },
  } as never;
  return { bb, infos, environmentGets };
}

const one = (...rows: unknown[]): Page[] => [{ rows }];

describe("siblingAuthoredPaths", () => {
  it("collects the text of the rows that ran and overlapped the turn, with each sibling's completeness", async () => {
    const { bb } = fakeBb({
      "sib-1": one(
        command("echo a > lib/a.ts"),
        command("echo denied > lib/b.ts", { approvalStatus: "denied" }),
        command("echo waiting > lib/b.ts", { approvalStatus: "waiting_for_approval" }),
        command("echo before > lib/c.ts", { startedAt: 1_000, completedAt: 2_000 }),
        search("not shell text", { cmd: "rg x lib" }),
        fileRead("lib/d.ts", { cmd: null }),
        tool({ file_path: "lib/e.ts" }),
        command("echo sub > lib/f.ts", { cwd: "/w/sub" }),
      ),
    });
    const evidence = await siblingAuthoredPaths(bb, [self, sibling] as never, "self", STARTED_AT);
    expect(evidence.texts).toEqual([
      { threadId: "sib-1", text: "echo a > lib/a.ts", cwd: "/w", shell: true },
      { threadId: "sib-1", text: "rg x lib", cwd: null, shell: true },
      { threadId: "sib-1", text: "echo sub > lib/f.ts", cwd: "/w/sub", shell: true },
    ]);
    expect(evidence.complete).toEqual(new Map([["sib-1", true]]));
  });

  it("marks a sibling whose timeline is truncated or unreadable as incomplete", async () => {
    const endless = Array.from({ length: 60 }, () => ({ rows: [command("echo a > lib/a.ts")] }));
    const { bb } = fakeBb({
      "sib-1": endless,
      "sib-2": new Error("gone"),
      "sib-3": one(command("echo a > lib/a.ts")),
    });
    const evidence = await siblingAuthoredPaths(
      bb,
      [self, sibling, entry("sib-2"), entry("sib-3")] as never,
      "self",
      STARTED_AT,
    );
    expect(evidence.complete).toEqual(
      new Map([
        ["sib-1", false],
        ["sib-2", false],
        ["sib-3", true],
      ]),
    );
    expect(evidence.texts.some(({ threadId }) => threadId === "sib-2")).toBe(false);
  });

  it("does not read the family as siblings", async () => {
    const { bb } = fakeBb({ "kid-1": one(command("echo a > lib/a.ts")) });
    const evidence = await siblingAuthoredPaths(bb, [self, kid] as never, "self", STARTED_AT);
    expect(evidence.texts).toEqual([]);
  });
});

describe("turnChangedPaths and a sibling's shell edits", () => {
  const script = (body: string) => `python3 - <<'EOF'\n${body}\nEOF`;
  const incident = [
    command(script("p = 'lib/a.test.ts'\nwith open(p, 'w') as f:\n    f.write('x')")),
    command(`cat > lib/new.ts <<'EOF'\necho ${LEAK} > lib/c.ts\nEOF`),
    command("sed -i '' 's/a/b/' lib/b.ts"),
    command(script("import glob\nfor p in glob.glob('lib/react/*.test.tsx'):\n    open(p, 'w').write('')")),
  ];
  const creditable = ["lib/a.test.ts", "lib/new.ts", "lib/b.ts", "lib/react/a.test.tsx", "lib/react/b.test.tsx"];
  const remaining = ["lib/c.ts", "lib/mine.ts", "package.json"];
  const kidRuns = [command("npm test"), command("npx jest lib/react"), command("git status")];

  async function attribute(options: {
    timelines?: Record<string, Page[] | Error>;
    entries?: unknown[];
    uncommitted?: string[];
    environment?: Parameters<typeof fakeBb>[1];
    turnStart?: Record<string, unknown>;
    commit?: { sha: string; paths: string[] };
  }) {
    const { bb, infos, environmentGets } = fakeBb(
      { self: one(edit("lib/own.ts")), "sib-1": one(...incident), "kid-1": one(...kidRuns), ...options.timelines },
      { ...options.environment, commit: options.commit },
    );
    const files = (options.uncommitted ?? [...creditable, ...remaining]).map((path) => ({
      path,
      status: "M",
      insertions: 1,
      deletions: 0,
    }));
    const result = await turnChangedPaths(bb, {
      threadId: "self",
      environmentId: "env",
      turnStart: { sinceSeq: 5, startedAt: STARTED_AT, tree: { headSha: "h0", files: {}, commits: [] }, ...options.turnStart },
      workspace: {
        workingTree: { files },
        branch: { currentBranch: "b", defaultBranch: "master" },
        checkout: { kind: "branch", headSha: options.commit === undefined ? "h0" : options.commit.sha },
        mergeBase: options.commit === undefined ? null : { files: [], commits: [{ sha: options.commit.sha }] },
      } as never,
      threadEntries: (options.entries ?? [self, kid, sibling]) as never,
    });
    return { result, infos, environmentGets };
  }

  const pathsOf = (result: { paths: string[] }) => [...result.paths].sort();

  it("leaves the paths a sibling's shell writes name to the sibling, whatever the child ran meanwhile", async () => {
    const { result, infos, environmentGets } = await attribute({});
    expect(pathsOf(result)).toEqual(["lib/c.ts", "lib/mine.ts", "lib/own.ts", "package.json"]);
    const lines = infos.filter((line) => line.includes("left to thread sib-1"));
    expect(lines).toHaveLength(1);
    expect(lines[0]?.replace(/^.*during the turn: /u, "").split(", ").sort()).toEqual([...creditable].sort());
    expect(JSON.stringify(infos)).not.toContain(LEAK);
    expect(environmentGets).toEqual([{ environmentId: "env" }]);
  });

  it("keeps a sibling's denied write with this thread", async () => {
    const { result } = await attribute({
      timelines: { "sib-1": one(command("sed -i '' s/a/b/ lib/b.ts", { approvalStatus: "denied" })) },
    });
    expect(pathsOf(result)).toContain("lib/b.ts");
  });

  it("does not ask for the checkout path when no sibling ran anything or no path is left over", async () => {
    const idle = await attribute({ timelines: { "sib-1": one() } });
    expect(idle.environmentGets).toEqual([]);
    const settled = await attribute({ uncommitted: ["lib/own.ts"] });
    expect(settled.environmentGets).toEqual([]);
    expect(pathsOf(settled.result)).toEqual(["lib/own.ts"]);
  });

  describe("when the family names the path", () => {
    const keeps = async (timelines: Record<string, Page[] | Error>, path = "lib/b.ts") => {
      const { result } = await attribute({ timelines });
      return pathsOf(result).includes(path);
    };

    it("(g) in a command of its own", async () => {
      expect(await keeps({ self: one(edit("lib/own.ts"), command("cat lib/b.ts")) })).toBe(true);
      expect(await keeps({ self: one(edit("lib/own.ts"), command("cat b.ts")) })).toBe(true);
      expect(await keeps({ self: one(edit("lib/own.ts"), command("cat /w/lib/b.ts")) })).toBe(true);
      expect(await keeps({ self: one(edit("lib/own.ts"), command("cat other.ts")) })).toBe(false);
    });

    it("(h) by a matching glob", async () => {
      expect(await keeps({ "kid-1": one(command("wc -l lib/*.ts")) })).toBe(true);
    });

    it("(f) by a writing command over its directory, not a test run over it", async () => {
      const timelines = (family: string) => ({ "kid-1": one(command(family)) });
      expect(await keeps(timelines("jest lib/react"), "lib/react/a.test.tsx")).toBe(false);
      expect(await keeps(timelines("eslint --fix lib/react"), "lib/react/a.test.tsx")).toBe(true);
    });

    it("by a kin's tool edit", async () => {
      expect(await keeps({ "kid-1": one(...kidRuns, edit("lib/b.ts")) })).toBe(true);
    });

    it("by a tool's arguments", async () => {
      expect(await keeps({ "kid-1": one(tool({ file_path: "/w/lib/b.ts" })) })).toBe(true);
    });

    it("by a tool's string arguments, whatever their depth, read as text and not as JSON", () => {
      const rows = [tool({ edits: [{ note: "x\nsrc/a.ts", count: 2 }], path: "dir/my file.ts" }, { startedAt: 20_000 })];
      const texts = rowTexts(rows as never, STARTED_AT, { pending: 30_000, unended: 30_000 }, { includeUnapproved: true });
      expect(texts.map(({ text }) => text)).toEqual(["edits", "note", "x\nsrc/a.ts", "count", "path", "dir/my file.ts"]);
      expect(texts.every(({ shell }) => !shell)).toBe(true);
    });

    it("by an object key of a tool's arguments", async () => {
      expect(await keeps({ "kid-1": one(tool({ files: { "lib/b.ts": "x" } })) })).toBe(true);
      expect(await keeps({ "kid-1": one(tool({ files: { "lib/other.ts": "x" } })) })).toBe(false);
      const rows = [tool({ files: { "src/a.ts": "x" }, list: ["y"] }, { startedAt: 20_000 })];
      const texts = rowTexts(rows as never, STARTED_AT, { pending: 30_000, unended: 30_000 }, { includeUnapproved: true });
      expect(texts.map(({ text }) => text)).toEqual(["files", "src/a.ts", "x", "list", "y"]);
    });

    it("by a tool's bare relative path, which names that path and does not run it", async () => {
      expect(await keeps({ "kid-1": one(tool({ path: "lib/b.ts" })) })).toBe(true);
      expect(await keeps({ "kid-1": one(tool({ path: "lib/other.ts" })) })).toBe(false);
      expect(await keeps({ "kid-1": one(tool({ path: "scripts/gen.sh" })) })).toBe(false);
    });

    it("by a tool's command line, which runs as shell", async () => {
      expect(await keeps({ "kid-1": one(tool({ command: "npm install" })) })).toBe(true);
      expect(await keeps({ "kid-1": one(tool({ command: "npm test" })) })).toBe(false);
      expect(await keeps({ "kid-1": one(tool({ note: "install the package" })) })).toBe(false);
    });

    it("by a file-read row's absolute path and a search row's query, as names only", async () => {
      const read = { self: one(edit("lib/own.ts"), fileRead("/w/lib/b.ts", { cmd: null })) };
      expect(await keeps(read)).toBe(true);
      expect(await keeps({ self: one(edit("lib/own.ts"), fileRead("/w/lib/other.ts", { cmd: null })) })).toBe(false);
      expect(await keeps({ self: one(edit("lib/own.ts"), search("lib/**/*.ts", { cmd: null })) })).toBe(true);
      expect(await keeps({ self: one(edit("lib/own.ts"), search("other/**/*.ts", { cmd: null })) })).toBe(false);
    });

    it("by a file-read or search row that carries no approval status", async () => {
      expect(await keeps({ self: one(edit("lib/own.ts"), fileRead("lib/b.ts")) })).toBe(true);
      expect(await keeps({ self: one(edit("lib/own.ts"), search("lib/b.ts")) })).toBe(true);
    });

    it("by a denied command", async () => {
      expect(await keeps({ "kid-1": one(command("cat lib/b.ts", { approvalStatus: "denied" })) })).toBe(true);
    });

    it.each(["git checkout .", "git stash pop", "npm install"])("by `%s`", async (family) => {
      const { result } = await attribute({ timelines: { "kid-1": one(command(family)) } });
      expect(pathsOf(result)).toEqual([...creditable, ...remaining, "lib/own.ts"].sort());
    });

    it("by a text over 65,536 characters", async () => {
      const { result } = await attribute({ timelines: { "kid-1": one(command("x".repeat(65_537))) } });
      expect(pathsOf(result)).toEqual([...creditable, ...remaining, "lib/own.ts"].sort());
    });

    it("by a row still running that began a page before the lookback's first page", async () => {
      const running = command("cat lib/b.ts", { status: "pending", completedAt: null, startedAt: 10_000 - 20 * 60_000, createdAt: 10_000 - 20 * 60_000 });
      const recent = command("true", { startedAt: 10_000 - 5 * 60_000, createdAt: 10_000 - 5 * 60_000, completedAt: 10_000 - 4 * 60_000 });
      const paged = [{ rows: kidRuns }, { rows: [recent] }, { rows: [running] }];
      expect(await keeps({ "kid-1": paged })).toBe(true);
      expect(await keeps({ "kid-1": [{ rows: kidRuns }, { rows: [recent] }] })).toBe(false);
    });
  });

  describe("moves nothing", () => {
    const all = [...creditable, ...remaining, "lib/own.ts"].sort();

    it("(i) when a kin's timeline cannot be read in full", async () => {
      const { result } = await attribute({ timelines: { "kid-1": new Error("gone") } });
      expect(pathsOf(result)).toEqual(all);
    });

    it("(i) when this thread's own timeline is truncated", async () => {
      const endless = Array.from({ length: 60 }, () => ({ rows: [edit("lib/own.ts")] }));
      const { result } = await attribute({ timelines: { self: endless } });
      expect(pathsOf(result)).toEqual(all);
    });

    it("(i) when the sibling's timeline is truncated", async () => {
      const endless = Array.from({ length: 60 }, () => ({ rows: incident }));
      const { result } = await attribute({ timelines: { "sib-1": endless } });
      expect(pathsOf(result)).toEqual(all);
    });

    it.each([
      ["unknown", { path: null }],
      ["empty", { path: "" }],
      ["unavailable", { path: new Error("no environment") }],
    ])("(i) when the checkout path is %s", async (_name, environment) => {
      const { result } = await attribute({ environment });
      expect(pathsOf(result)).toEqual(all);
    });

    it("(j) for a path an own kept commit touched, which stays in the committed paths", async () => {
      const { result } = await attribute({
        uncommitted: ["lib/mine.ts"],
        commit: { sha: "c1", paths: ["lib/b.ts"] },
      });
      expect(pathsOf(result)).toEqual(["lib/b.ts", "lib/mine.ts", "lib/own.ts"]);
      expect(result.committedPaths).toEqual(["lib/b.ts"]);
      expect(result.commits).toEqual(["c1"]);
    });
  });

  it("logs every credited path, in lines of at most 20 paths that each name the sibling", async () => {
    const many = Array.from({ length: 25 }, (_, at) => `lib/f${String(at).padStart(2, "0")}.ts`);
    const { result, infos } = await attribute({
      timelines: { "sib-1": one(command(`echo x | tee ${many.join(" ")}`)) },
      uncommitted: [...many, "lib/mine.ts"],
    });
    expect(pathsOf(result)).toEqual(["lib/mine.ts", "lib/own.ts"]);
    const lines = infos.filter((line) => line.includes("left to"));
    const line = (paths: string[]) => `auto-review: left to thread sib-1, named in its write during the turn: ${paths.join(", ")}`;
    expect(lines).toEqual([line(many.slice(0, 20)), line(many.slice(20))]);
  });
});
