import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildGitInvocation, buildSearchInvocation, executeSearch } from "../src/runtime.mjs";

const WORKSPACE = "/workspace/platform";
const ROOT_FORMS = [".", "./", ".//", "a/..", "a/../", "./.", "././", ".\\", "a\\..\\"];

function addPaths(paths) {
  const { args } = buildGitInvocation(WORKSPACE, { operation: "add", paths });
  return args.slice(args.indexOf("--") + 1);
}

function searchPath(value) {
  const { args } = buildSearchInvocation(WORKSPACE, { query: "q", path: value });
  return args.at(-1);
}

test("relative paths are accepted and normalized", () => {
  const cases = [
    ["a", "a"],
    ["src/go/a.go", "src/go/a.go"],
    ["./a", "a"],
    ["a//b", "a/b"],
    ["a/./b", "a/b"],
    ["a/b/", "a/b/"],
    ["a/../b", "b"],
    ["..foo", "..foo"],
    ["a..b/c", "a..b/c"],
    ["src\\win\\a.go", "src/win/a.go"],
  ];
  for (const [input, expected] of cases) {
    assert.deepEqual(addPaths([input]), [expected], input);
  }
});

test("option-like paths are rejected", () => {
  for (const value of ["-x", "--foo", "--all", "-", "-./a", "./-x", "a/../-x"]) {
    assert.throws(() => addPaths([value]), /relative and may not be an option/, value);
    assert.throws(() => searchPath(value), /relative and may not be an option/, value);
  }
});

test("paths escaping the workspace are rejected", () => {
  const escapes = ["..", "../x", "a/../../x", "a/b/../../../x", "./../x", "..\\x", "a\\..\\..\\x"];
  for (const value of escapes) {
    assert.throws(() => addPaths([value]), /escapes the workspace/, value);
    assert.throws(() => searchPath(value), /escapes the workspace/, value);
  }
});

test("add rejects every workspace-root form", () => {
  for (const value of ROOT_FORMS) {
    assert.throws(() => addPaths([value]), /may not be the workspace root; list explicit paths/, value);
  }
});

test("search maps every workspace-root form to dot", () => {
  for (const value of ROOT_FORMS) {
    assert.equal(searchPath(value), ".", value);
  }
  assert.equal(searchPath("a/b"), "a/b");
});

test("absolute paths are rejected for add and search", () => {
  const absolutes = ["/etc/passwd", "/", "/workspace/platform/a", "\\", "\\etc\\passwd", "\\\\server\\share"];
  for (const value of absolutes) {
    assert.throws(() => addPaths([value]), /relative and may not be an option/, value);
    assert.throws(() => searchPath(value), /relative and may not be an option/, value);
  }
});

test("empty, non-string, and NUL-containing paths are rejected", () => {
  for (const value of ["", "a\0b", "\0", null, undefined, 1, {}, ["a"]]) {
    assert.throws(() => addPaths([value]), /path is missing or invalid/, String(value));
  }
});

test("one invalid path rejects the whole list", () => {
  assert.throws(() => addPaths(["ok.txt", "../x"]), /escapes the workspace/);
  assert.deepEqual(addPaths(["a", "b/c"]), ["a", "b/c"]);
});

test("add passes pathspec magic literally after the safety args", () => {
  const { args } = buildGitInvocation(WORKSPACE, {
    operation: "add",
    paths: ["*", ":/", ":(top)", ":!x"],
  });
  const addIndex = args.indexOf("add");
  assert.equal(args[addIndex - 1], "--literal-pathspecs");
  assert.ok(args.lastIndexOf("-c") < addIndex - 1);
  assert.deepEqual(args.slice(addIndex), ["add", "--", "*", ":/", ":(top)", ":!x"]);
});

function gitAvailable() {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

test("add with a glob stages nothing in a real repository", { skip: !gitAvailable() }, () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "paths-test-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd });
    fs.writeFileSync(path.join(cwd, "a.txt"), "a");
    fs.writeFileSync(path.join(cwd, "b.txt"), "b");
    const { args } = buildGitInvocation(cwd, { operation: "add", paths: ["*"] });
    assert.throws(() => execFileSync("git", args, { cwd, stdio: "ignore" }));
    assert.equal(execFileSync("git", ["diff", "--cached", "--name-only"], { cwd }).toString(), "");
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

function createSearchFixture(t) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "search-escape-")));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const hostRoot = path.join(base, "ws");
  fs.mkdirSync(path.join(hostRoot, "sub"), { recursive: true });
  fs.mkdirSync(path.join(base, "outside"));
  fs.writeFileSync(path.join(base, "outside", "f.txt"), "secret");
  fs.symlinkSync("../outside", path.join(hostRoot, "link"));
  fs.symlinkSync("./sub", path.join(hostRoot, "inner"));
  const bin = path.join(base, "bin");
  fs.mkdirSync(bin);
  const log = path.join(base, "rg.log");
  fs.writeFileSync(path.join(bin, "rg"), `#!/bin/sh\nprintf "%s\\n" "$6" >> "${log}"\nexit 1\n`, {
    mode: 0o755,
  });
  const env = { PATH: `${bin}${path.delimiter}/usr/bin${path.delimiter}/bin` };
  const policy = { manifest: { search: { defaultPath: "." } } };
  return { env, hostRoot, log, policy };
}

test("search denies symlinked paths that escape the workspace before running rg", async (t) => {
  const { env, hostRoot, log, policy } = createSearchFixture(t);
  for (const value of ["link", "link/f.txt"]) {
    await assert.rejects(
      executeSearch(policy, { hostRoot }, { query: "q", path: value }, { env }),
      /escapes the workspace/,
      value,
    );
  }
  assert.equal(fs.existsSync(log), false, "rg never ran");
});

test("search still runs for in-workspace, missing, and default paths", async (t) => {
  const { env, hostRoot, log, policy } = createSearchFixture(t);
  const searched = ["inner", "sub", "missing", undefined];
  for (const value of searched) {
    const result = await executeSearch(policy, { hostRoot }, { query: "q", path: value }, { env });
    assert.equal(result.code, 1, String(value));
  }
  assert.deepEqual(fs.readFileSync(log, "utf8").trim().split("\n"), [
    "inner",
    "sub",
    "missing",
    ".",
  ]);
});
