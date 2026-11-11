import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  activeScopes,
  buildScope,
  expandHome,
  isWithin,
  normalizeDir,
} from "./paths.js";

// Ported from plugins/dir-skills/scopes.test.ts (expandHome, activeScopes) and extended for
// normalizeDir and isWithin, which dir-skills covered only through other tests.
const tmp = realpathSync(mkdtempSync(path.join(tmpdir(), "model-instructions-paths-")));

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function dir(...parts: string[]): string {
  const p = path.join(tmp, ...parts);
  mkdirSync(p, { recursive: true });
  return p;
}

describe("expandHome", () => {
  const home = "/home/test";

  it("expands a bare tilde and ~/ paths", () => {
    expect(expandHome("~", home)).toBe(home);
    expect(expandHome("~/docs", home)).toBe(path.join(home, "docs"));
  });

  it("leaves other paths alone", () => {
    expect(expandHome("/opt/x", home)).toBe("/opt/x");
    expect(expandHome("relative", home)).toBe("relative");
    expect(expandHome("~x/y", home)).toBe("~x/y");
  });

  it("defaults to the user's home directory", () => {
    expect(expandHome("~")).toBe(homedir());
  });
});

describe("normalizeDir", () => {
  it("expands ~/ against the given home and makes the path absolute", () => {
    const home = dir("home");
    expect(normalizeDir("~/src", home)).toBe(path.join(home, "src"));
    expect(normalizeDir("~", home)).toBe(home);
  });

  it("resolves a relative path against the working directory", () => {
    expect(normalizeDir("some/where")).toBe(path.resolve("some/where"));
  });

  it("resolves symlinks of an existing path", () => {
    const real = dir("real");
    const link = path.join(tmp, "link");
    symlinkSync(real, link);
    expect(normalizeDir(link)).toBe(real);
    expect(normalizeDir(path.join(link, "."))).toBe(real);
  });

  it("keeps a path that does not exist, without resolving it", () => {
    const missing = path.join(tmp, "not", "there");
    expect(normalizeDir(missing)).toBe(missing);
  });

  it("keeps a dangling symlink as written", () => {
    const dangling = path.join(tmp, "dangling");
    symlinkSync(path.join(tmp, "nowhere"), dangling);
    expect(normalizeDir(dangling)).toBe(dangling);
  });

  it("collapses .. segments", () => {
    const real = dir("collapse", "a");
    expect(normalizeDir(path.join(real, "..", "a"))).toBe(real);
  });

  it("defaults to the user's home directory", () => {
    expect(normalizeDir("~")).toBe(normalizeDir(homedir()));
  });
});

describe("isWithin", () => {
  it("counts the root itself", () => {
    expect(isWithin("/a/b", "/a/b")).toBe(true);
  });

  it("counts a descendant", () => {
    expect(isWithin("/a/b", "/a/b/c/d")).toBe(true);
  });

  it("rejects a sibling that shares a name prefix", () => {
    expect(isWithin("/a/b", "/a/b-extra")).toBe(false);
    expect(isWithin("/a/b", "/a/bc")).toBe(false);
  });

  it("rejects a parent and an unrelated path", () => {
    expect(isWithin("/a/b", "/a")).toBe(false);
    expect(isWithin("/a/b", "/x/y")).toBe(false);
  });

  it("counts a child directory whose name starts with two dots", () => {
    expect(isWithin("/a/b", "/a/b/..cache")).toBe(true);
    expect(isWithin("/a/b", "/a/b/..cache/x")).toBe(true);
  });

  it("rejects the parent of the root and a sibling reached through ..", () => {
    expect(isWithin("/a/b", "/a/b/..")).toBe(false);
    expect(isWithin("/a/b", "/a/b/../x")).toBe(false);
  });
});

describe("buildScope", () => {
  it("normalizes every path and keeps the name", () => {
    const real = dir("build", "real");
    const link = path.join(tmp, "build-link");
    symlinkSync(real, link);
    expect(buildScope({ name: "w", paths: [link, "~/x"] }, "/home/test")).toEqual({
      name: "w",
      paths: [real, "/home/test/x"],
    });
  });

  it("defaults to the user's home directory", () => {
    expect(buildScope({ name: "w", paths: ["~/zz-missing-dir"] }).paths).toEqual([
      path.join(normalizeDir("~"), "zz-missing-dir"),
    ]);
  });
});

describe("activeScopes", () => {
  const workRoot = dir("tree", "work");
  const labRoot = dir("tree", "lab");
  const scopes = [
    { name: "work", paths: [workRoot] },
    { name: "lab", paths: [labRoot] },
  ];

  it("activates scopes whose path contains a candidate", () => {
    const active = activeScopes(scopes, [path.join(workRoot, "repo", "sub")]);
    expect(active.map((s) => s.name)).toEqual(["work"]);
  });

  it("treats the scope root itself as inside", () => {
    expect(activeScopes(scopes, [workRoot]).map((s) => s.name)).toEqual(["work"]);
  });

  it("does not match a sibling that shares a name prefix", () => {
    expect(activeScopes(scopes, [`${workRoot}-extra`])).toEqual([]);
  });

  it("matches when any candidate is inside", () => {
    const active = activeScopes(scopes, [dir("elsewhere"), labRoot]);
    expect(active.map((s) => s.name)).toEqual(["lab"]);
  });

  it("matches when any path of the scope contains the candidate", () => {
    const two = [{ name: "both", paths: [dir("tree", "x"), labRoot] }];
    expect(activeScopes(two, [path.join(labRoot, "repo")]).map((s) => s.name)).toEqual(["both"]);
  });

  it("activates nothing without candidates", () => {
    expect(activeScopes(scopes, [])).toEqual([]);
  });

  it("resolves a symlinked candidate into the scope", () => {
    const link = path.join(tmp, "via-link");
    symlinkSync(workRoot, link);
    dir("tree", "work", "repo");
    expect(activeScopes(scopes, [path.join(link, "repo")]).map((s) => s.name)).toEqual(["work"]);
  });

  it("matches a scope whose path is a symlink once built", () => {
    const link = path.join(tmp, "scope-link");
    symlinkSync(labRoot, link);
    dir("tree", "lab", "repo");
    const built = [buildScope({ name: "linked", paths: [link] })];
    expect(built[0].paths).toEqual([labRoot]);
    expect(activeScopes(built, [path.join(labRoot, "repo")]).map((s) => s.name)).toEqual(["linked"]);
    expect(activeScopes(built, [path.join(link, "repo")]).map((s) => s.name)).toEqual(["linked"]);
  });
});
