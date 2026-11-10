import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";

import { localContentHash, pathsLeftToSiblingCommands } from "./detect-change-time.js";
import type { ChangeTimeFs, ChangeTimeInput } from "./detect-change-time.js";

/**
 * A sweep claims every changed path no sibling's tool rows or command text
 * name. A path that changed only while an opaque command of a reviewable
 * sibling ran, with nothing of this thread's family that can write running
 * then, is left to that sibling. Reported in thr_8rryqyy9me.
 */

const LEAK = "leak-token-52e0";
const ROOT = "/w";
const STARTED_AT = 10_000;
const NOW = 100_000;

const base = { kind: "work", status: "completed", approvalStatus: null, cwd: "", threadId: "t" };
const command = (text: string, startedAt: number, completedAt: number | undefined, over: Record<string, unknown> = {}) => ({
  ...base,
  workKind: "command",
  command: text,
  startedAt,
  createdAt: startedAt,
  ...(completedAt === undefined ? {} : { completedAt }),
  ...over,
});

const entry = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  parentThreadId: null,
  lifecycleOwnerThreadId: null,
  originPluginId: null,
  archivedAt: null,
  deletedAt: null,
  visibility: "visible",
  environmentId: "env",
  providerId: "claude-code",
  status: "active",
  updatedAt: 50_000,
  ...extra,
});

interface Disk {
  [path: string]: { ctimeMs: number; content?: string; bytes?: Uint8Array; link?: boolean; dir?: string[] };
}

/** A file system whose files carry the given times, so a window decides. */
function fakeFs(disk: Disk, over: Partial<ChangeTimeFs> = {}): ChangeTimeFs {
  const at = (path: string) => {
    const found = disk[path];
    if (found === undefined) {
      throw Object.assign(new Error(`${LEAK} ${path}`), { code: "ENOENT" });
    }
    return found;
  };
  return {
    lstat: async (path) => {
      const found = at(path);
      return {
        ctimeMs: found.ctimeMs,
        isSymbolicLink: () => found.link === true,
        isDirectory: () => found.dir !== undefined,
        isFile: () => found.link !== true && found.dir === undefined,
      };
    },
    realpath: async (path) => path,
    readFile: async (path) => {
      const found = at(path);
      return found.bytes ?? Buffer.from(found.content ?? "", "utf8");
    },
    readdir: async (path) => at(path).dir ?? [],
    ...over,
  };
}

interface Setup {
  disk?: Disk;
  /** What `diffFile` serves, by path; a missing path throws. */
  current?: Record<string, string>;
  siblingRows?: unknown[];
  siblingEntry?: Record<string, unknown>;
  entries?: unknown[];
  events?: Record<string, unknown[]>;
  familyRows?: unknown[];
  kinRows?: unknown[][];
  candidates?: string[];
  files?: Array<Record<string, unknown>>;
  input?: Partial<ChangeTimeInput>;
  fs?: Partial<ChangeTimeFs>;
  root?: string | null | Error;
  complete?: boolean;
  ownTimeline?: Error;
}

/** A sibling's `node gen.js` ran from 20 s to 21 s, so the window is 19 s to 22 s. */
const SIBLING_ROW = command("node gen.js", 20_000, 21_000, { threadId: "sib" });

async function run(setup: Setup = {}) {
  const infos: string[] = [];
  const diffed: string[] = [];
  const candidates = setup.candidates ?? ["generated.md"];
  const current = setup.current ?? Object.fromEntries(candidates.map((path) => [path, "generated\n"]));
  const disk: Disk = setup.disk ?? Object.fromEntries(candidates.map((path) => [`${ROOT}/${path}`, { ctimeMs: 20_500, content: "generated\n" }]));
  const sibling = entry("sib", setup.siblingEntry);
  const bb = {
    log: { info: (message: string) => infos.push(message) },
    sdk: {
      environments: {
        get: async () => {
          if (setup.root instanceof Error) {
            throw setup.root;
          }
          return { path: "root" in setup ? setup.root : ROOT };
        },
        diffFile: async ({ path }: { path: string }) => {
          diffed.push(path);
          const content = current[path];
          if (content === undefined) {
            throw new Error(LEAK);
          }
          return { content };
        },
      },
      threads: {
        events: { list: async ({ threadId }: { threadId: string }) => setup.events?.[threadId] ?? [] },
        timeline: async () => {
          if (setup.ownTimeline !== undefined) {
            throw setup.ownTimeline;
          }
          return {
            rows: setup.familyRows ?? [],
            maxSeq: 0,
            timelinePage: { historySnapshot: "default", olderCursor: null, returnedSegmentCount: 1 },
          };
        },
      },
    },
  } as never;
  const rows = new Map([["sib", (setup.siblingRows ?? [SIBLING_ROW]) as never]]);
  const input: ChangeTimeInput = {
    bb,
    threadId: "self",
    environmentId: "env",
    threadEntries: (setup.entries ?? [entry("self", { status: "idle" }), sibling]) as never,
    startedAt: STARTED_AT,
    now: NOW,
    ownRowsTruncated: false,
    kin: { paths: new Set(), windows: [], texts: [], threads: (setup.kinRows ?? []) as never, threadIds: [], complete: setup.complete ?? true },
    sibling: { paths: new Set(), commitWindows: [], texts: [], complete: new Map([["sib", true]]), rows },
    files: (setup.files ?? candidates.map((path) => ({ path, status: "??", insertions: null, deletions: null }))) as never,
    candidates,
    fs: fakeFs(disk, setup.fs),
    ...setup.input,
  };
  const left = await pathsLeftToSiblingCommands(input);
  return { left, infos, diffed };
}

describe("a path that changed only while a sibling's opaque command ran", () => {
  it("is left out when no command of the family that can write was running then", async () => {
    const { left, diffed } = await run();
    expect(left).toEqual(["generated.md"]);
    expect(diffed).toEqual(["generated.md"]);
  });

  it("is kept when a command of the family that can write ran then", async () => {
    expect((await run({ familyRows: [command("node build.js", 20_000, 21_000)] })).left).toEqual([]);
  });

  it("is kept when a family tool row that is not read-only ran then, or a targeted write", async () => {
    const tool = { ...base, workKind: "tool", toolName: "apply", toolArgs: { path: "x" }, startedAt: 20_000, createdAt: 20_000, completedAt: 21_000 };
    expect((await run({ familyRows: [tool] })).left).toEqual([]);
    expect((await run({ familyRows: [command("sed -i '' s/a/b/ x.txt", 20_000, 21_000)] })).left).toEqual([]);
    const edit = { ...base, workKind: "file-change", change: { path: "x", movePath: null }, startedAt: 20_000, createdAt: 20_000, completedAt: 21_000, sourceSeqStart: 1 };
    expect((await run({ familyRows: [edit] })).left).toEqual([]);
  });

  it("is kept when a family row of a child that can write ran then", async () => {
    expect((await run({ kinRows: [[command("node build.js", 20_000, 21_000)]] })).left).toEqual([]);
  });

  it("is still left out when only read-only family rows ran then", async () => {
    const read = { ...base, workKind: "file-read", path: "a.ts", cmd: "cat a.ts", startedAt: 20_000, createdAt: 20_000, completedAt: 21_000 };
    const search = { ...base, workKind: "search", mode: "content", path: null, cmd: null, query: "x", startedAt: 20_000, createdAt: 20_000, completedAt: 21_000 };
    const readTool = { ...base, workKind: "tool", toolName: "Read", toolArgs: { file_path: "a.ts" }, startedAt: 20_000, createdAt: 20_000, completedAt: 21_000 };
    const familyRows = [read, search, readTool, command("bb thread wait thr_1 --timeout 30", 20_000, 21_000), command("rg foo lib", 20_000, 21_000)];
    expect((await run({ familyRows })).left).toEqual(["generated.md"]);
  });

  it("keeps the family's window a further second wide on each side: 1.5 s after a family row ends is kept, 2.5 s after is left out", async () => {
    // The sibling's command runs from 20 s to 60 s; the family's ends at 31 s, its window at 33 s.
    const long = command("node gen.js", 20_000, 60_000, { threadId: "sib" });
    const family = [command("node build.js", 30_000, 31_000)];
    const at = (ctimeMs: number) => ({ siblingRows: [long], familyRows: family, disk: { [`${ROOT}/generated.md`]: { ctimeMs, content: "generated\n" } } });
    expect((await run(at(32_500))).left).toEqual([]);
    expect((await run(at(33_500))).left).toEqual(["generated.md"]);
    // The same on the early side: the row starts at 30 s, its window at 28 s.
    expect((await run(at(28_500))).left).toEqual([]);
    expect((await run(at(27_500))).left).toEqual(["generated.md"]);
  });

  it("gives a sibling's window no margin: 0.5 s inside its edge is left out, 1.5 s outside is kept", async () => {
    // The row ran 20 s to 21 s, so its window is 19 s to 22 s.
    const at = (ctimeMs: number) => ({ disk: { [`${ROOT}/generated.md`]: { ctimeMs, content: "generated\n" } } });
    expect((await run(at(21_500))).left).toEqual(["generated.md"]);
    expect((await run(at(19_500))).left).toEqual(["generated.md"]);
    expect((await run(at(23_500))).left).toEqual([]);
    expect((await run(at(17_500))).left).toEqual([]);
  });

  it("is kept when only a sibling's row that is not opaque ran then", async () => {
    expect((await run({ siblingRows: [command("sed -i '' s/a/b/ x.txt", 20_000, 21_000, { threadId: "sib" })] })).left).toEqual([]);
    expect((await run({ siblingRows: [command("rg foo", 20_000, 21_000, { threadId: "sib" })] })).left).toEqual([]);
  });

  it("is kept when the sibling's row never ran: denied, or no end recorded", async () => {
    expect((await run({ siblingRows: [command("node gen.js", 20_000, 21_000, { threadId: "sib", approvalStatus: "denied" })] })).left).toEqual([]);
    expect((await run({ siblingRows: [command("node gen.js", 20_000, undefined, { threadId: "sib" })] })).left).toEqual([]);
    expect((await run({ siblingRows: [command("node gen.js", 20_000, undefined, { threadId: "sib", status: "pending" })], siblingEntry: { status: "idle" } })).left).toEqual([]);
  });

  it("is kept while the sibling's command is still running", async () => {
    // Pending on a thread that is still active gives no window: until the command ends, the sibling's own review does not cover its write (advisor finding, thr_8rryqyy9me).
    expect((await run({ siblingRows: [command("node gen.js", 20_000, undefined, { threadId: "sib", status: "pending" })] })).left).toEqual([]);
  });

  it("is kept when the family has a row that can write and no window to place it", async () => {
    const noEnd = { ...base, workKind: "tool", toolName: "apply", toolArgs: { path: "x" }, startedAt: 20_000, createdAt: 20_000 };
    expect((await run({ familyRows: [noEnd] })).left).toEqual([]);
  });

  it("is kept when a family command never recorded an end: it runs until now", async () => {
    expect((await run({ familyRows: [command("node build.js", 15_000, undefined)] })).left).toEqual([]);
  });

  it("is kept when the sibling window ends before the turn began", async () => {
    expect((await run({ siblingRows: [command("node gen.js", 1_000, 2_000, { threadId: "sib" })], disk: { [`${ROOT}/generated.md`]: { ctimeMs: 1_500, content: "generated\n" } } })).left).toEqual([]);
  });
});

describe("the filter is off when the evidence is incomplete", () => {
  it.each([
    ["the turn's start is unknown", { input: { startedAt: undefined } }],
    ["the kin evidence was not read", { input: { kin: undefined } }],
    ["a related thread was not read in full", { complete: false }],
    ["this thread's own turn rows are truncated", { input: { ownRowsTruncated: true } }],
    ["the sibling evidence was not read", { input: { sibling: undefined } }],
    ["there is no candidate", { candidates: [] }],
    ["the checkout path is unknown", { root: null }],
    ["the checkout path cannot be read", { root: new Error(LEAK) }],
    ["this thread's earlier timeline cannot be read", { ownTimeline: new Error(LEAK) }],
  ] as Array<[string, Setup]>)("when %s", async (_name, setup) => {
    expect((await run(setup)).left).toEqual([]);
  });

  it("when the sibling was not read in full", async () => {
    const { left } = await run({ input: { sibling: { paths: new Set(), commitWindows: [], texts: [], complete: new Map([["sib", false]]), rows: new Map([["sib", [SIBLING_ROW] as never]]) } } });
    expect(left).toEqual([]);
  });

  it("when this thread's earlier timeline is truncated", async () => {
    const infinite = async () => ({
      rows: [],
      maxSeq: 0,
      timelinePage: { historySnapshot: "default", olderCursor: { anchorId: "a", anchorSeq: 1 }, returnedSegmentCount: 1 },
    });
    const { left } = await run({ input: { bb: { log: { info: () => 0 }, sdk: { environments: { get: async () => ({ path: ROOT }) }, threads: { timeline: infinite, events: { list: async () => [] } } } } as never } });
    expect(left).toEqual([]);
  });
});

describe("the checkout root", () => {
  it("keeps every path, and logs the class of the failure only, when it cannot be resolved", async () => {
    const { left, infos } = await run({ fs: { realpath: async () => { throw new RangeError(`${LEAK} /secret`); } } });
    expect(left).toEqual([]);
    expect(infos).toEqual(["auto-review: could not place the changes in time: the checkout path cannot be resolved: RangeError"]);
  });
});

describe("a sibling that gives no evidence", () => {
  it.each([
    ["is archived", { siblingEntry: { archivedAt: 5 } }],
    ["came from a plugin", { siblingEntry: { originPluginId: "advisor" } }],
    ["is hidden", { siblingEntry: { visibility: "hidden" } }],
    ["has no environment, so its root cannot be reviewed", { siblingEntry: { environmentId: null } }],
    ["is unknown to the thread list", { entries: [entry("self", { status: "idle" })] }],
    ["has a parent that is unknown", { siblingEntry: { parentThreadId: "gone" } }],
  ] as Array<[string, Setup]>)("%s", async (_name, setup) => {
    expect((await run(setup)).left).toEqual([]);
  });

  it("is under a root that is archived, or a plugin's", async () => {
    const entries = (root: Record<string, unknown>) => [entry("self", { status: "idle" }), entry("root", root), entry("sib", { parentThreadId: "root" })];
    expect((await run({ entries: entries({ archivedAt: 5 }) })).left).toEqual([]);
    expect((await run({ entries: entries({ originPluginId: "advisor" }) })).left).toEqual([]);
  });

  it("is in a parent cycle", async () => {
    expect((await run({ entries: [entry("self", { status: "idle" }), entry("sib", { parentThreadId: "other" }), entry("other", { parentThreadId: "sib" })] })).left).toEqual([]);
  });

  it("is attached under its root, so the root's review does not read its commands", async () => {
    const entries = [entry("self", { status: "idle" }), entry("root"), entry("sib", { parentThreadId: "root" })];
    const attach = { seq: 3, type: "system/operation", data: { operation: "ownership_change", operationId: "o", status: "completed", message: "m", metadata: { previousParentThreadId: null, nextParentThreadId: "root" } } };
    expect((await run({ entries, events: { sib: [attach] } })).left).toEqual([]);
  });

  it("is a reviewable sibling when it was spawned under a reviewable root, or is that root", async () => {
    const spawned = [entry("self", { status: "idle" }), entry("root"), entry("sib", { parentThreadId: "root" })];
    expect((await run({ entries: spawned })).left).toEqual(["generated.md"]);
    expect((await run()).left).toEqual(["generated.md"]);
  });
});

describe("the local file", () => {
  it("is kept when the working tree has no current content: deleted, unreadable or binary", async () => {
    expect((await run({ current: {} })).left).toEqual([]);
    expect((await run({ files: [{ path: "generated.md", status: "D" }] })).left).toEqual([]);
  });

  it("is kept when the content differs from what the working tree shows", async () => {
    expect((await run({ current: { "generated.md": "edited later\n" } })).left).toEqual([]);
  });

  it("is kept when the content is not text: the bytes hash differently from the decoded string", async () => {
    const bytes = new Uint8Array([0xff, 0xfe, 0x00, 0x80]);
    const decoded = Buffer.from(bytes).toString("utf8");
    expect((await run({ disk: { [`${ROOT}/generated.md`]: { ctimeMs: 20_500, bytes } }, current: { "generated.md": decoded } })).left).toEqual([]);
  });

  it("is kept when it is a symlink", async () => {
    expect((await run({ disk: { [`${ROOT}/generated.md`]: { ctimeMs: 20_500, link: true } } })).left).toEqual([]);
  });

  it("is kept when its directory resolves outside the checkout, and when it is only a sibling prefix of it", async () => {
    const candidates = ["lib/generated.md"];
    const disk = { [`${ROOT}/lib/generated.md`]: { ctimeMs: 20_500, content: "generated\n" } };
    expect((await run({ candidates, disk, fs: { realpath: async (path) => (path === ROOT ? ROOT : "/elsewhere") } })).left).toEqual([]);
    expect((await run({ candidates, disk, fs: { realpath: async (path) => (path === ROOT ? ROOT : "/w-other") } })).left).toEqual([]);
  });

  it("is left out when its parent directory is below the checkout", async () => {
    const candidates = ["lib/generated.md"];
    const disk = { [`${ROOT}/lib/generated.md`]: { ctimeMs: 20_500, content: "generated\n" } };
    expect((await run({ candidates, disk, fs: { realpath: async (path) => path } })).left).toEqual(candidates);
  });

  it("is kept when something else than a file or directory is there", async () => {
    const odd = async () => ({ ctimeMs: 20_500, isSymbolicLink: () => false, isDirectory: () => false, isFile: () => false });
    expect((await run({ fs: { lstat: odd } })).left).toEqual([]);
  });

  it("is kept, and logs the class of the failure only, when the file cannot be read", async () => {
    const { left, infos } = await run({ fs: { readFile: async () => { throw new TypeError(`${LEAK} /secret`); } } });
    expect(left).toEqual([]);
    expect(infos).toEqual(["auto-review: could not place the change to generated.md in time: TypeError"]);
    expect(JSON.stringify(infos)).not.toContain(LEAK);
  });

  it("is kept when the file is gone", async () => {
    const { left, infos } = await run({ disk: {} });
    expect(left).toEqual([]);
    expect(infos).toEqual(["auto-review: could not place the change to generated.md in time: Error"]);
  });

  it("is kept when a path has no working tree entry", async () => {
    expect((await run({ files: [] })).left).toEqual([]);
  });

  it("checks one file's content once", async () => {
    expect((await run({ candidates: ["a.md", "b.md"] })).diffed.sort()).toEqual(["a.md", "b.md"]);
  });

  it("does not read the content of a path that changed outside every window", async () => {
    const { diffed } = await run({ disk: { [`${ROOT}/generated.md`]: { ctimeMs: 80_000, content: "generated\n" } } });
    expect(diffed).toEqual([]);
  });

  it("checks at most 200 paths: the rest stay with the thread", async () => {
    const candidates = Array.from({ length: 205 }, (_, at) => `f${at}.md`);
    const { left } = await run({ candidates });
    expect(left).toHaveLength(200);
    expect(left).toEqual(candidates.slice(0, 200));
  });
});

describe("a directory entry", () => {
  const dir = (names: string[], ctimeMs = 20_500) => ({ ctimeMs, dir: names });
  const gen = (ctimeMs = 20_500) => ({ ctimeMs, content: "generated\n" });
  const setup = (disk: Disk, current: Record<string, string>): Setup => ({
    candidates: ["out/"],
    files: [{ path: "out/", status: "??", insertions: null, deletions: null }],
    disk,
    current,
  });

  it("is left out when every file under it passes", async () => {
    const disk = { [`${ROOT}/out`]: dir(["a.md", "deep"]), [`${ROOT}/out/a.md`]: gen(), [`${ROOT}/out/deep`]: dir(["b.md"]), [`${ROOT}/out/deep/b.md`]: gen() };
    const { left, diffed } = await run(setup(disk, { "out/a.md": "generated\n", "out/deep/b.md": "generated\n" }));
    expect(left).toEqual(["out/"]);
    expect(diffed.sort()).toEqual(["out/a.md", "out/deep/b.md"]);
  });

  it("is kept when one file under it changed outside every window", async () => {
    const disk = { [`${ROOT}/out`]: dir(["a.md", "b.md"]), [`${ROOT}/out/a.md`]: gen(), [`${ROOT}/out/b.md`]: gen(80_000) };
    expect((await run(setup(disk, { "out/a.md": "generated\n", "out/b.md": "generated\n" }))).left).toEqual([]);
  });

  it("is kept when one file under it has other content, or no current content", async () => {
    const disk = { [`${ROOT}/out`]: dir(["a.md", "b.md"]), [`${ROOT}/out/a.md`]: gen(), [`${ROOT}/out/b.md`]: gen() };
    expect((await run(setup(disk, { "out/a.md": "generated\n", "out/b.md": "other\n" }))).left).toEqual([]);
    expect((await run(setup(disk, { "out/a.md": "generated\n" }))).left).toEqual([]);
  });

  it("is kept when a symlink lies in a directory below it", async () => {
    const disk = { [`${ROOT}/out`]: dir(["deep"]), [`${ROOT}/out/deep`]: dir(["a.md"]), [`${ROOT}/out/deep/a.md`]: { ctimeMs: 20_500, link: true } };
    expect((await run(setup(disk, {}))).left).toEqual([]);
  });

  it("is kept when it holds a symlink, is empty, or holds more than 200 files", async () => {
    const withLink = { [`${ROOT}/out`]: dir(["a.md"]), [`${ROOT}/out/a.md`]: { ctimeMs: 20_500, link: true } };
    expect((await run(setup(withLink, {}))).left).toEqual([]);
    expect((await run(setup({ [`${ROOT}/out`]: dir([]) }, {}))).left).toEqual([]);
    const names = Array.from({ length: 201 }, (_, at) => `f${at}.md`);
    const many: Disk = { [`${ROOT}/out`]: dir(names), ...Object.fromEntries(names.map((name) => [`${ROOT}/out/${name}`, gen()])) };
    expect((await run(setup(many, Object.fromEntries(names.map((name) => [`out/${name}`, "generated\n"]))))).left).toEqual([]);
  });
});

describe("the log line carries paths only", () => {
  it("reads no command text into anything it logs", async () => {
    const { infos } = await run({ siblingRows: [command(`node gen.js ${LEAK}`, 20_000, 21_000, { threadId: "sib" })], familyRows: [command(`node build.js ${LEAK}`, 80_000, 81_000)] });
    expect(JSON.stringify(infos)).not.toContain(LEAK);
  });
});

describe("a real file", () => {
  let dir: string | undefined;
  afterEach(async () => {
    if (dir !== undefined) {
      await rm(dir, { recursive: true, force: true });
    }
    dir = undefined;
  });

  it("hashes the local bytes as contentHash hashes the working tree's content", async () => {
    const text = "# generated\nnaïve — ünïcode\n";
    expect(localContentHash(Buffer.from(text, "utf8"))).toBe(createHash("sha256").update(text).digest("hex").slice(0, 16));
  });

  it("is left out when a real file changed while the sibling's command ran, and kept as a symlink", async () => {
    dir = await mkdtemp(join(tmpdir(), "ar-change-time-"));
    const before = Date.now();
    await writeFile(join(dir, "generated.md"), "# generated\n");
    await symlink(join(dir, "generated.md"), join(dir, "link.md"));
    const after = Date.now();
    const { left } = await run({
      siblingRows: [command("node gen.js", before - 100, after + 100, { threadId: "sib" })],
      root: dir,
      candidates: ["generated.md", "link.md"],
      current: { "generated.md": "# generated\n", "link.md": "# generated\n" },
      // An undefined `fs` leaves the real file system in place.
      input: { fs: undefined, startedAt: before - 60_000, now: after + 1_000 },
    });
    expect(left).toEqual(["generated.md"]);
  });

  it("is kept when the real file's content changed after the working tree read it", async () => {
    dir = await mkdtemp(join(tmpdir(), "ar-change-time-"));
    const before = Date.now();
    await writeFile(join(dir, "generated.md"), "# edited since\n");
    const after = Date.now();
    const { left } = await run({
      siblingRows: [command("node gen.js", before - 100, after + 100, { threadId: "sib" })],
      root: dir,
      candidates: ["generated.md"],
      current: { "generated.md": "# generated\n" },
      input: { fs: undefined, startedAt: before - 60_000, now: after + 1_000 },
    });
    expect(left).toEqual([]);
  });
});
