import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  activeScopes,
  configDirFor,
  loadScopes,
  parseScopes,
  selectSkills,
  type SkillInfo,
} from "./scopes";

const tmp = realpathSync(mkdtempSync(path.join(tmpdir(), "dir-skills-")));

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

let fileCounter = 0;
function scopesFile(scopes: unknown[]): string {
  fileCounter += 1;
  const file = path.join(tmp, `scopes-${fileCounter}.json`);
  writeFileSync(file, JSON.stringify({ scopes }));
  return file;
}

function dir(...parts: string[]): string {
  const p = path.join(tmp, ...parts);
  mkdirSync(p, { recursive: true });
  return p;
}

describe("parseScopes", () => {
  const base = { name: "work", paths: ["/a"], skills: ["work-*"] };

  it("leaves claudeConfigDir null when absent", () => {
    const [scope] = parseScopes(scopesFile([base]));
    expect(scope.claudeConfigDir).toBeNull();
  });

  it("expands a ~/ claudeConfigDir", () => {
    const [scope] = parseScopes(
      scopesFile([{ ...base, claudeConfigDir: "~/.claude-acme" }]),
    );
    expect(scope.claudeConfigDir).toBe(path.join(homedir(), ".claude-acme"));
  });

  it("accepts an absolute claudeConfigDir and trims it", () => {
    const [scope] = parseScopes(
      scopesFile([{ ...base, claudeConfigDir: "  /opt/claude/work/  " }]),
    );
    expect(scope.claudeConfigDir).toBe("/opt/claude/work");
  });

  it.each([
    ["relative", "claude/work"],
    ["dot-relative", "./claude"],
    ["empty", ""],
    ["blank", "   "],
    ["bare tilde", "~"],
    ["number", 7],
    ["null", null],
    ["object", {}],
  ])("rejects a %s claudeConfigDir", (_label, value) => {
    expect(() =>
      parseScopes(scopesFile([{ ...base, claudeConfigDir: value }])),
    ).toThrow(/scope "work" "claudeConfigDir"/);
  });

  it("still requires skills", () => {
    expect(() =>
      parseScopes(
        scopesFile([
          { name: "work", paths: ["/a"], claudeConfigDir: "/opt/claude" },
        ]),
      ),
    ).toThrow(/needs a non-empty "skills"/);
  });

  it("still requires paths", () => {
    expect(() =>
      parseScopes(scopesFile([{ name: "work", skills: ["x"] }])),
    ).toThrow(/needs a non-empty "paths"/);
  });
});

describe("loadScopes", () => {
  it("lets a user scope replace a shipped one of the same name", () => {
    const root = dir("root");
    writeFileSync(
      path.join(root, "scopes.json"),
      JSON.stringify({
        scopes: [
          { name: "work", paths: ["/shipped"], skills: ["work-*"] },
          { name: "other", paths: ["/other"], skills: ["o-*"] },
        ],
      }),
    );
    const userFile = scopesFile([
      {
        name: "work",
        paths: ["/mine"],
        skills: ["work-*"],
        claudeConfigDir: "/opt/claude",
      },
    ]);
    const scopes = loadScopes(root, userFile);
    expect(scopes.map((s) => s.name).sort()).toEqual(["other", "work"]);
    const work = scopes.find((s) => s.name === "work");
    expect(work?.paths).toEqual(["/mine"]);
    expect(work?.claudeConfigDir).toBe("/opt/claude");
  });

  it("ignores a missing user file", () => {
    const root = dir("root-only");
    writeFileSync(
      path.join(root, "scopes.json"),
      JSON.stringify({
        scopes: [{ name: "work", paths: ["/shipped"], skills: ["work-*"] }],
      }),
    );
    const scopes = loadScopes(root, path.join(tmp, "absent.json"));
    expect(scopes.map((s) => s.name)).toEqual(["work"]);
  });
});

function scopesFor(
  defs: Array<{ name: string; path: string; claudeConfigDir?: string }>,
) {
  return parseScopes(
    scopesFile(defs.map((d) => ({ ...d, paths: [d.path], skills: ["x-*"] }))),
  );
}

describe("activeScopes / selectSkills", () => {
  const workRoot = dir("tree", "work");
  const labRoot = dir("tree", "lab");
  const scopes = scopesFor([
    { name: "work", path: workRoot },
    { name: "lab", path: labRoot },
  ]);
  const skills: SkillInfo[] = [
    { name: "global-one", dir: "/s/g", scopes: [] },
    { name: "work-a", dir: "/s/w", scopes: ["work"] },
    { name: "lab-a", dir: "/s/l", scopes: ["lab"] },
    { name: "shared", dir: "/s/s", scopes: ["work", "lab"] },
  ];

  it("activates scopes whose path contains a candidate", () => {
    const active = activeScopes(scopes, [path.join(workRoot, "repo", "sub")]);
    expect(active.map((s) => s.name)).toEqual(["work"]);
  });

  it("treats the scope root itself as inside", () => {
    expect(activeScopes(scopes, [workRoot]).map((s) => s.name)).toEqual([
      "work",
    ]);
  });

  it("does not match a sibling that shares a name prefix", () => {
    expect(activeScopes(scopes, [`${workRoot}-extra`])).toEqual([]);
  });

  it("matches when any candidate is inside", () => {
    const active = activeScopes(scopes, [dir("elsewhere"), labRoot]);
    expect(active.map((s) => s.name)).toEqual(["lab"]);
  });

  it("gives only global skills with no candidates", () => {
    expect(selectSkills(skills, scopes, [])).toEqual(["global-one"]);
  });

  it("adds the skills of each active scope", () => {
    expect(selectSkills(skills, scopes, [workRoot])).toEqual([
      "global-one",
      "work-a",
      "shared",
    ]);
    expect(selectSkills(skills, scopes, [workRoot, labRoot])).toEqual([
      "global-one",
      "work-a",
      "lab-a",
      "shared",
    ]);
  });
});

describe("configDirFor", () => {
  const aRoot = dir("cfg", "a");
  const bRoot = dir("cfg", "b");
  const noProfile = dir("cfg", "plain");

  it("returns nothing when no scope matches", () => {
    const scopes = scopesFor([
      { name: "a", path: aRoot, claudeConfigDir: "/opt/claude-a" },
    ]);
    expect(configDirFor(scopes, [dir("cfg", "elsewhere")])).toEqual({
      dir: null,
      scope: null,
      conflict: [],
    });
    expect(configDirFor(scopes, [])).toEqual({
      dir: null,
      scope: null,
      conflict: [],
    });
  });

  it("returns the dir of the one matching scope", () => {
    const scopes = scopesFor([
      { name: "a", path: aRoot, claudeConfigDir: "/opt/claude-a" },
      { name: "b", path: bRoot, claudeConfigDir: "/opt/claude-b" },
    ]);
    expect(configDirFor(scopes, [path.join(aRoot, "repo")])).toEqual({
      dir: "/opt/claude-a",
      scope: "a",
      conflict: [],
    });
  });

  it("ignores matching scopes that set no claudeConfigDir", () => {
    const scopes = scopesFor([
      { name: "plain", path: noProfile },
      { name: "a", path: aRoot, claudeConfigDir: "/opt/claude-a" },
    ]);
    expect(configDirFor(scopes, [noProfile])).toEqual({
      dir: null,
      scope: null,
      conflict: [],
    });
  });

  it("is not a conflict when two scopes share a dir", () => {
    const scopes = scopesFor([
      { name: "b", path: bRoot, claudeConfigDir: "/opt/shared" },
      { name: "a", path: aRoot, claudeConfigDir: "/opt/shared" },
    ]);
    expect(configDirFor(scopes, [aRoot, bRoot])).toEqual({
      dir: "/opt/shared",
      scope: "a",
      conflict: [],
    });
  });

  it("picks by scope name and reports the others when dirs differ", () => {
    const scopes = scopesFor([
      { name: "b", path: bRoot, claudeConfigDir: "/opt/claude-b" },
      { name: "a", path: aRoot, claudeConfigDir: "/opt/claude-a" },
    ]);
    const expected = { dir: "/opt/claude-a", scope: "a", conflict: ["b"] };
    expect(configDirFor(scopes, [aRoot, bRoot])).toEqual(expected);
    expect(configDirFor(scopes, [bRoot, aRoot])).toEqual(expected);
  });
});
