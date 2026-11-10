import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  activeScopes,
  configDirFor,
  expandHome,
  loadScopes,
  parseScopes,
  parseScopesText,
  selectSkills,
  validateUiScopes,
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

describe("expandHome", () => {
  const home = "/home/test";

  it("expands a bare tilde and ~/ paths", () => {
    expect(expandHome("~", home)).toBe(home);
    expect(expandHome("~/docs", home)).toBe(path.join(home, "docs"));
  });

  it("leaves other paths alone", () => {
    expect(expandHome("/opt/x", home)).toBe("/opt/x");
    expect(expandHome("relative", home)).toBe("relative");
  });
});

describe("parseScopes", () => {
  const base = { name: "work", paths: ["/a"], skills: ["work-*"] };

  it.each<[string, string]>([
    ["an object", "{}"],
    ["an array", "[]"],
    ["null", "null"],
    ["a string", '"x"'],
  ])("rejects %s as the file root", (_label, text) => {
    fileCounter += 1;
    const file = path.join(tmp, `bad-${fileCounter}.json`);
    writeFileSync(file, text);
    expect(() => parseScopes(file)).toThrow(/expected \{ "scopes": \[\.\.\.\] \}/);
  });

  it("names a scope without a usable name by its position", () => {
    const [first, second] = parseScopes(
      scopesFile([
        { paths: ["/a"], skills: ["x-*"] },
        { name: "  ", paths: ["/b"], skills: ["x-*"] },
      ]),
    );
    expect(first.name).toBe("scope-1");
    expect(second.name).toBe("scope-2");
  });

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

  it.each([["~/"], ["/"], [homedir()], ["~/."], [path.dirname(homedir())]])(
    "rejects %s as claudeConfigDir (home or a parent of it)",
    (value) => {
      expect(() =>
        parseScopes(scopesFile([{ ...base, claudeConfigDir: value }])),
      ).toThrow(/must not be your home directory or one of its parents/);
    },
  );

  it("accepts a sibling-named dir inside home", () => {
    const [scope] = parseScopes(
      scopesFile([{ ...base, claudeConfigDir: "~/.claude-x" }]),
    );
    expect(scope.claudeConfigDir).toBe(path.join(homedir(), ".claude-x"));
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

  it("reports malformed JSON with the file as label and no fragment of the input", () => {
    fileCounter += 1;
    const file = path.join(tmp, `broken-${fileCounter}.json`);
    writeFileSync(file, '{ "scopes": [ "/private/secret-path" ');
    expect(() => parseScopes(file)).toThrow(new Error(`${file}: not valid JSON`));
  });
});

describe("parseScopesText", () => {
  const entry = { name: "work", paths: ["/a"], skills: ["work-*"] };
  const text = (scopes: unknown[]) => JSON.stringify({ scopes });

  it("parses text and expands ~/ paths against home", () => {
    const [scope] = parseScopesText(
      text([{ ...entry, paths: ["~/src/acme", "/b"] }]),
      "file.json",
      "/home/test",
    );
    expect(scope).toMatchObject({
      name: "work",
      paths: ["/home/test/src/acme", "/b"],
      patternSources: ["work-*"],
      claudeConfigDir: null,
    });
  });

  it("treats blank text as malformed JSON", () => {
    expect(() => parseScopesText("", "file.json", "/h")).toThrow(
      "file.json: not valid JSON",
    );
  });

  it("gives malformed JSON the label and none of the input", () => {
    const secret = "/private/secret-path";
    let message = "";
    try {
      parseScopesText(`{ "scopes": [ "${secret}" `, "file.json", "/h");
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toBe("file.json: not valid JSON");
    expect(message).not.toContain(secret);
  });

  it("accepts claudeConfigDir and a relative path in a file", () => {
    expect(
      parseScopesText(
        text([{ ...entry, paths: ["/a", "src/acme"], claudeConfigDir: "/opt/claude" }]),
        "file.json",
        "/h",
      )[0].claudeConfigDir,
    ).toBe("/opt/claude");
  });

  it("keeps the shared validation", () => {
    expect(() =>
      parseScopesText(text([{ name: "work", skills: ["x"] }]), "file.json", "/h"),
    ).toThrow('file.json: scope "work" needs a non-empty "paths"');
    expect(() => parseScopesText("{}", "file.json", "/h")).toThrow(
      'file.json: expected { "scopes": [...] }',
    );
  });
});

describe("validateUiScopes", () => {
  const entry = { name: "docs", paths: ["/a"], skills: ["docs-*"] };

  it("accepts a good scope and gives it no Claude profile", () => {
    const [scope] = validateUiScopes([entry], "/home/test");
    expect(scope).toMatchObject({
      name: "docs",
      paths: ["/a"],
      patternSources: ["docs-*"],
      claudeConfigDir: null,
    });
    expect(scope.patterns[0].test("docs-style")).toBe(true);
  });

  it("returns no scopes for an empty list", () => {
    expect(validateUiScopes([], "/h")).toEqual([]);
  });

  it("trims names, paths and skills and expands ~/ against home", () => {
    const [scope] = validateUiScopes(
      [{ name: "  work ", paths: [" ~/x ", " /b "], skills: [" w-* ", " one "] }],
      "/home/test",
    );
    expect(scope.name).toBe("work");
    expect(scope.paths).toEqual(["/home/test/x", "/b"]);
    expect(scope.patternSources).toEqual(["w-*", "one"]);
  });

  it("rejects a name that collides with another after trimming, and accepts distinct names", () => {
    expect(() =>
      validateUiScopes(
        [
          { ...entry, name: "work" },
          { ...entry, name: "work " },
        ],
        "/h",
      ),
    ).toThrow('scope "work": the name is used twice');
    expect(
      validateUiScopes(
        [
          { ...entry, name: "work" },
          { ...entry, name: "work2" },
        ],
        "/h",
      ),
    ).toHaveLength(2);
  });

  it.each(["", "   "])("rejects the empty name %j and names its position", (name) => {
    expect(() => validateUiScopes([entry, { ...entry, name }], "/h")).toThrow(
      "scope 2 needs a name",
    );
  });

  it.each(["a\nb", "a\u0000b", "a\u007fb", "a\u0085b", "a\u2028b", "a\tb"])(
    "rejects the control character in the name %j",
    (name) => {
      expect(() => validateUiScopes([{ ...entry, name }], "/h")).toThrow(
        /the name must not contain control characters/,
      );
    },
  );

  it("accepts a name with a space and non-ASCII letters", () => {
    expect(validateUiScopes([{ ...entry, name: "my docs ä" }], "/h")[0].name).toBe(
      "my docs ä",
    );
  });

  it.each([[[]], [[""]], [["  "]], [["/a", ""]]])(
    "rejects the paths %j",
    (paths) => {
      expect(() => validateUiScopes([{ ...entry, paths }], "/h")).toThrow(
        'scope "docs" needs at least one directory, none of them empty',
      );
    },
  );

  it.each(["~", "./src", "src/acme", "~x/y"])("rejects the relative path %j", (p) => {
    expect(() => validateUiScopes([{ ...entry, paths: ["/a", p] }], "/h")).toThrow(
      'scope "docs": every directory must be absolute or start with "~/"',
    );
  });

  it.each([[[]], [[""]], [["x", "  "]]])("rejects the skills %j", (skills) => {
    expect(() => validateUiScopes([{ ...entry, skills }], "/h")).toThrow(
      'scope "docs" needs at least one skill or pattern, none of them empty',
    );
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

  describe("with UI scopes", () => {
    const uiEntry = (over: Record<string, unknown> = {}) => ({
      name: "work",
      paths: ["/from-ui"],
      skills: ["ui-*"],
      ...over,
    });
    const uiScopes = (...entries: ReturnType<typeof uiEntry>[]) =>
      validateUiScopes(entries as never);
    const layers = (name: string) => {
      const root = dir(name);
      writeFileSync(
        path.join(root, "scopes.json"),
        JSON.stringify({
          scopes: [{ name: "work", paths: ["/shipped"], skills: ["work-*"] }],
        }),
      );
      return root;
    };

    it("ignores a UI scope named like a file scope with a profile and reports the name", () => {
      const root = layers("ui-profiled");
      const userFile = scopesFile([
        {
          name: "work",
          paths: ["/mine"],
          skills: ["work-*"],
          claudeConfigDir: "/opt/claude",
        },
      ]);
      const skipped: string[] = [];
      const scopes = loadScopes(
        root,
        userFile,
        undefined,
        uiScopes(uiEntry()),
        (name) => skipped.push(name),
      );
      expect(skipped).toEqual(["work"]);
      expect(scopes).toHaveLength(1);
      expect(scopes[0].paths).toEqual(["/mine"]);
      expect(scopes[0].patternSources).toEqual(["work-*"]);
      expect(scopes[0].claudeConfigDir).toBe("/opt/claude");
    });

    it("ignores a profiled scope silently when no callback is given", () => {
      const root = layers("ui-profiled-silent");
      const userFile = scopesFile([
        {
          name: "work",
          paths: ["/mine"],
          skills: ["work-*"],
          claudeConfigDir: "/opt/claude",
        },
      ]);
      const scopes = loadScopes(root, userFile, undefined, uiScopes(uiEntry()));
      expect(scopes.map((s) => [s.paths, s.claudeConfigDir])).toEqual([
        [["/mine"], "/opt/claude"],
      ]);
    });

    it("replaces a file scope that has no profile", () => {
      const root = layers("ui-file-plain");
      const userFile = scopesFile([
        { name: "work", paths: ["/mine"], skills: ["work-*"] },
      ]);
      const skipped: string[] = [];
      const scopes = loadScopes(
        root,
        userFile,
        undefined,
        uiScopes(uiEntry()),
        (name) => skipped.push(name),
      );
      expect(skipped).toEqual([]);
      expect(scopes).toHaveLength(1);
      expect(scopes[0].paths).toEqual(["/from-ui"]);
      expect(scopes[0].patternSources).toEqual(["ui-*"]);
      expect(scopes[0].claudeConfigDir).toBeNull();
    });

    it("replaces a shipped scope that has no profile", () => {
      const root = layers("ui-shipped");
      const skipped: string[] = [];
      const scopes = loadScopes(
        root,
        path.join(tmp, "absent.json"),
        undefined,
        uiScopes(uiEntry()),
        (name) => skipped.push(name),
      );
      expect(skipped).toEqual([]);
      expect(scopes.map((s) => [s.name, s.paths, s.claudeConfigDir])).toEqual([
        ["work", ["/from-ui"], null],
      ]);
    });

    it("adds a UI scope with a new name", () => {
      const root = layers("ui-new");
      const scopes = loadScopes(
        root,
        path.join(tmp, "absent.json"),
        undefined,
        uiScopes(uiEntry({ name: "extra" })),
      );
      expect(scopes.map((s) => s.name)).toEqual(["work", "extra"]);
      expect(scopes[0].paths).toEqual(["/shipped"]);
      expect(scopes[1].claudeConfigDir).toBeNull();
    });

    it("adds nothing for an empty list", () => {
      const root = layers("ui-empty");
      const scopes = loadScopes(root, path.join(tmp, "absent.json"), undefined, []);
      expect(scopes.map((s) => s.paths)).toEqual([["/shipped"]]);
    });
  });

  describe("file scope sources", () => {
    const sources = (root: string, userFile: string) => {
      const seen: Array<[string, string, string[]]> = [];
      loadScopes(root, userFile, undefined, [], undefined, (scope, source) =>
        seen.push([scope.name, source, scope.paths]),
      );
      return seen;
    };
    const shipped = (name: string) => {
      const root = dir(name);
      writeFileSync(
        path.join(root, "scopes.json"),
        JSON.stringify({
          scopes: [
            { name: "work", paths: ["/shipped"], skills: ["work-*"] },
            { name: "other", paths: ["/other"], skills: ["o-*"] },
          ],
        }),
      );
      return root;
    };

    it("reports every shipped scope as shipped without a user file", () => {
      expect(sources(shipped("src-shipped"), path.join(tmp, "absent.json"))).toEqual([
        ["work", "shipped", ["/shipped"]],
        ["other", "shipped", ["/other"]],
      ]);
    });

    it("reports a user scope that replaces a shipped one of the same name as file, once", () => {
      const userFile = scopesFile([
        { name: "work", paths: ["/mine"], skills: ["work-*"] },
        { name: "extra", paths: ["/extra"], skills: ["e-*"] },
      ]);
      expect(sources(shipped("src-replaced"), userFile)).toEqual([
        ["work", "file", ["/mine"]],
        ["other", "shipped", ["/other"]],
        ["extra", "file", ["/extra"]],
      ]);
    });

    it("reports the file scopes before the UI layer is applied", () => {
      const root = shipped("src-before-ui");
      const seen: string[] = [];
      loadScopes(
        root,
        path.join(tmp, "absent.json"),
        undefined,
        validateUiScopes([{ name: "work", paths: ["/ui"], skills: ["u-*"] }]),
        undefined,
        (scope) => seen.push(`${scope.name}:${scope.paths[0]}`),
      );
      expect(seen).toEqual(["work:/shipped", "other:/other"]);
    });
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

  it("sorts by name regardless of the input order", () => {
    const scopes = [
      { name: "b", paths: [bRoot], patterns: [], patternSources: [], claudeConfigDir: "/opt/claude-b" },
      { name: "a", paths: [aRoot], patterns: [], patternSources: [], claudeConfigDir: "/opt/claude-a" },
    ];
    const expected = { dir: "/opt/claude-a", scope: "a", conflict: ["b"] };
    expect(configDirFor([...scopes].reverse(), [aRoot, bRoot])).toEqual(expected);
    expect(configDirFor(scopes, [aRoot, bRoot])).toEqual(expected);
  });

  it("treats same-named scopes as equal when sorting", () => {
    const twin = (dir: string) => ({
      name: "a",
      paths: ["/t"],
      patterns: [],
      patternSources: [],
      claudeConfigDir: dir,
    });
    expect(configDirFor([twin("/opt/one"), twin("/opt/one")], ["/t"])).toEqual({
      dir: "/opt/one",
      scope: "a",
      conflict: [],
    });
  });
});
