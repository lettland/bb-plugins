import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { diffLineCount, fileHeartbeats, toExtraHeartbeat } from "./file-activity.js";
import type { EventRowLike, FileSpec } from "./file-activity.js";

describe("diffLineCount", () => {
  it("counts + and - lines after the first @@ and never the file headers", () => {
    const diff = "--- a/x.ts\n+++ b/x.ts\n@@ -1,2 +1,2 @@\n context\n-old\n+new\n context\n";
    expect(diffLineCount(diff)).toBe(2);
  });

  it("counts a removed line that itself starts with --", () => {
    expect(diffLineCount("@@ -1 +0,0 @@\n--- a comment line\n")).toBe(1);
    expect(diffLineCount("--- a/x\n+++ b/x\n@@ -1 +1 @@\n--- removed\n+++ added\n")).toBe(2);
  });

  it("works on a hunk-only diff, across several hunks, ignoring the no-newline marker", () => {
    expect(diffLineCount("@@ -1 +1 @@\n-a\n+b\n@@ -9 +9 @@\n-c\n+d\n\\ No newline at end of file\n")).toBe(4);
  });

  it("returns undefined for a diff without @@ or no diff at all", () => {
    expect(diffLineCount("just text\n+not a diff")).toBeUndefined();
    expect(diffLineCount("--- a\n+++ b\n")).toBeUndefined();
    expect(diffLineCount(undefined)).toBeUndefined();
  });

  it("returns 0 for a hunk header with no changed lines", () => {
    expect(diffLineCount("@@ -1 +1 @@\n context\n")).toBe(0);
  });
});

let base: string;
let root: string;
let outside: string;

beforeEach(() => {
  base = mkdtempSync(path.join(os.tmpdir(), "wk-"));
  root = path.join(base, "proj");
  outside = path.join(base, "outside");
  mkdirSync(root);
  mkdirSync(outside);
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

let seq = 0;
function row(item: unknown, createdAt = 1_700_000_000_000): EventRowLike {
  return { seq: ++seq, createdAt, data: { item } };
}

function change(kind: string, file: string, extra: Record<string, unknown> = {}, status = "completed") {
  return row({ type: "fileChange", status, changes: [{ kind, path: file, ...extra }] });
}

const DIFF = "@@ -1 +1 @@\n-a\n+b\n";

describe("fileHeartbeats: items", () => {
  it("maps add and update to write specs with a line count, delete to a write spec without one", async () => {
    writeFileSync(path.join(root, "a.ts"), "x");
    writeFileSync(path.join(root, "b.ts"), "x");
    const { specs, outOfScope } = await fileHeartbeats(
      [
        change("add", path.join(root, "a.ts"), { diff: DIFF }),
        change("update", path.join(root, "b.ts"), { diff: "@@ -1 +1,2 @@\n-a\n+b\n+c\n" }),
        change("delete", path.join(root, "gone.ts"), { diff: DIFF }),
      ],
      { path: root },
      "edits-and-reads",
    );
    const real = realpathSync(root);
    expect(outOfScope).toBe(0);
    expect(specs.map((s) => [path.relative(real, s.path), s.write, s.aiLineChanges])).toEqual([
      ["a.ts", true, 2],
      ["b.ts", true, 3],
      ["gone.ts", true, undefined],
    ]);
  });

  it("omits the line count when the diff has no @@ or is missing", async () => {
    const { specs } = await fileHeartbeats(
      [change("update", path.join(root, "a.ts"), { diff: "no hunks" }), change("update", path.join(root, "b.ts"))],
      { path: root },
      "edits",
    );
    expect(specs.map((s) => s.aiLineChanges)).toEqual([undefined, undefined]);
  });

  it("emits two writes for a move, with the line count only on the new path", async () => {
    const { specs } = await fileHeartbeats(
      [change("update", path.join(root, "old.ts"), { movePath: path.join(root, "new.ts"), diff: DIFF })],
      { path: root },
      "edits",
    );
    const real = realpathSync(root);
    expect(specs.map((s) => [path.relative(real, s.path), s.write, s.aiLineChanges])).toEqual([
      ["old.ts", true, undefined],
      ["new.ts", true, 2],
    ]);
  });

  it("maps a completed read to a non-write spec only in edits-and-reads mode", async () => {
    writeFileSync(path.join(root, "r.ts"), "x");
    const rows = [row({ type: "fileRead", status: "completed", path: path.join(root, "r.ts") })];
    expect((await fileHeartbeats(rows, { path: root }, "edits-and-reads")).specs.map((s) => s.write)).toEqual([false]);
    expect((await fileHeartbeats(rows, { path: root }, "edits")).specs).toEqual([]);
    expect((await fileHeartbeats(rows, { path: root }, "off")).specs).toEqual([]);
  });

  it("takes the row's createdAt as the time", async () => {
    const { specs } = await fileHeartbeats([change("add", path.join(root, "a.ts"))], { path: root }, "edits");
    expect(specs[0]!.timeMs).toBe(1_700_000_000_000);
  });

  it("skips failed, interrupted and pending items, and anything that is not a file item", async () => {
    const file = path.join(root, "a.ts");
    const { specs, outOfScope } = await fileHeartbeats(
      [
        change("add", file, {}, "failed"),
        change("add", file, {}, "interrupted"),
        change("add", file, {}, "pending"),
        row({ type: "fileRead", status: "failed", path: file }),
        row({ type: "commandExecution", status: "completed", cmd: "a shell command" }),
        row({ type: "fileChange", status: "completed", changes: "oops" }),
        row({ type: "fileChange", status: "completed", changes: [null, { kind: "add" }] }),
        { seq: 99, createdAt: 1, data: null },
        { seq: 100, createdAt: 1, data: { item: "string" } },
      ],
      { path: root },
      "edits-and-reads",
    );
    expect(specs).toEqual([]);
    expect(outOfScope).toBe(0);
  });
});

describe("fileHeartbeats: scope", () => {
  const real = () => realpathSync(root);

  async function scan(files: string[], envPath: string | null = root) {
    const result = await fileHeartbeats(
      files.map((f) => change("update", f, { diff: DIFF })),
      { path: envPath },
      "edits",
    );
    return { kept: result.specs.map((s) => s.path), outOfScope: result.outOfScope };
  }

  it("resolves relative paths against the environment folder", async () => {
    expect(await scan(["src/a.ts", "./b.ts"])).toEqual({
      kept: [path.join(real(), "src/a.ts"), path.join(real(), "b.ts")],
      outOfScope: 0,
    });
  });

  it("drops ../ escapes, absolute paths elsewhere, the folder itself, node_modules and .git, and counts them", async () => {
    const result = await scan([
      "../outside/x.ts",
      path.join(outside, "y.ts"),
      "/etc/passwd",
      ".",
      "node_modules/pkg/index.js",
      "pkg/node_modules/x.js",
      ".git/config",
      "sub/.git/HEAD",
      "ok.ts",
    ]);
    expect(result.kept).toEqual([path.join(real(), "ok.ts")]);
    expect(result.outOfScope).toBe(8);
  });

  it("keeps a file whose name merely starts with two dots", async () => {
    expect((await scan(["..hidden.ts"])).kept).toEqual([path.join(real(), "..hidden.ts")]);
  });

  it("matches by path segment: /a/proj does not contain /a/project2/x", async () => {
    const result = await scan(["/a/project2/x.ts", "/a/proj/y.ts", "/a/proj-other/z.ts"], "/a/proj");
    expect(result.kept).toEqual(["/a/proj/y.ts"]);
    expect(result.outOfScope).toBe(2);
  });

  it("drops every spec, counted, when there is no environment folder", async () => {
    expect(await scan(["a.ts", "b.ts"], null)).toEqual({ kept: [], outOfScope: 2 });
    expect(await scan(["a.ts"], "")).toEqual({ kept: [], outOfScope: 1 });
  });

  it("emits an existing and a deleted file in a symlinked environment folder under the same resolved prefix", async () => {
    const link = path.join(base, "link-to-proj");
    symlinkSync(root, link);
    writeFileSync(path.join(root, "exists.ts"), "x");
    const result = await scan([path.join(link, "exists.ts"), path.join(link, "deleted.ts"), "rel.ts"], link);
    const prefix = real();
    expect(result.kept).toEqual([
      path.join(prefix, "exists.ts"),
      path.join(prefix, "deleted.ts"),
      path.join(prefix, "rel.ts"),
    ]);
    expect(result.outOfScope).toBe(0);
  });

  it("handles the platform's own symlinked temp directory the same way", async () => {
    // On macOS os.tmpdir() sits behind /var -> /private/var; elsewhere this is the plain path.
    writeFileSync(path.join(root, "exists.ts"), "x");
    const result = await scan([path.join(root, "exists.ts"), path.join(root, "deleted.ts")], root);
    expect(result.kept).toEqual([path.join(real(), "exists.ts"), path.join(real(), "deleted.ts")]);
    expect(result.outOfScope).toBe(0);
  });

  it("also accepts paths written with the resolved prefix", async () => {
    writeFileSync(path.join(root, "exists.ts"), "x");
    expect((await scan([path.join(real(), "exists.ts")], root)).kept).toEqual([path.join(real(), "exists.ts")]);
  });

  it("drops an existing file reached through a symlink that points outside, and a deleted file under one", async () => {
    writeFileSync(path.join(outside, "secret.txt"), "x");
    symlinkSync(outside, path.join(root, "escape"));
    symlinkSync(path.join(outside, "secret.txt"), path.join(root, "alias.txt"));
    const result = await scan(["escape/secret.txt", "escape/gone.txt", "escape/new/deep.txt", "alias.txt", "fine.txt"]);
    expect(result.kept).toEqual([path.join(real(), "fine.txt")]);
    expect(result.outOfScope).toBe(4);
  });
});

describe("fileHeartbeats: is_unsaved_entity", () => {
  async function unsaved(file: string, envPath: string) {
    const { specs } = await fileHeartbeats([change("update", file, { diff: DIFF })], { path: envPath }, "edits");
    return specs[0]!.unsaved;
  }

  it("is false only for a regular file that exists in a local environment folder", async () => {
    writeFileSync(path.join(root, "a.ts"), "x");
    expect(await unsaved(path.join(root, "a.ts"), root)).toBe(false);
  });

  it("is true for a deleted file, a directory, and a socket (neither is a regular file)", async () => {
    mkdirSync(path.join(root, "dir"));
    expect(await unsaved(path.join(root, "gone.ts"), root)).toBe(true);
    expect(await unsaved(path.join(root, "dir"), root)).toBe(true);
    const socket = path.join(root, "s");
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(socket, resolve));
    try {
      expect(await unsaved(socket, root)).toBe(true);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("is true when the environment folder does not exist here (a remote environment)", async () => {
    expect(await unsaved("/remote/proj/a.ts", "/remote/proj")).toBe(true);
  });

  it("is true when the environment path is a file, not a directory", async () => {
    writeFileSync(path.join(root, "not-a-dir"), "x");
    expect(await unsaved(path.join(root, "not-a-dir", "a.ts"), path.join(root, "not-a-dir"))).toBe(true);
  });
});

describe("toExtraHeartbeat", () => {
  const spec: FileSpec = { path: "/p/a.ts", write: true, aiLineChanges: 3, timeMs: 1_700_000_000_250, unsaved: true };
  const ctx = { project: "acme", branch: "feat/x", category: "building" };

  it("returns exactly the documented keys, with time in seconds", () => {
    const extra = toExtraHeartbeat(spec, ctx);
    expect(Object.keys(extra).sort()).toEqual(
      [
        "ai_line_changes",
        "alternate_branch",
        "category",
        "entity",
        "is_unsaved_entity",
        "is_write",
        "project",
        "time",
        "type",
      ].sort(),
    );
    expect(extra).toEqual({
      entity: "/p/a.ts",
      type: "file",
      category: "building",
      time: 1_700_000_000.25,
      is_write: true,
      project: "acme",
      alternate_branch: "feat/x",
      ai_line_changes: 3,
      is_unsaved_entity: true,
    });
  });

  it("omits the optional keys when they do not apply", () => {
    const extra = toExtraHeartbeat(
      { path: "/p/a.ts", write: false, timeMs: 1000, unsaved: false },
      { branch: null, category: "building" },
    );
    expect(Object.keys(extra).sort()).toEqual(["category", "entity", "is_write", "time", "type"]);
    expect(extra.is_write).toBe(false);
  });

  it("never carries diff text, a command or any key", () => {
    const sneaky = { ...spec, diff: "secret diff", cmd: "a command", key: "waka_x" } as FileSpec;
    expect(JSON.stringify(toExtraHeartbeat(sneaky, ctx))).not.toMatch(/secret diff|a command|waka_x/);
  });
});
