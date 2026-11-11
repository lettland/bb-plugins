import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { snapshotOf } from "./cache-fixture.js";
import type { CacheSnapshot } from "./projects.js";
import { createRulesSettingSchema, type SettingsEnv } from "./settings.js";

const tmp = realpathSync(mkdtempSync(path.join(tmpdir(), "model-instructions-settings-")));
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const x = (length: number) => "x".repeat(length);

function env(over: Partial<SettingsEnv> & { snapshot?: CacheSnapshot } = {}): SettingsEnv {
  const { snapshot = snapshotOf([["claude-code", ["opus"]]], [["p", []]]), ...rest } = over;
  return {
    skillNames: () => ["model-instructions", "work-conventions", "other"],
    scopesFor: (own) => own,
    caches: () => snapshot,
    ...rest,
  };
}

/** The error message the schema gives for a value, or null when the value is accepted. */
function check(value: unknown, over: Parameters<typeof env>[0] = {}): string | null {
  const result = createRulesSettingSchema(env(over)).safeParse(
    typeof value === "string" ? value : JSON.stringify(value),
  );
  return result.success ? null : result.error.issues.map((issue) => issue.message).join("\n");
}

describe("structural checks", () => {
  it("rejects what parseConfig rejects, with its message", () => {
    expect(check("not json")).toContain("not valid JSON");
    expect(check([{}])).toContain('a rule needs "instructions", "skills", or both');
  });

  it("accepts the default value even when nothing is cached yet", () => {
    const unloaded = snapshotOf([], [], { providers: { loaded: false }, projects: { loaded: false } });
    expect(check("[]", { snapshot: unloaded })).toBeNull();
  });
});

describe("references", () => {
  it("rejects a scope glob that matches no defined scope, naming the rule", () => {
    expect(check([{ name: "gchat", scope: "work", instructions: "x" }])).toBe(
      'gchat: scope "work" matches no defined scope',
    );
    expect(
      check({ scopes: [{ name: "lab", paths: ["/lab"] }], rules: [{ scope: ["lab", "wrk"], instructions: "x" }] }),
    ).toBe('rules[0]: scope "wrk" matches no defined scope');
  });

  it("accepts scope globs that match a defined scope", () => {
    const scopes = [{ name: "work-repos", paths: ["/work"] }];
    expect(check({ scopes, rules: [{ scope: "work-*", instructions: "x" }] })).toBeNull();
    expect(check({ scopes, rules: [{ scope: ["work-repos"], instructions: "x" }] })).toBeNull();
  });

  it("takes the scopes from the environment's source as well", () => {
    const value = [{ scope: "from-file", instructions: "x" }];
    expect(check(value)).toContain('scope "from-file" matches no defined scope');
    expect(
      check(value, { scopesFor: (own) => [...own, { name: "from-file", paths: ["/f"] }] }),
    ).toBeNull();
  });

  it("rejects a skills glob that matches no bundled skill", () => {
    expect(check([{ skills: "typo-*" }])).toBe('rules[0]: skills "typo-*" matches no bundled skill');
    expect(check([{ name: "r", skills: ["work-conventions", "nope"] }])).toBe(
      'r: skills "nope" matches no bundled skill',
    );
  });

  it("accepts skills globs that match a bundled skill", () => {
    expect(check([{ skills: "work-*" }])).toBeNull();
    expect(check([{ skills: ["other", "work-conventions"], instructions: "x" }])).toBeNull();
  });

  it("does not count model-instructions as a bundled skill to claim", () => {
    expect(check([{ skills: "model-instructions" }])).toContain("matches no bundled skill");
    expect(check([{ skills: "*" }])).toBeNull();
  });

  it("reports every unresolved reference, one per line", () => {
    expect(check([{ scope: "a", skills: "b" }, { name: "second", scope: "c", instructions: "x" }])).toBe(
      [
        'rules[0]: scope "a" matches no defined scope',
        'rules[0]: skills "b" matches no bundled skill',
        'second: scope "c" matches no defined scope',
      ].join("\n"),
    );
  });
});

describe("the length of one rule", () => {
  it("rejects a rule whose expanded instructions are over 4096 characters", () => {
    expect(check([{ name: "long", instructions: x(4097) }])).toBe(
      "long: the instructions are 4097 characters; the limit is 4096",
    );
  });

  it("measures the text after {{vars}} are expanded", () => {
    const value = { vars: { big: x(4090) }, rules: [{ instructions: "head {{big}} tail" }] };
    expect(check(value)).toBe("rules[0]: the instructions are 4100 characters; the limit is 4096");
  });

  it("accepts a rule of exactly 4096 characters", () => {
    expect(check([{ instructions: x(4096) }])).toBeNull();
  });

  it("reports it together with unresolved references", () => {
    expect(check([{ scope: "a", instructions: x(4097) }])).toBe(
      [
        'rules[0]: scope "a" matches no defined scope',
        "rules[0]: the instructions are 4097 characters; the limit is 4096",
      ].join("\n"),
    );
  });
});

describe("the budget of every known thread type", () => {
  const snapshot = snapshotOf(
    [
      ["claude-code", ["opus", "sonnet"]],
      ["codex", ["gpt"]],
    ],
    [["work-app", []], ["notes", []]],
  );

  it("accepts a setting under the limit for every thread type", () => {
    expect(check([{ instructions: x(2000) }, { threads: "child", instructions: x(2000) }], { snapshot })).toBeNull();
  });

  it("accepts a setting whose longest thread type is exactly 4096", () => {
    expect(check([{ instructions: x(2048) }, { instructions: x(2046) }], { snapshot })).toBeNull();
  });

  it("rejects a setting with an overflowing thread type, grouped by matched rules", () => {
    const message = check(
      [
        { name: "base", instructions: x(2000) },
        { name: "codex-only", provider: "codex", instructions: x(2100) },
      ],
      { snapshot },
    );
    expect(message).toBe(
      [
        "over the 4096-character limit with base, codex-only:",
        '  codex gpt top-level project "work-app": 4102',
        '  codex gpt top-level project "notes": 4102',
        "  codex gpt top-level project (none): 4102",
        '  codex gpt child project "work-app": 4102',
        '  codex gpt child project "notes": 4102',
        "  and 1 more",
      ].join("\n"),
    );
  });

  it("names a group per set of matched rules", () => {
    const message = check(
      [
        { name: "a", instructions: x(3000) },
        { name: "b", project: "notes", instructions: x(1100) },
        { name: "c", provider: "codex", instructions: x(1200) },
      ],
      { snapshot },
    )!;
    expect(message.split("\n").filter((line) => line.startsWith("over the"))).toEqual([
      "over the 4096-character limit with a, b, c:",
      "over the 4096-character limit with a, c:",
      "over the 4096-character limit with a, b:",
    ]);
  });

  it("counts a project's checkout paths so scope rules overflow only there", () => {
    const root = path.join(tmp, "scoped");
    mkdirSync(path.join(root, "repo"), { recursive: true });
    const value = {
      scopes: [{ name: "work", paths: [root] }],
      rules: [{ name: "a", instructions: x(2500) }, { name: "w", scope: "work", instructions: x(2500) }],
    };
    const inside = snapshotOf([["a", ["m"]]], [["in", [path.join(root, "repo")]]]);
    expect(check(value, { snapshot: inside })).toContain('project "in"');
    const outside = snapshotOf([["a", ["m"]]], [["out", [path.join(tmp, "elsewhere")]]]);
    expect(check(value, { snapshot: outside })).toBeNull();
  });
});

describe("a cache that cannot be trusted yet", () => {
  const rule = [{ instructions: "short" }];

  it.each([
    ["the provider list was never loaded", { providers: { loaded: false } }, "provider list not loaded"],
    ["the provider list's last refresh failed", { providers: { failed: true } }, "provider list refresh failed"],
    ["the project list was never loaded", { projects: { loaded: false } }, "project list not loaded"],
    ["the project list's last refresh failed", { projects: { failed: true } }, "project list refresh failed"],
  ])("rejects a value with text when %s", (_label, state, what) => {
    const snapshot = snapshotOf([["claude-code", ["opus"]]], [["p", []]], state);
    expect(check(rule, { snapshot })).toBe(`budget not checkable yet: ${what}; retry after the next refresh (every minute), or see bb model-instructions status`);
  });

  it("rejects a value with text when no available provider's models could be listed, and accepts it when none is available", () => {
    const unchecked = [{ id: "a", reason: "auth_required" }, { id: "b", reason: "socket closed" }];
    const none = snapshotOf([], [["p", []]], { providers: { unchecked } });
    expect(check(rule, { snapshot: none })).toBe(
      "budget not checkable yet: no provider's models could be listed (a (auth_required), b (socket closed)); see bb model-instructions status",
    );
    expect(check(rule, { snapshot: snapshotOf([], [["p", []]]) })).toBeNull();
    const some = snapshotOf([["c", ["m"]]], [["p", []]], { providers: { unchecked } });
    expect(check(rule, { snapshot: some })).toBeNull();
  });

  it("does not let an empty cache pass", () => {
    const empty = snapshotOf([], [], { providers: { loaded: false }, projects: { loaded: false } });
    expect(check(rule, { snapshot: empty })).toBe("budget not checkable yet: provider list not loaded; retry after the next refresh (every minute), or see bb model-instructions status");
  });

  it("needs no cache for a setting without any instruction text", () => {
    const empty = snapshotOf([], [], { providers: { loaded: false }, projects: { loaded: false } });
    expect(check([{ skills: "other" }], { snapshot: empty })).toBeNull();
  });

  it("reports unresolved references before the cache state", () => {
    const empty = snapshotOf([], [], { providers: { loaded: false } });
    expect(check([{ scope: "nope", instructions: "x" }], { snapshot: empty })).toContain("matches no defined scope");
  });
});
