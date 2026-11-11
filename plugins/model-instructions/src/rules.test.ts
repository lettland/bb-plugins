import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  claimants,
  claimedSkills,
  compose,
  fullLength,
  INSTRUCTIONS_LIMIT,
  matchRules,
  omittedNotice,
  parseConfig,
  resolve,
  ruleLabel,
  unresolvedRefs,
  type Target,
} from "./rules.js";
import type { Scope } from "./paths.js";

const tmp = realpathSync(mkdtempSync(path.join(tmpdir(), "model-instructions-rules-")));
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function dir(...parts: string[]): string {
  const p = path.join(tmp, ...parts);
  mkdirSync(p, { recursive: true });
  return p;
}

const base: Target = {
  provider: "claude-code",
  model: "claude-opus-5-5",
  project: "bb-plugins",
  parentThreadId: null,
  title: null,
  candidatePaths: [],
};

const rulesOf = (rules: unknown[]) => parseConfig(JSON.stringify(rules)).rules;
const x = (length: number) => "x".repeat(length);

describe("parseConfig: object form", () => {
  it("accepts the object form without vars, and defaults vars to none", () => {
    const config = parseConfig('{"rules": [{"instructions": "plain"}]}');
    expect(config.rules).toHaveLength(1);
    expect(config.scopes).toEqual([]);
  });

  it("still rejects an unknown {{name}} when there are no vars", () => {
    expect(() => parseConfig('{"rules": [{"instructions": "{{nope}}"}]}')).toThrow(
      "rules[0]: unknown variable {{nope}}",
    );
  });

  it("accepts vars, scopes and rules together", () => {
    const config = parseConfig(
      JSON.stringify({
        vars: { a: "A" },
        scopes: [{ name: "work", paths: ["~/work", "/abs"] }],
        rules: [{ name: "r", scope: "work", instructions: "{{a}}" }],
      }),
    );
    expect(config.scopes).toEqual([{ name: "work", paths: ["~/work", "/abs"] }]);
    expect(config.rules[0]).toMatchObject({ name: "r", scope: ["work"], instructions: "A" });
  });

  it("keeps the array form unchanged: no scopes, no substitution", () => {
    const config = parseConfig(JSON.stringify([{ instructions: "{{a}} stays" }]));
    expect(config).toEqual({
      scopes: [],
      rules: [{ threads: "any", instructions: "{{a}} stays" }],
    });
  });

  it.each([
    ['{"rules": [], "extra": 1}', "Unrecognized key"],
    ['{"rules": [], "profiles": []}', "Unrecognized key"],
    ['{"scopes": []}', "at rules"],
    ['{"scopes": null, "rules": []}', "at scopes"],
    ['{"scopes": {}, "rules": []}', "at scopes"],
  ])("rejects %s", (json, message) => {
    expect(() => parseConfig(json)).toThrow(message);
  });
});

describe("parseConfig: scopes", () => {
  const scope = (over: Record<string, unknown> = {}) =>
    JSON.stringify({ scopes: [{ name: "work", paths: ["/a"], ...over }], rules: [] });

  it("accepts absolute and ~/ paths and trims the name and the paths", () => {
    const [parsed] = parseConfig(scope({ name: "  work  ", paths: [" /a ", "~/b", "~/"] })).scopes;
    expect(parsed).toEqual({ name: "work", paths: ["/a", "~/b", "~/"] });
  });

  it.each([
    ["an empty name", { name: "" }, "name"],
    ["a blank name", { name: "   " }, "name"],
    ["a name of 129 characters", { name: "n".repeat(129) }, "name"],
    ["a non-string name", { name: 5 }, "name"],
    ["a missing paths list", { paths: undefined }, "paths"],
    ["an empty paths list", { paths: [] }, "paths"],
    ["17 paths", { paths: Array.from({ length: 17 }, (_, i) => `/p${i}`) }, "paths"],
    ["a relative path", { paths: ["src/work"] }, 'absolute path or a path starting with "~/"'],
    ["a bare tilde", { paths: ["~"] }, 'absolute path or a path starting with "~/"'],
    ["a ~user path", { paths: ["~x/y"] }, 'absolute path or a path starting with "~/"'],
    ["an empty path", { paths: [""] }, "absolute path"],
    ["a path of 1025 characters", { paths: [`/${"p".repeat(1024)}`] }, "paths"],
    ["an unknown key", { claudeConfigDir: "/x" }, "Unrecognized key"],
  ])("rejects %s", (_label, over, message) => {
    expect(() => parseConfig(scope(over))).toThrow(message);
  });

  it.each(["a\nb", "a\u0000b", "a\u007fb", "a\u0085b", "a b", "a\tb"])(
    "rejects the control character in the name %j",
    (name) => {
      expect(() => parseConfig(scope({ name }))).toThrow("the name must not contain control characters");
    },
  );

  it("accepts a name with a space, non-ASCII letters, and exactly 128 characters", () => {
    expect(parseConfig(scope({ name: "Darbs ēka" })).scopes[0].name).toBe("Darbs ēka");
    expect(parseConfig(scope({ name: "n".repeat(128) })).scopes[0].name).toHaveLength(128);
  });

  it("accepts a path of exactly 1024 characters and 16 paths", () => {
    const long = `/${"p".repeat(1023)}`;
    expect(parseConfig(scope({ paths: [long] })).scopes[0].paths[0]).toHaveLength(1024);
    const sixteen = Array.from({ length: 16 }, (_, i) => `/p${i}`);
    expect(parseConfig(scope({ paths: sixteen })).scopes[0].paths).toHaveLength(16);
  });

  it("accepts 32 scopes and rejects 33", () => {
    const many = (count: number) =>
      JSON.stringify({
        scopes: Array.from({ length: count }, (_, i) => ({ name: `s${i}`, paths: ["/a"] })),
        rules: [],
      });
    expect(parseConfig(many(32)).scopes).toHaveLength(32);
    expect(() => parseConfig(many(33))).toThrow("scopes");
  });

  it("rejects a name used twice, naming it and where", () => {
    const json = JSON.stringify({
      scopes: [
        { name: "a", paths: ["/a"] },
        { name: "b", paths: ["/b"] },
        { name: "a", paths: ["/c"] },
      ],
      rules: [],
    });
    expect(() => parseConfig(json)).toThrow('the scope name "a" is used twice');
    expect(() => parseConfig(json)).toThrow("scopes[2].name");
  });
});

describe("parseConfig: rule names", () => {
  const named = (...names: Array<string | undefined>) =>
    names.map((name) => ({ name, instructions: "x" }));

  it("rejects a rule name used twice, in both forms, naming it and where", () => {
    const rules = named("a", "b", "a");
    for (const json of [JSON.stringify(rules), JSON.stringify({ rules })]) {
      expect(() => parseConfig(json)).toThrow('the rule name "a" is used twice');
      expect(() => parseConfig(json)).toThrow("[2].name");
    }
  });

  it("accepts distinct names, and any number of unnamed rules", () => {
    expect(parseConfig(JSON.stringify(named("a", "b", "c"))).rules).toHaveLength(3);
    expect(parseConfig(JSON.stringify(named(undefined, undefined, "a"))).rules).toHaveLength(3);
    expect(parseConfig(JSON.stringify({ rules: named("a", "b") })).rules).toHaveLength(2);
  });

  it("compares names after trimming", () => {
    expect(() => parseConfig(JSON.stringify(named("a", " a ")))).toThrow("is used twice");
  });
});

describe("parseConfig: rule fields", () => {
  it("accepts a skills-only rule, an instructions-only rule and both", () => {
    expect(() => rulesOf([{ skills: "a-*" }])).not.toThrow();
    expect(() => rulesOf([{ instructions: "x" }])).not.toThrow();
    expect(() => rulesOf([{ skills: ["a", "b"], instructions: "x" }])).not.toThrow();
  });

  it("rejects a rule with neither instructions nor skills", () => {
    expect(() => rulesOf([{ provider: "claude-code" }])).toThrow(
      'a rule needs "instructions", "skills", or both',
    );
    expect(() => rulesOf([{}])).toThrow('a rule needs "instructions"');
  });

  it.each([
    ['[{"name": ""}]', "name"],
    ['[{"name": "n", "instructions": "x", "scope": []}]', "scope"],
    ['[{"name": "n", "instructions": "x", "scope": " "}]', "scope"],
    ['[{"instructions": "x", "scope": 5}]', "expected a glob or an array of globs"],
    ['[{"instructions": "x", "skills": []}]', "skills"],
    ['[{"instructions": "x", "skills": [""]}]', "skills"],
    ['[{"instructions": "x", "skills": 5}]', "expected a glob or an array of globs"],
    ['[{"skills": "a", "instructions": ""}]', "instructions"],
    ['[{"skills": "a", "instructions": "  "}]', "instructions"],
    [`[{"instructions": "x", "name": "${"n".repeat(129)}"}]`, "name"],
  ])("rejects %s", (json, message) => {
    expect(() => parseConfig(json)).toThrow(message);
  });

  it("takes scope and skills as a glob or an array of globs", () => {
    const [one, many] = rulesOf([
      { scope: "work", skills: "a-*" },
      { scope: ["w-*", "x"], skills: ["a", "b-*"] },
    ]);
    expect(one).toMatchObject({ scope: ["work"], skills: ["a-*"] });
    expect(many).toMatchObject({ scope: ["w-*", "x"], skills: ["a", "b-*"] });
  });

  it("expands {{vars}} only in rules that have instructions", () => {
    const config = parseConfig(
      JSON.stringify({
        vars: { a: "A" },
        rules: [{ skills: "s" }, { instructions: "{{a}}" }],
      }),
    );
    expect(config.rules[0].instructions).toBeUndefined();
    expect(config.rules[1].instructions).toBe("A");
  });
});

describe("matching a scope", () => {
  const workRoot = dir("work");
  const labRoot = dir("lab");
  const scopes: Scope[] = [
    { name: "work", paths: [workRoot] },
    { name: "lab", paths: [labRoot] },
  ];
  const at = (...candidatePaths: string[]) => ({ ...base, candidatePaths });
  const texts = (rules: unknown[], target: Target) => resolve(rulesOf(rules), scopes, [], target).text;

  it("matches only when a scope with a matching name is active", () => {
    const rules = [{ scope: "work", instructions: "w" }];
    expect(texts(rules, at(path.join(workRoot, "repo")))).toBe("w");
    expect(texts(rules, at(labRoot))).toBeNull();
    expect(texts(rules, at())).toBeNull();
  });

  it("takes any glob of an array, matched against scope names", () => {
    const rules = [{ scope: ["la*", "nothing"], instructions: "l" }];
    expect(texts(rules, at(labRoot))).toBe("l");
    expect(texts(rules, at(workRoot))).toBeNull();
  });

  it("is satisfied by any one active scope", () => {
    const rules = [{ scope: "*", instructions: "any" }];
    expect(texts(rules, at(workRoot))).toBe("any");
    expect(texts(rules, at(labRoot, workRoot))).toBe("any");
    expect(texts(rules, at(dir("elsewhere")))).toBeNull();
  });

  it("leaves a rule without scope matching everywhere", () => {
    expect(texts([{ instructions: "all" }], at())).toBe("all");
  });

  it("still requires every other matcher", () => {
    const rules = [{ scope: "work", provider: "codex", instructions: "w" }];
    expect(texts(rules, at(workRoot))).toBeNull();
    expect(texts([{ scope: "work", skipProjects: "bb-*", instructions: "w" }], at(workRoot))).toBeNull();
  });

  it("matches the same scopes through matchRules", () => {
    const rules = rulesOf([{ instructions: "a" }, { scope: "work", instructions: "b" }]);
    expect(matchRules(rules, [], base)).toEqual([0]);
    expect(matchRules(rules, ["work"], base)).toEqual([0, 1]);
  });
});

describe("resolve: skills", () => {
  const skillNames = ["model-instructions", "work-conventions", "work-extra", "other"];
  const names = (rules: unknown[], target: Target = base, scopes: Scope[] = []) =>
    resolve(rulesOf(rules), scopes, skillNames, target).skills;

  it("injects only model-instructions with the default setting", () => {
    expect(resolve([], [], skillNames, base)).toEqual({
      text: null,
      dropped: [],
      droppedLengths: [],
      skills: ["model-instructions"],
    });
  });

  it("injects model-instructions even when the bundled list lacks it", () => {
    expect(resolve([], [], [], base).skills).toEqual(["model-instructions"]);
  });

  it("injects a bundled skill that no rule claims nowhere", () => {
    expect(names([{ instructions: "x" }])).toEqual(["model-instructions"]);
  });

  it("gives the claimed skills sorted, after model-instructions", () => {
    expect(names([{ skills: ["work-extra", "other"] }, { skills: "work-conventions" }])).toEqual([
      "model-instructions",
      "other",
      "work-conventions",
      "work-extra",
    ]);
  });

  it("lists a skill once when several rules or globs claim it", () => {
    expect(
      names([{ skills: "work-*" }, { skills: ["work-conventions", "work-*"] }, { skills: "*" }]),
    ).toEqual(["model-instructions", "other", "work-conventions", "work-extra"]);
  });

  it("never adds model-instructions a second time for *", () => {
    const skills = names([{ skills: "*" }]);
    expect(skills.filter((name) => name === "model-instructions")).toHaveLength(1);
    expect(skills[0]).toBe("model-instructions");
  });

  it("never matches model-instructions by name either", () => {
    expect(names([{ skills: "model-instructions" }])).toEqual(["model-instructions"]);
    expect(names([{ skills: "model-*" }])).toEqual(["model-instructions"]);
  });

  it("claims skills only through a matching rule", () => {
    const scopes = [{ name: "work", paths: [dir("claims")] }];
    const rules = [{ scope: "work", skills: "work-*" }];
    expect(names(rules, { ...base, candidatePaths: [] }, scopes)).toEqual(["model-instructions"]);
    expect(names(rules, { ...base, candidatePaths: [dir("claims")] }, scopes)).toEqual([
      "model-instructions",
      "work-conventions",
      "work-extra",
    ]);
  });

  it("adds no text for a rule that only claims skills", () => {
    const resolved = resolve(rulesOf([{ skills: "other" }]), [], skillNames, base);
    expect(resolved.text).toBeNull();
    expect(resolved.skills).toEqual(["model-instructions", "other"]);
  });

  it("keeps a dropped rule's skills", () => {
    const resolved = resolve(
      rulesOf([{ instructions: x(3000) }, { instructions: x(1500), skills: "other" }]),
      [],
      skillNames,
      base,
    );
    expect(resolved.dropped).toEqual(["rules[1]"]);
    expect(resolved.skills).toEqual(["model-instructions", "other"]);
  });

  it("claimedSkills works on matched indexes", () => {
    const rules = rulesOf([{ skills: "other" }, { skills: "work-*" }]);
    expect(claimedSkills(rules, [1], skillNames)).toEqual(["work-conventions", "work-extra"]);
    expect(claimedSkills(rules, [], skillNames)).toEqual([]);
  });
});

describe("resolve: the character limit", () => {
  const notice = (count: number) => omittedNotice(count);
  const run = (rules: unknown[]) => resolve(rulesOf(rules), [], [], base);

  it("states the notice exactly", () => {
    expect(omittedNotice(2)).toBe(
      "[model-instructions: 2 rule(s) omitted: over the 4096-character limit; tell the user to run bb model-instructions status]",
    );
    expect(INSTRUCTIONS_LIMIT).toBe(4096);
  });

  it("keeps a text of exactly 4096 characters, separators included, uncut", () => {
    const resolved = run([{ instructions: x(2048) }, { instructions: x(2046) }]);
    expect(resolved.text).toHaveLength(4096);
    expect(resolved.text).toBe(`${x(2048)}\n\n${x(2046)}`);
    expect(resolved.dropped).toEqual([]);
  });

  it("keeps one rule of exactly 4096 characters", () => {
    const resolved = run([{ instructions: x(4096) }]);
    expect(resolved.text).toBe(x(4096));
    expect(resolved.dropped).toEqual([]);
  });

  it("drops a rule and adds the notice at 4097 characters", () => {
    const resolved = run([{ instructions: x(2048) }, { instructions: x(2047) }]);
    expect(fullLength(rulesOf([{ instructions: x(2048) }, { instructions: x(2047) }]), [0, 1])).toBe(4097);
    expect(resolved.text).toBe(`${x(2048)}\n\n${notice(1)}`);
    expect(resolved.dropped).toEqual(["rules[1]"]);
    expect(resolved.droppedLengths).toEqual([2047]);
    expect(resolved.text!.length).toBeLessThanOrEqual(4096);
  });

  it("fits kept text, separator and notice into exactly 4096 characters, and no more", () => {
    // Three rules: the notice is reserved for n = 3, and its length does not depend on the dropped count here.
    const room = 4096 - notice(3).length - 2;
    const first = x(1000);
    const second = room - 1000 - 2;
    const fits = run([{ instructions: first }, { instructions: x(second) }, { instructions: x(200) }]);
    expect(fits.dropped).toEqual(["rules[2]"]);
    expect(fits.text).toBe(`${first}\n\n${x(second)}\n\n${notice(1)}`);
    expect(fits.text).toHaveLength(4096);

    const over = run([{ instructions: first }, { instructions: x(second + 1) }, { instructions: x(200) }]);
    expect(over.dropped).toEqual(["rules[1]", "rules[2]"]);
    expect(over.text).toBe(`${first}\n\n${notice(2)}`);
    expect(over.text!.length).toBeLessThan(4096);
  });

  it("drops the first rule that does not fit and every later one, even a small one", () => {
    const resolved = run([
      { name: "guard", instructions: x(3000) },
      { name: "big", instructions: x(2000) },
      { name: "small", instructions: "tiny" },
    ]);
    expect(resolved.dropped).toEqual(["big", "small"]);
    expect(resolved.droppedLengths).toEqual([2000, 4]);
    expect(resolved.text).toBe(`${x(3000)}\n\n${notice(2)}`);
  });

  it("keeps the rules before the first one that does not fit, in order", () => {
    const resolved = run([
      { instructions: "first" },
      { instructions: "second" },
      { name: "huge", instructions: x(4090) },
    ]);
    expect(resolved.text).toBe(`first\n\nsecond\n\n${notice(1)}`);
    expect(resolved.dropped).toEqual(["huge"]);
  });

  it("ignores a skills-only rule when counting, and does not drop it", () => {
    const resolved = run([
      { instructions: x(3000) },
      { skills: "a" },
      { name: "late", instructions: x(2000) },
    ]);
    expect(resolved.dropped).toEqual(["late"]);
    expect(resolved.text).toBe(`${x(3000)}\n\n${notice(1)}`);
  });

  it("gives only the notice when the first rule does not fit", () => {
    const resolved = run([{ name: "huge", instructions: x(5000) }]);
    expect(resolved.text).toBe(notice(1));
    expect(resolved.dropped).toEqual(["huge"]);
  });

  it("reserves room for a notice that names a rule count of two digits", () => {
    const filler = Array.from({ length: 12 }, () => ({ skills: "a" }));
    const resolved = run([...filler, { instructions: x(3900) }, { instructions: x(2000) }]);
    expect(resolved.dropped).toEqual(["rules[13]"]);
    expect(resolved.text!.length).toBeLessThanOrEqual(4096);
  });

  it("labels a dropped rule by its name, else its position", () => {
    const rules = rulesOf([{ name: "named", instructions: "a" }, { instructions: "b" }]);
    expect(ruleLabel(rules[0], 0)).toBe("named");
    expect(ruleLabel(rules[1], 1)).toBe("rules[1]");
  });

  it("composes from already matched rules", () => {
    const rules = rulesOf([{ instructions: "a" }, { instructions: "b" }, { instructions: "c" }]);
    expect(compose(rules, [0, 2], []).text).toBe("a\n\nc");
    expect(compose(rules, [], []).text).toBeNull();
  });
});

describe("title monotonicity", () => {
  // matches() tests each rule on its own, and skipTitles can only remove a rule. So a titled thread
  // never gets more rules, and never more text, than the same thread without a title.
  const rules = rulesOf([
    { name: "a", instructions: x(1500) },
    { name: "b", skipTitles: ["Helpdesk: *", "*catch-up*"], instructions: x(1500) },
    { name: "c", threads: "child", skipTitles: "Helpdesk: *", instructions: x(900) },
    { name: "d", provider: "codex", skipTitles: "Other", instructions: x(700) },
    { name: "e", skills: "s", skipTitles: "*" },
    { name: "f", model: "claude-*", instructions: x(400) },
  ]);
  const titles = ["Helpdesk: Anna", "Helpdesk catch-up 3", "Other", "Fix the bug", "", null, "helpdesk: x"];

  it.each([
    ["claude-code", null],
    ["claude-code", "parent-1"],
    ["codex", null],
    ["codex", "parent-1"],
  ])("never adds rules or text for a title (%s, parent %s)", (provider, parentThreadId) => {
    const target = { ...base, provider, parentThreadId };
    const without = matchRules(rules, [], { ...target, title: null });
    for (const title of titles) {
      const withTitle = matchRules(rules, [], { ...target, title });
      expect(withTitle.every((index) => without.includes(index))).toBe(true);
      expect(withTitle).toEqual(without.filter((index) => withTitle.includes(index)));
      expect(fullLength(rules, withTitle)).toBeLessThanOrEqual(fullLength(rules, without));
    }
  });

  it("holds when the rule a title skips is the first rule", () => {
    const first = rulesOf([
      { name: "first", skipTitles: "Helpdesk: *", instructions: x(1500) },
      { name: "second", instructions: x(1000) },
      { name: "third", threads: "child", instructions: x(500) },
    ]);
    for (const parentThreadId of [null, "parent-1"]) {
      const target = { ...base, parentThreadId };
      const without = matchRules(first, [], { ...target, title: null });
      const skipped = matchRules(first, [], { ...target, title: "Helpdesk: Anna" });
      expect(without[0]).toBe(0);
      expect(skipped).not.toContain(0);
      expect(skipped.every((index) => without.includes(index))).toBe(true);
      expect(fullLength(first, skipped)).toBeLessThan(fullLength(first, without));
      const unskipped = matchRules(first, [], { ...target, title: "Fix the bug" });
      expect(unskipped).toEqual(without);
      expect(fullLength(first, unskipped)).toBe(fullLength(first, without));
    }
  });

  it("shortens the text when the title skips a rule", () => {
    const target = { ...base, parentThreadId: "parent-1" };
    const plain = resolve(rules, [], [], target).text!;
    const skipped = resolve(rules, [], [], { ...target, title: "Helpdesk: Anna" }).text!;
    expect(skipped.length).toBeLessThan(plain.length);
  });
});

describe("unresolvedRefs and claimants", () => {
  const rules = rulesOf([
    { scope: ["work", "typo"], skills: ["a-*", "nothing"] },
    { instructions: "x" },
    { scope: "w*", skills: "model-instructions" },
  ]);

  it("lists the scope and skills globs that match nothing", () => {
    expect(unresolvedRefs(rules, ["work"], ["model-instructions", "a-one"])).toEqual([
      { index: 0, kind: "scope", glob: "typo" },
      { index: 0, kind: "skills", glob: "nothing" },
      { index: 2, kind: "skills", glob: "model-instructions" },
    ]);
  });

  it("lists nothing when every reference resolves", () => {
    expect(unresolvedRefs(rulesOf([{ instructions: "x" }]), [], [])).toEqual([]);
  });

  it("names the rules that claim a skill", () => {
    expect(claimants(rules, "a-one")).toEqual([0]);
    expect(claimants(rules, "b")).toEqual([]);
    expect(claimants(rules, "model-instructions")).toEqual([]);
  });
});
