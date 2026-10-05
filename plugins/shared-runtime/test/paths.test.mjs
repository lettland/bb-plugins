import assert from "node:assert/strict";
import test from "node:test";

import { buildGitInvocation } from "../src/runtime.mjs";

const WORKSPACE = "/workspace/platform";

function addPaths(paths) {
  const { args } = buildGitInvocation(WORKSPACE, { operation: "add", paths });
  return args.slice(args.indexOf("--") + 1);
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
  for (const value of ["-x", "--foo", "--all", "-", "-./a"]) {
    assert.throws(() => addPaths([value]), /relative and may not be an option/, value);
  }
});

test("paths escaping the workspace are rejected", () => {
  const escapes = [
    "..",
    "../x",
    "a/../../x",
    "a/b/../../../x",
    "./../x",
    "..\\x",
    "a\\..\\..\\x",
    ".",
    "a/..",
  ];
  for (const value of escapes) {
    assert.throws(() => addPaths([value]), /escapes the workspace/, value);
  }
});

test("absolute paths are rejected", () => {
  for (const value of ["/etc/passwd", "/", "/workspace/platform/a"]) {
    assert.throws(() => addPaths([value]), /relative and may not be an option/, value);
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
