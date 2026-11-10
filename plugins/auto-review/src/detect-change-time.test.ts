import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";

import { localContentHash, nodeChangeTimeFs, pathsLeftToSiblingCommands, readRegularFile } from "./detect-change-time.js";
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
  [path: string]: { ctimeMs: number; mtimeMs?: number; content?: string; bytes?: Uint8Array; link?: boolean; linkAtRead?: boolean; dir?: string[] };
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
        mtimeMs: found.mtimeMs ?? found.ctimeMs,
        isSymbolicLink: () => found.link === true,
        isDirectory: () => found.dir !== undefined,
        isFile: () => found.link !== true && found.dir === undefined,
      };
    },
    realpath: async (path) => path,
    readRegular: async (path) => {
      const found = at(path);
      if (found.linkAtRead === true) {
        throw Object.assign(new Error(`${LEAK} ${path}`), { code: "ELOOP" });
      }
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

/**
 * Upstream quirk, learned from `bb-plugin-sdk.d.ts` (`timelineFileChangeWorkRowSchema`, `timelineToolWorkRowSchema`):
 * a `file-change` row records `startedAt` and a status but no `completedAt` property at all, and a `tool` row's
 * `completedAt` is nullable, so a finished row can carry none. These fixtures have the real shape.
 */
const edit = (startedAt: number, over: Record<string, unknown> = {}) => ({
  ...base,
  workKind: "file-change",
  change: { path: "x", movePath: null },
  startedAt,
  createdAt: startedAt,
  sourceSeqStart: 1,
  ...over,
});
const writeTool = (startedAt: number, over: Record<string, unknown> = {}) => ({
  ...base,
  workKind: "tool",
  toolName: "apply",
  toolArgs: { path: "x" },
  startedAt,
  createdAt: startedAt,
  completedAt: null,
  ...over,
});
/** A tool that takes no argument string is opaque, which is how a sibling's tool row becomes evidence. */
const opaqueTool = (startedAt: number, over: Record<string, unknown> = {}) => writeTool(startedAt, { toolArgs: {}, threadId: "sib", ...over });

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
        list: async () => [],
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
    expect((await run({ familyRows: [edit(20_000)] })).left).toEqual([]);
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
    // A row of a kind that has no `completedAt` and is neither a tool nor a file change: nothing says when it ended.
    const noEnd = { ...base, workKind: "other-kind", startedAt: 20_000, createdAt: 20_000 };
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
    const odd = async () => ({ ctimeMs: 20_500, mtimeMs: 20_500, isSymbolicLink: () => false, isDirectory: () => false, isFile: () => false });
    expect((await run({ fs: { lstat: odd } })).left).toEqual([]);
  });

  it("is kept, and logs the class of the failure only, when the file cannot be read", async () => {
    const { left, infos } = await run({ fs: { readRegular: async () => { throw new TypeError(`${LEAK} /secret`); } } });
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

describe("the walk of a directory entry is capped", () => {
  const gen = (ctimeMs = 20_500) => ({ ctimeMs, content: "generated\n" });
  const dir = (names: string[]) => ({ ctimeMs: 20_500, dir: names });
  const setup = (disk: Disk, current: Record<string, string>): Setup => ({
    candidates: ["out/"],
    files: [{ path: "out/", status: "??", insertions: null, deletions: null }],
    disk,
    current,
  });

  it("counts directories against the cap too: 101 directories of one file each is more than 200 entries", async () => {
    const dirs = Array.from({ length: 101 }, (_, at) => `d${at}`);
    const disk: Disk = { [`${ROOT}/out`]: dir(dirs) };
    const current: Record<string, string> = {};
    for (const name of dirs) {
      disk[`${ROOT}/out/${name}`] = dir(["a.md"]);
      disk[`${ROOT}/out/${name}/a.md`] = gen();
      current[`out/${name}/a.md`] = "generated\n";
    }
    expect((await run(setup(disk, current))).left).toEqual([]);
    // 100 directories of one file each is exactly 200 entries, and passes.
    const fewer = dirs.slice(0, 100);
    const small: Disk = { [`${ROOT}/out`]: dir(fewer) };
    const smallCurrent: Record<string, string> = {};
    for (const name of fewer) {
      small[`${ROOT}/out/${name}`] = dir(["a.md"]);
      small[`${ROOT}/out/${name}/a.md`] = gen();
      smallCurrent[`out/${name}/a.md`] = "generated\n";
    }
    expect((await run(setup(small, smallCurrent))).left).toEqual(["out/"]);
  });

  it("goes at most 32 levels of directories below the entry", async () => {
    const chain = (depth: number) => {
      const disk: Disk = { [`${ROOT}/out`]: dir(["d1"]) };
      let path = `${ROOT}/out`;
      for (let level = 1; level <= depth; level += 1) {
        path += `/d${level}`;
        disk[path] = dir([level === depth ? "a.md" : `d${level + 1}`]);
      }
      disk[`${path}/a.md`] = gen();
      const relative = `${path.slice(ROOT.length + 1)}/a.md`;
      return setup(disk, { [relative]: "generated\n" });
    };
    expect((await run(chain(32))).left).toEqual(["out/"]);
    expect((await run(chain(33))).left).toEqual([]);
  });
});

describe("both the change time and the modification time must lie in a sibling window", () => {
  // The review of the first round: `chmod` moves only the change time, and `touch` sets the modification time.
  // The sibling's command runs from 20 s to 60 s (window 19 s to 61 s); the family's from 30 s to 31 s (window 28 s to 33 s).
  const long = command("node gen.js", 20_000, 60_000, { threadId: "sib" });
  const family = [command("node build.js", 30_000, 31_000)];
  const times = (ctimeMs: number, mtimeMs: number) => ({
    siblingRows: [long],
    familyRows: family,
    disk: { [`${ROOT}/generated.md`]: { ctimeMs, mtimeMs, content: "generated\n" } },
  });

  it("leaves the path out when both are in the sibling window and outside the family's", async () => {
    expect((await run(times(40_000, 41_000))).left).toEqual(["generated.md"]);
  });

  it("keeps it when the change time is in the sibling window and the modification time in a family window", async () => {
    expect((await run(times(40_000, 30_500))).left).toEqual([]);
  });

  it("keeps it when the modification time is in the sibling window and the change time in a family window", async () => {
    expect((await run(times(30_500, 40_000))).left).toEqual([]);
  });

  it("keeps it when either time lies outside every sibling window", async () => {
    expect((await run(times(40_000, 80_000))).left).toEqual([]);
    expect((await run(times(80_000, 40_000))).left).toEqual([]);
  });
});

describe("a row that records no end", () => {
  // Upstream quirk (see the fixtures above): a done `tool` or `file-change` row ends when the next row of its thread began.
  // The sibling's command runs from 20 s to 60 s, so only the family's windows decide.
  const long = command("node gen.js", 20_000, 60_000, { threadId: "sib" });
  const at = (ctimeMs: number, extra: Partial<Setup> = {}): Setup => ({
    siblingRows: [long],
    disk: { [`${ROOT}/generated.md`]: { ctimeMs, content: "generated\n" } },
    ...extra,
  });

  it("a family file-change row with no completedAt at all runs until the next row of its thread began: a write after it is left out, before it kept", async () => {
    // The next row began at 31 s, so the window is 29 s to 32 s, 28 s to 33 s with the margin.
    const rows = [edit(30_000), command("rg foo lib", 31_000, 31_100)];
    expect((await run(at(40_000, { familyRows: rows }))).left).toEqual(["generated.md"]);
    expect((await run(at(30_500, { familyRows: rows }))).left).toEqual([]);
    expect((await run(at(32_500, { familyRows: rows }))).left).toEqual([]);
  });

  it("a family write tool row with a null completedAt runs until now, whatever row follows it", async () => {
    // A parallel read began 50 ms after the tool row: it does not end the row, so a write 10 s later is kept.
    const parallelRead = { ...base, workKind: "file-read", path: "a.ts", cmd: null, startedAt: 30_050, createdAt: 30_050, completedAt: 30_100 };
    expect((await run(at(40_000, { familyRows: [writeTool(30_000), parallelRead] }))).left).toEqual([]);
    // The same with a command as the next row.
    expect((await run(at(40_000, { familyRows: [writeTool(30_000), command("rg foo", 31_000, 31_100)] }))).left).toEqual([]);
    // A row that recorded its end keeps it, and a write after it is left out.
    expect((await run(at(40_000, { familyRows: [writeTool(30_000, { completedAt: 31_000 }), parallelRead] }))).left).toEqual(["generated.md"]);
  });

  it("a family file-change row with no next row runs until now, so nothing after it is left out", async () => {
    expect((await run(at(40_000, { familyRows: [edit(30_000)] }))).left).toEqual([]);
  });

  it("a row that recorded its end keeps it", async () => {
    expect((await run(at(40_000, { familyRows: [writeTool(30_000, { completedAt: 31_000 })] }))).left).toEqual(["generated.md"]);
  });

  it("a pending family row runs until now", async () => {
    expect((await run(at(40_000, { familyRows: [writeTool(30_000, { status: "pending" })] }))).left).toEqual([]);
  });

  it("the next row is the next of the same thread: rows of another thread do not end it", async () => {
    const rows = [writeTool(30_000), command("rg foo", 31_000, 31_100, { threadId: "other" })];
    expect((await run(at(40_000, { familyRows: rows }))).left).toEqual([]);
  });

  it("a sibling's opaque tool row ends when its next row began, and a write after that is kept: the bound only narrows the evidence", async () => {
    const rows = [opaqueTool(20_000), command("rg foo", 25_000, 25_100, { threadId: "sib" })];
    // The window is 19 s to 26 s.
    expect((await run({ siblingRows: rows, disk: { [`${ROOT}/generated.md`]: { ctimeMs: 24_500, content: "generated\n" } } })).left).toEqual(["generated.md"]);
    expect((await run({ siblingRows: rows, disk: { [`${ROOT}/generated.md`]: { ctimeMs: 30_000, content: "generated\n" } } })).left).toEqual([]);
  });

  it("a sibling's opaque tool row with no next row gives no window", async () => {
    expect((await run({ siblingRows: [opaqueTool(20_000)] })).left).toEqual([]);
  });
});

describe("a sibling row from before the sibling's current turn is stale", () => {
  // The sibling's own review claims nothing from a row that began before its current turn, so its window is no evidence.
  const turn = (createdAt: number, children: unknown[]) => ({ kind: "turn", turnId: `turn-${createdAt}`, status: "completed", summaryCount: 0, createdAt, completedAt: null, children });
  const row = command("node gen.js", 20_000, 21_000, { threadId: "sib" });

  it("keeps the path when the sibling's newest turn began after the row", async () => {
    expect((await run({ siblingRows: [turn(5_000, []), turn(30_000, [])].concat([row] as never) })).left).toEqual([]);
  });

  it("leaves the path out when the row is in the sibling's newest turn", async () => {
    expect((await run({ siblingRows: [turn(5_000, []), turn(15_000, [row])] })).left).toEqual(["generated.md"]);
  });

  it("without a turn start in its rows, a row that began before this thread's own turn is stale", async () => {
    const old = command("node gen.js", 5_000, 21_000, { threadId: "sib" });
    expect((await run({ siblingRows: [old] })).left).toEqual([]);
    expect((await run({ siblingRows: [row] })).left).toEqual(["generated.md"]);
  });
});

describe("a sibling row of another turn than its newest work row's is stale", () => {
  // Work rows carry a nullable `turnId` (`bb-plugin-sdk.d.ts`, the work row schemas).
  const inTurn = (turnId: string | null, startedAt: number, completedAt: number) => command("node gen.js", startedAt, completedAt, { threadId: "sib", turnId });
  const quiet = (turnId: string, startedAt: number) => command("rg foo", startedAt, startedAt + 10, { threadId: "sib", turnId });

  it("keeps the path when the opaque row is of an earlier turn", async () => {
    const rows = [inTurn("turn-1", 20_000, 21_000), quiet("turn-2", 50_000)];
    expect((await run({ siblingRows: rows })).left).toEqual([]);
  });

  it("leaves the path out when the opaque row is of the newest turn", async () => {
    const rows = [quiet("turn-1", 12_000), inTurn("turn-2", 20_000, 21_000)];
    expect((await run({ siblingRows: rows })).left).toEqual(["generated.md"]);
  });

  it("keeps the path when the opaque row has no turn id while others do", async () => {
    expect((await run({ siblingRows: [inTurn(null, 20_000, 21_000), quiet("turn-2", 50_000)] })).left).toEqual([]);
  });

  it("reads the newest row of the sibling's own thread, not a delegation's", async () => {
    const nested = command("rg foo", 60_000, 60_010, { threadId: "child", turnId: "turn-other" });
    expect((await run({ siblingRows: [inTurn("turn-1", 20_000, 21_000), nested] })).left).toEqual(["generated.md"]);
  });

  it("falls back to the turn rows when no row carries a turn id", async () => {
    const turn = { kind: "turn", turnId: "turn-30", status: "completed", summaryCount: 0, createdAt: 30_000, completedAt: null, children: null };
    expect((await run({ siblingRows: [turn, command("node gen.js", 20_000, 21_000, { threadId: "sib" })] })).left).toEqual([]);
  });
});

describe("several siblings under one reviewable root", () => {
  it("are all read as evidence, with the root's family worked out once", async () => {
    const entries = [entry("self", { status: "idle" }), entry("root"), entry("sib", { parentThreadId: "root" }), entry("sib2", { parentThreadId: "root" })];
    const rows = new Map([
      ["sib", [command("node gen.js", 20_000, 21_000, { threadId: "sib" })] as never],
      ["sib2", [command("node other.js", 40_000, 41_000, { threadId: "sib2" })] as never],
    ]);
    const input = {
      sibling: { paths: new Set<string>(), commitWindows: [], texts: [], complete: new Map([["sib", true], ["sib2", true]]), rows },
      entries,
      disk: { [`${ROOT}/generated.md`]: { ctimeMs: 40_500, content: "generated\n" } },
    };
    expect((await run({ entries, input: { sibling: input.sibling }, disk: input.disk })).left).toEqual(["generated.md"]);
  });
});

describe("known gaps, pinned", () => {
  // Documented in the README: only the last change to a file is seen, and a time inside a sibling's window
  // cannot tell the sibling's write from an outside writer's.
  it("a file this thread wrote and a sibling's command rewrote later goes to the sibling", async () => {
    const { left } = await run({ familyRows: [command("node build.js", 12_000, 13_000)] });
    expect(left).toEqual(["generated.md"]);
  });

  it("a change an outside writer made during a sibling's command is left to the sibling too", async () => {
    // Nothing in the file's times or content says who wrote it: a hand edit or a formatter that lands inside
    // the window is indistinguishable from the sibling's own write, and no family command ran then.
    const { left } = await run({ disk: { [`${ROOT}/generated.md`]: { ctimeMs: 20_700, mtimeMs: 20_700, content: "# edited by hand\n" } }, current: { "generated.md": "# edited by hand\n" } });
    expect(left).toEqual(["generated.md"]);
  });

  it("a deletion is always kept", async () => {
    expect((await run({ files: [{ path: "generated.md", status: "D" }] })).left).toEqual([]);
  });

  it("a repo whose diffFile content is not byte-identical to the file on disk keeps every path", async () => {
    // For example a CRLF conversion or a `.gitattributes` filter: the bytes on disk differ from what the diff shows.
    const bytes = Buffer.from("line one\r\nline two\r\n", "utf8");
    const { left } = await run({ disk: { [`${ROOT}/generated.md`]: { ctimeMs: 20_500, bytes } }, current: { "generated.md": "line one\nline two\n" } });
    expect(left).toEqual([]);
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

  it("is kept when the path is a symlink at read time, though lstat said it was a file", async () => {
    dir = await mkdtemp(join(tmpdir(), "ar-change-time-"));
    const before = Date.now();
    await writeFile(join(dir, "target.md"), "# generated\n");
    await symlink(join(dir, "target.md"), join(dir, "generated.md"));
    const after = Date.now();
    // lstat reports a regular file with a time in the window; the read must still refuse the link.
    const lying = { ...nodeChangeTimeFs, lstat: async () => ({ ctimeMs: before, mtimeMs: before, isSymbolicLink: () => false, isDirectory: () => false, isFile: () => true }) };
    const { left, infos } = await run({
      siblingRows: [command("node gen.js", before - 100, after + 100, { threadId: "sib" })],
      root: dir,
      candidates: ["generated.md"],
      current: { "generated.md": "# generated\n" },
      input: { fs: lying, startedAt: before - 60_000, now: after + 1_000 },
    });
    expect(left).toEqual([]);
    expect(infos).toEqual(["auto-review: could not place the change to generated.md in time: Error"]);
  });

  it("reads nothing where the platform has no O_NOFOLLOW: the path stays", async () => {
    dir = await mkdtemp(join(tmpdir(), "ar-change-time-"));
    await writeFile(join(dir, "generated.md"), "# generated\n");
    await expect(readRegularFile(join(dir, "generated.md"), { O_RDONLY: 0 })).rejects.toThrow(TypeError);
    // With the platform's own flag, the same file reads.
    expect(Buffer.from(await readRegularFile(join(dir, "generated.md"))).toString("utf8")).toBe("# generated\n");
    const before = Date.now();
    const after = Date.now();
    const noFlag = { ...nodeChangeTimeFs, readRegular: (path: string) => readRegularFile(path, { O_RDONLY: 0 }), lstat: async () => ({ ctimeMs: before, mtimeMs: before, isSymbolicLink: () => false, isDirectory: () => false, isFile: () => true }) };
    const { left, infos } = await run({
      siblingRows: [command("node gen.js", before - 100, after + 100, { threadId: "sib" })],
      root: dir,
      candidates: ["generated.md"],
      current: { "generated.md": "# generated\n" },
      input: { fs: noFlag, startedAt: before - 60_000, now: after + 1_000 },
    });
    expect(left).toEqual([]);
    expect(infos).toEqual(["auto-review: could not place the change to generated.md in time: TypeError"]);
  });

  it("is kept when the path is no regular file at read time: a directory", async () => {
    dir = await mkdtemp(join(tmpdir(), "ar-change-time-"));
    const before = Date.now();
    await mkdir(join(dir, "generated.md"));
    const after = Date.now();
    const lying = { ...nodeChangeTimeFs, lstat: async () => ({ ctimeMs: before, mtimeMs: before, isSymbolicLink: () => false, isDirectory: () => false, isFile: () => true }) };
    const { left, infos } = await run({
      siblingRows: [command("node gen.js", before - 100, after + 100, { threadId: "sib" })],
      root: dir,
      candidates: ["generated.md"],
      current: { "generated.md": "# generated\n" },
      input: { fs: lying, startedAt: before - 60_000, now: after + 1_000 },
    });
    expect(left).toEqual([]);
    expect(infos).toEqual(["auto-review: could not place the change to generated.md in time: TypeError"]);
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
