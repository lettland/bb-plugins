import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  ignoredScopeText,
  mergeScopes,
  parseProfiles,
  profileDefProblem,
  profilesFile,
  readProfiles,
  writeProfilesFile,
} from "./profiles-file.js";

const tmp = realpathSync(mkdtempSync(path.join(tmpdir(), "model-instructions-profiles-")));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const home = path.join(tmp, "home");
const entry = (over: Record<string, unknown> = {}) => ({
  name: "work",
  paths: ["~/src/acme"],
  claudeConfigDir: "~/.claude-acme",
  ...over,
});
const text = (...scopes: unknown[]) => JSON.stringify({ scopes });
const problem = (value: string) => {
  try {
    parseProfiles(value, home);
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error("expected a rejection");
};

describe("profilesFile", () => {
  it("sits under ~/.bb/model-instructions", () => {
    expect(profilesFile(home)).toBe(path.join(home, ".bb", "model-instructions", "profiles.json"));
    expect(profilesFile()).toBe(path.join(homedir(), ".bb", "model-instructions", "profiles.json"));
  });
});

describe("parseProfiles", () => {
  it("normalizes the paths and resolves the config dir", () => {
    expect(parseProfiles(text(entry(), entry({ name: "abs", claudeConfigDir: "/p/abs", paths: ["/srv/x"] })), home)).toEqual([
      { name: "work", paths: [path.join(home, "src", "acme")], claudeConfigDir: path.join(home, ".claude-acme") },
      { name: "abs", paths: ["/srv/x"], claudeConfigDir: "/p/abs" },
    ]);
  });

  it("accepts an empty list and trims names, paths and the dir", () => {
    expect(parseProfiles(text(), home)).toEqual([]);
    expect(parseProfiles(text(entry({ name: " w ", paths: [" /a "], claudeConfigDir: " /c " })), home)).toEqual([
      { name: "w", paths: ["/a"], claudeConfigDir: "/c" },
    ]);
  });

  it("rejects text that is not JSON", () => {
    expect(problem("{")).toMatch(/^not valid JSON: /);
  });

  it("rejects a wrong shape and names the field", () => {
    expect(problem("[]")).toMatch(/expected object/);
    expect(problem("{}")).toMatch(/scopes/);
    expect(problem(JSON.stringify({ scopes: [], extra: 1 }))).toMatch(/Unrecognized key/);
    expect(problem(text(entry({ skills: ["x"] })))).toMatch(/Unrecognized key: "skills"/);
    expect(problem(text({ name: "n", paths: ["/a"] }))).toMatch(/claudeConfigDir/);
  });

  it("applies the setting's name rules", () => {
    expect(problem(text(entry({ name: " " })))).toMatch(/name/);
    expect(problem(text(entry({ name: "x".repeat(129) })))).toMatch(/name/);
    expect(problem(text(entry({ name: "a\nb" })))).toMatch(/control characters/);
    expect(problem(text(entry(), entry()))).toMatch(/the scope name "work" is used twice/);
  });

  it("applies the setting's path and count rules", () => {
    expect(problem(text(entry({ paths: [] })))).toMatch(/paths/);
    expect(problem(text(entry({ paths: Array.from({ length: 17 }, (_, i) => `/p${i}`) })))).toMatch(/paths/);
    expect(problem(text(entry({ paths: ["relative"] })))).toMatch(/absolute path/);
    expect(problem(text(entry({ paths: ["/" + "x".repeat(1024)] })))).toMatch(/paths/);
    expect(problem(JSON.stringify({ scopes: Array.from({ length: 33 }, (_, i) => entry({ name: `s${i}` })) }))).toMatch(/scopes/);
  });

  it("requires an absolute or ~/ config dir that is not the home directory or a parent of it", () => {
    expect(problem(text(entry({ claudeConfigDir: "relative" })))).toMatch(/absolute path[\s\S]*claudeConfigDir/);
    for (const dir of [home, path.dirname(home), "/", "~/"]) {
      expect(problem(text(entry({ claudeConfigDir: dir })))).toMatch(/must not be your home directory or one of its parents/);
    }
    expect(parseProfiles(text(entry({ claudeConfigDir: path.join(home, ".claude-x") })), home)[0].claudeConfigDir).toBe(
      path.join(home, ".claude-x"),
    );
  });
});

describe("profileDefProblem", () => {
  it("is null for a usable scope and a message for a broken one", () => {
    expect(profileDefProblem(entry() as never, home)).toBeNull();
    expect(profileDefProblem(entry({ name: "" }) as never, home)).toMatch(/name/);
  });
});

describe("readProfiles", () => {
  const file = path.join(tmp, "read", "profiles.json");
  mkdirSync(path.dirname(file), { recursive: true });

  it("is absent only for a missing file", () => {
    expect(readProfiles(path.join(tmp, "read", "nope.json"), home)).toEqual({ state: "absent" });
  });

  it("is valid for a good file", () => {
    writeFileSync(file, text(entry()));
    expect(readProfiles(file, home)).toEqual({
      state: "valid",
      scopes: [{ name: "work", paths: [path.join(home, "src", "acme")], claudeConfigDir: path.join(home, ".claude-acme") }],
    });
  });

  it("is malformed, with the message, for broken JSON and for a validation error", () => {
    writeFileSync(file, "{");
    expect(readProfiles(file, home)).toMatchObject({ state: "malformed", message: expect.stringMatching(/^not valid JSON/) });
    writeFileSync(file, text(entry({ extra: 1 })));
    expect(readProfiles(file, home)).toMatchObject({ state: "malformed", message: expect.stringMatching(/Unrecognized key/) });
  });

  it("is malformed, never absent, for any other read error", () => {
    expect(readProfiles(path.dirname(file), home)).toMatchObject({ state: "malformed", message: expect.stringMatching(/EISDIR/) });
  });

  it("defaults the home directory", () => {
    expect(readProfiles(path.join(tmp, "read", "nope.json"))).toEqual({ state: "absent" });
  });
});

describe("writeProfilesFile", () => {
  const defs = [{ name: "work", paths: ["~/src/acme"], claudeConfigDir: "~/.claude-acme" }];
  const dir = path.join(tmp, "write");

  it("writes a private file once and never replaces it", () => {
    const target = path.join(dir, "profiles.json");
    expect(writeProfilesFile(target, defs, home)).toBe("wrote");
    expect(JSON.parse(readFileSync(target, "utf8"))).toEqual({ scopes: defs });
    expect(writeProfilesFile(target, [{ ...defs[0], name: "other" }], home)).toBe("exists");
    expect(JSON.parse(readFileSync(target, "utf8")).scopes[0].name).toBe("work");
    expect(readdirSync(dir)).toEqual(["profiles.json"]);
  });

  it("rejects a definition the reader would reject, and leaves nothing behind", () => {
    const target = path.join(tmp, "write-bad", "profiles.json");
    expect(() => writeProfilesFile(target, [{ ...defs[0], claudeConfigDir: home }], home)).toThrow(/home directory/);
    expect(readdirSync(path.dirname(target))).toEqual([]);
  });

  it("defaults the home directory", () => {
    const target = path.join(tmp, "write-default", "profiles.json");
    expect(writeProfilesFile(target, [{ name: "d", paths: ["/a"], claudeConfigDir: "/profiles/d" }])).toBe("wrote");
  });
});

describe("mergeScopes", () => {
  it("lists profile scopes first and drops a setting scope that has a profile scope's name", () => {
    const merged = mergeScopes(
      [
        { name: "work", paths: ["/elsewhere"] },
        { name: "mine", paths: ["/mine"] },
      ],
      [{ name: "work", paths: ["/w"], claudeConfigDir: "/profiles/work" }],
    );
    expect(merged).toEqual({
      scopes: [
        { name: "work", paths: ["/w"] },
        { name: "mine", paths: ["/mine"] },
      ],
      ignored: ["work"],
    });
    expect(merged.scopes[0]).not.toHaveProperty("claudeConfigDir");
  });

  it("ignores nothing when the names differ", () => {
    expect(mergeScopes([{ name: "a", paths: ["/a"] }], []).ignored).toEqual([]);
  });

  it("words the warning as status and check show it", () => {
    expect(ignoredScopeText("work")).toBe(
      'ignored saved scope "work": a profile scope with that name comes from profiles.json',
    );
  });
});
