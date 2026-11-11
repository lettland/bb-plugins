import { describe, expect, it, vi } from "vitest";
import {
  createFakePluginHost,
  makePluginAgentConfigurationContext,
} from "@get-bb/plugin-sdk/testing";
import plugin from "./server.js";
import { parseRules, resolveInstructions } from "./src/rules.js";
import { createRulesSettingSchema } from "./src/settings.js";

const SUPERVISOR = {
  provider: "claude-code",
  model: "claude-opus-5-5*",
  threads: "top-level",
  instructions: ["Plan and supervise.", "Spawn Sonnet workers to implement."],
};
const WORKER = { model: "claude-sonnet-*", threads: "child", instructions: "Implement the brief." };
const EVERYONE = { instructions: "Be terse." };

function target(
  model: string,
  parentThreadId: string | null = null,
  provider = "claude-code",
  project = "bb-plugins",
  title: string | null = null,
) {
  return { provider, model, project, parentThreadId, title };
}

describe("resolveInstructions", () => {
  const rules = parseRules(JSON.stringify([SUPERVISOR, WORKER, EVERYONE]));

  it("joins every matching rule in order", () => {
    expect(resolveInstructions(rules, target("claude-opus-5-5"))).toBe(
      "Plan and supervise.\nSpawn Sonnet workers to implement.\n\nBe terse.",
    );
    expect(resolveInstructions(rules, target("claude-sonnet-5-5", "parent-1"))).toBe(
      "Implement the brief.\n\nBe terse.",
    );
  });

  it("matches a model suffix through the glob", () => {
    expect(resolveInstructions(rules, target("claude-opus-5-5[1m]"))).toContain("Plan and supervise.");
  });

  it("honours the thread scope", () => {
    expect(resolveInstructions(rules, target("claude-opus-5-5", "parent-1"))).toBe("Be terse.");
    expect(resolveInstructions(rules, target("claude-sonnet-5-5"))).toBe("Be terse.");
  });

  it("filters by provider", () => {
    expect(resolveInstructions(rules, target("claude-opus-5-5", null, "codex"))).toBe("Be terse.");
  });

  it("filters by project name", () => {
    const [rule] = parseRules(JSON.stringify([{ project: "bb-*", instructions: "x" }]));
    expect(resolveInstructions([rule], target("claude-opus-5-5"))).toBe("x");
    expect(resolveInstructions([rule], target("claude-opus-5-5", null, "claude-code", "opshub"))).toBeNull();
  });

  it("accepts an array of project globs, any of which may match", () => {
    const [rule] = parseRules(JSON.stringify([{ project: ["opshub-*", "bb-*"], instructions: "x" }]));
    expect(resolveInstructions([rule], target("claude-opus-5-5"))).toBe("x");
    expect(resolveInstructions([rule], target("claude-opus-5-5", null, "claude-code", "opshub-web"))).toBe("x");
    expect(resolveInstructions([rule], target("claude-opus-5-5", null, "claude-code", "other"))).toBeNull();
  });

  it("skips projects given as a string or an array", () => {
    const [asString] = parseRules(JSON.stringify([{ skipProjects: "bb-*", instructions: "x" }]));
    expect(resolveInstructions([asString], target("claude-opus-5-5"))).toBeNull();
    expect(resolveInstructions([asString], target("claude-opus-5-5", null, "claude-code", "opshub"))).toBe("x");
    const [asArray] = parseRules(JSON.stringify([{ skipProjects: ["bb-*", "legacy"], instructions: "x" }]));
    expect(resolveInstructions([asArray], target("claude-opus-5-5"))).toBeNull();
    expect(resolveInstructions([asArray], target("claude-opus-5-5", null, "claude-code", "legacy"))).toBeNull();
    expect(resolveInstructions([asArray], target("claude-opus-5-5", null, "claude-code", "opshub"))).toBe("x");
  });

  it("lets skipProjects win over project", () => {
    const [rule] = parseRules(
      JSON.stringify([{ project: ["opshub-*", "bb-*"], skipProjects: "opshub-legacy", instructions: "x" }]),
    );
    expect(resolveInstructions([rule], target("claude-opus-5-5", null, "claude-code", "opshub-web"))).toBe("x");
    expect(resolveInstructions([rule], target("claude-opus-5-5", null, "claude-code", "opshub-legacy"))).toBeNull();
    expect(resolveInstructions([rule], target("claude-opus-5-5", null, "claude-code", "other"))).toBeNull();
  });

  it("skips a project regardless of thread scope", () => {
    const [topLevel, child] = parseRules(
      JSON.stringify([
        { skipProjects: "bb-*", threads: "top-level", instructions: "x" },
        { skipProjects: "bb-*", threads: "child", instructions: "y" },
      ]),
    );
    expect(resolveInstructions([topLevel], target("claude-opus-5-5"))).toBeNull();
    expect(resolveInstructions([child], target("claude-opus-5-5", "parent-1"))).toBeNull();
    expect(resolveInstructions([topLevel], target("claude-opus-5-5", null, "claude-code", "opshub"))).toBe("x");
    expect(resolveInstructions([child], target("claude-opus-5-5", "parent-1", "claude-code", "opshub"))).toBe("y");
  });

  it("skips a thread whose title matches a skipTitles glob", () => {
    const [rule] = parseRules(
      JSON.stringify([
        { threads: "child", skipTitles: ["Helpdesk: *", "Helpdesk catch-up *"], instructions: "x" },
      ]),
    );
    const resolve = (title: string | null) =>
      resolveInstructions([rule], target("claude-opus-5-5", "parent-1", "claude-code", "bb-plugins", title));
    expect(resolve("Helpdesk: Anna 09:14")).toBeNull();
    expect(resolve("Helpdesk catch-up 2026-11-10 (3)")).toBeNull();
    expect(resolve("Helpdesk")).toBe("x");
    expect(resolve("Fix the login bug")).toBe("x");
    expect(resolve("helpdesk: Anna 09:14")).toBe("x");
    expect(resolve(null)).toBe("x");
    expect(resolve("")).toBe("x");
  });

  it("accepts skipTitles as a single glob string", () => {
    const [rule] = parseRules(JSON.stringify([{ skipTitles: "Helpdesk: *", instructions: "x" }]));
    expect(resolveInstructions([rule], target("m", null, "claude-code", "p", "Helpdesk: Bob 10:00"))).toBeNull();
    expect(resolveInstructions([rule], target("m", null, "claude-code", "p", "Other"))).toBe("x");
  });

  it("leaves a rule without skipTitles unchanged for any title", () => {
    const [rule] = parseRules(JSON.stringify([{ threads: "child", instructions: "x" }]));
    for (const title of ["Helpdesk: Anna 09:14", "Other", "", null])
      expect(resolveInstructions([rule], target("m", "parent-1", "claude-code", "p", title))).toBe("x");
  });

  it("applies skipTitles only on top of the other filters", () => {
    const [rule] = parseRules(
      JSON.stringify([{ threads: "child", skipTitles: "Helpdesk: *", instructions: "x" }]),
    );
    expect(resolveInstructions([rule], target("m", null, "claude-code", "p", "Other"))).toBeNull();
    expect(resolveInstructions([rule], target("m", "parent-1", "claude-code", "p", "Other"))).toBe("x");
  });

  it("requires every filter to match alongside the project", () => {
    const [rule] = parseRules(
      JSON.stringify([{ project: "bb-*", model: "claude-sonnet-*", threads: "child", instructions: "x" }]),
    );
    expect(resolveInstructions([rule], target("claude-sonnet-5", "parent-1"))).toBe("x");
    expect(resolveInstructions([rule], target("claude-sonnet-5"))).toBeNull();
    expect(resolveInstructions([rule], target("claude-opus-5-5", "parent-1"))).toBeNull();
  });

  it("treats glob metacharacters other than * literally", () => {
    const [rule] = parseRules(JSON.stringify([{ model: "gpt-5.1", instructions: "x" }]));
    expect(resolveInstructions([rule], target("gpt-5x1"))).toBeNull();
    expect(resolveInstructions([rule], target("gpt-5.1"))).toBe("x");
  });

  it("returns null when nothing matches", () => {
    expect(resolveInstructions([], target("claude-opus-5-5"))).toBeNull();
  });
});

describe("parseRules", () => {
  it.each([
    ["not json", "not valid JSON"],
    ["{}", "at rules"],
    ['[{"instructions": "  "}]', "instructions"],
    ['[{"instructions": "x", "threads": "root"}]', "threads"],
    ['[{"instructions": "x", "modle": "y"}]', "modle"],
    ['[{"instructions": "x", "project": "  "}]', "project"],
    ['[{"instructions": "x", "project": []}]', "project"],
    ['[{"instructions": "x", "skipProjects": []}]', "skipProjects"],
    ['[{"instructions": "x", "skipProjects": "  "}]', "skipProjects"],
    ['[{"instructions": "x", "project": ["bb-*", " "]}]', "project"],
    ['[{"instructions": "x", "skipProjects": [5]}]', "skipProjects"],
    ['[{"instructions": "x", "skipProjects": 5}]', "expected a glob or an array of globs"],
    ['[{"instructions": "x", "project": "bb-*", "skipProjects": []}]', "skipProjects"],
    ['[{"instructions": "x", "skipProject": "bb-*"}]', "skipProject"],
    ['[{"instructions": "x", "skipTitles": []}]', "skipTitles"],
    ['[{"instructions": "x", "skipTitles": ""}]', "skipTitles"],
    ['[{"instructions": "x", "skipTitles": "  "}]', "skipTitles"],
    ['[{"instructions": "x", "skipTitles": [""]}]', "skipTitles"],
    ['[{"instructions": "x", "skipTitles": [5]}]', "skipTitles"],
    ['[{"instructions": "x", "skipTitles": 5}]', "expected a glob or an array of globs"],
  ])("rejects %s", (json, message) => {
    expect(() => parseRules(json)).toThrow(message);
  });

  it("expands {{name}} in form B instructions", () => {
    const rules = parseRules(
      JSON.stringify({
        vars: { implSmall: "--provider glm --reasoning medium", implHeavy: "--reasoning high" },
        rules: [
          {
            threads: "top-level",
            instructions: "Small: {{implSmall}}. Heavy {{implHeavy}}. Small again: {{implSmall}}.",
          },
          { threads: "child", instructions: ["Line {{implSmall}}", "{{implHeavy}}"] },
        ],
      }),
    );
    expect(rules[0].instructions).toBe(
      "Small: --provider glm --reasoning medium. Heavy --reasoning high. Small again: --provider glm --reasoning medium.",
    );
    expect(rules[1].instructions).toBe("Line --provider glm --reasoning medium\n--reasoning high");
  });

  it.each([
    ['{"vars": {"a": "x"}, "rules": [{"instructions": "{{toString}}"}]}', "rules[0]: unknown variable {{toString}}"],
    ['{"vars": {"a": "x"}, "rules": [{"instructions": "{{nope}}"}]}', "rules[0]: unknown variable {{nope}}"],
    ['{"vars": {}, "rules": [{"instructions": "ok"}, {"instructions": "{{nope}}"}]}', "rules[1]: unknown variable {{nope}}"],
    ['{"vars": {}, "rules": [{"instructions": "{{constructor}}"}]}', "rules[0]: unknown variable {{constructor}}"],
    ['{"vars": {"1bad": "x"}, "rules": []}', "at vars.1bad"],
    ['{"vars": {"a": 5}, "rules": []}', "expected string, received number"],
    ['{"vars": {"a": "   "}, "rules": []}', "expected a non-blank string"],
    ['{"vars": {"a": ""}, "rules": []}', "expected a non-blank string"],
    // Upstream quirk (zod 4 z.record drops an own __proto__ key silently), learned in the
    // vars review of 2026-11-02 (local bb thread, id redacted); guards the loud rejection in parseRules.
    ['{"vars": {"__proto__": "x"}, "rules": []}', 'invalid variable name "__proto__" at vars'],
    ['{"vars": {"__proto__": "x", "a": "y"}, "rules": [{"instructions": "{{a}}"}]}', 'invalid variable name "__proto__" at vars'],
    ['{"vars": null, "rules": []}', "at vars"],
    ['{"vars": {}}', "at rules"],
    ['{"vars": {}, "rules": [], "extra": 1}', "Unrecognized key"],
    ["5", 'expected an array of rules or { "vars"?: {...}, "scopes"?: [...], "rules": [...] }'],
    ["null", 'expected an array of rules or { "vars"?: {...}, "scopes"?: [...], "rules": [...] }'],
    ['"x"', 'expected an array of rules or { "vars"?: {...}, "scopes"?: [...], "rules": [...] }'],
  ])("rejects form B %s", (json, message) => {
    expect(() => parseRules(json)).toThrow(message);
  });

  it("keeps {{ spaced }} text unchanged in form B", () => {
    const [rule] = parseRules(
      JSON.stringify({ vars: { a: "x" }, rules: [{ instructions: "keep {{ a }} and a lone { brace" }] }),
    );
    expect(rule.instructions).toBe("keep {{ a }} and a lone { brace");
  });

  it("inserts a var value containing {{other}} literally, without expanding it", () => {
    const [rule] = parseRules(
      JSON.stringify({ vars: { a: "{{b}} tail", b: "expanded" }, rules: [{ instructions: "{{a}}" }] }),
    );
    expect(rule.instructions).toBe("{{b}} tail");
  });

  it("inserts a var value containing $& and $1 exactly as written", () => {
    const [rule] = parseRules(
      JSON.stringify({ vars: { a: "$& $1" }, rules: [{ instructions: "[{{a}}]" }] }),
    );
    expect(rule.instructions).toBe("[$& $1]");
  });

  it("substitutes a var named constructor when declared", () => {
    const [rule] = parseRules(
      JSON.stringify({ vars: { constructor: "ctor" }, rules: [{ instructions: "{{constructor}}" }] }),
    );
    expect(rule.instructions).toBe("ctor");
  });

  it("expands var names containing _ and -", () => {
    const [rule] = parseRules(
      JSON.stringify({
        vars: { impl_small: "small", "impl-heavy": "heavy" },
        rules: [{ instructions: "{{impl_small}} {{impl-heavy}}" }],
      }),
    );
    expect(rule.instructions).toBe("small heavy");
  });

  it("keeps a var value's spaces in the expanded text", () => {
    const [rule] = parseRules(
      JSON.stringify({ vars: { a: " pad " }, rules: [{ instructions: "[{{a}}]" }] }),
    );
    expect(rule.instructions).toBe("[ pad ]");
  });

  it("leaves form A text with {{name}} unchanged", () => {
    const [rule] = parseRules(JSON.stringify([{ instructions: "{{name}} stays" }]));
    expect(rule.instructions).toBe("{{name}} stays");
  });

  it("wraps a non-Error JSON.parse failure", () => {
    const parse = vi.spyOn(JSON, "parse").mockImplementation(() => {
      throw "boom";
    });
    try {
      expect(() => parseRules("[]")).toThrow("not valid JSON: boom");
    } finally {
      parse.mockRestore();
    }
  });

  it("backs the setting's write validation", () => {
    const schema = createRulesSettingSchema({
      skillNames: () => [],
      scopesFor: (own) => own,
      caches: () => ({
        providers: { loaded: true, failed: false, list: [] },
        projects: { loaded: true, failed: false, list: [] },
      }),
    });
    expect(schema.safeParse("[]").success).toBe(true);
    expect(schema.safeParse("[{}]").success).toBe(false);
    expect(
      schema.safeParse(
        JSON.stringify({ vars: { a: "x" }, rules: [{ instructions: "use {{a}}" }] }),
      ).success,
    ).toBe(true);
    expect(
      schema.safeParse(
        JSON.stringify({ vars: { a: "x" }, rules: [{ instructions: "use {{b}}" }] }),
      ).success,
    ).toBe(false);
  });
});

describe("plugin", () => {
  function createHost(settings?: Record<string, string>) {
    return createFakePluginHost({
      pluginId: "model-instructions",
      agentSkillIds: ["model-instructions"],
      settings,
      // The save-time budget check reads the provider and project lists: both load, and are empty.
      sdk: {
        providers: { list: async () => [], models: async () => ({ models: [], modelLoadError: null }) },
        projects: { list: async () => [] },
      },
    });
  }

  function resolve(
    host: ReturnType<typeof createHost>,
    model: string,
    parentThreadId: string | null = null,
    project = "bb-plugins",
    title: string | null = null,
  ) {
    return host.harness.resolveAgentConfiguration(
      makePluginAgentConfigurationContext({
        thread: { id: "thread-1", parentThreadId, title },
        project: { name: project },
        provider: { id: "claude-code", model },
      }),
    );
  }

  it("contributes no instructions by default", async () => {
    const host = createHost();
    await plugin(host.bb);
    expect(await resolve(host, "claude-opus-5-5")).toEqual({
      tools: [],
      skills: ["model-instructions"],
      instructions: null,
    });
    await host.harness.dispose();
  });

  it("ignores a stored value that no longer parses", async () => {
    const host = createHost({ rules: "[{" });
    await plugin(host.bb);
    expect((await resolve(host, "claude-opus-5-5")).instructions).toBeNull();
    await host.harness.dispose();
  });

  it("follows a rules change without a reload", async () => {
    const host = createHost();
    await plugin(host.bb);
    await host.harness.setSettings({ rules: JSON.stringify([SUPERVISOR, WORKER]) });
    expect((await resolve(host, "claude-opus-5-5")).instructions).toBe(
      "Plan and supervise.\nSpawn Sonnet workers to implement.",
    );
    expect((await resolve(host, "claude-sonnet-5-5", "parent-1")).instructions).toBe("Implement the brief.");
    await host.harness.dispose();
  });

  it("passes the thread's project name to the rules", async () => {
    const host = createHost({ rules: JSON.stringify([{ project: "opshub", instructions: "OpsHub only." }]) });
    await plugin(host.bb);
    expect((await resolve(host, "claude-opus-5-5", null, "opshub")).instructions).toBe("OpsHub only.");
    expect((await resolve(host, "claude-opus-5-5")).instructions).toBeNull();
    await host.harness.dispose();
  });

  it("applies array project and skipProjects through the plugin", async () => {
    const host = createHost({
      rules: JSON.stringify([
        { project: ["opshub-*", "bb-*"], skipProjects: "opshub-legacy", instructions: "Active projects." },
      ]),
    });
    await plugin(host.bb);
    expect((await resolve(host, "claude-opus-5-5", null, "opshub-web")).instructions).toBe("Active projects.");
    expect((await resolve(host, "claude-opus-5-5", null, "opshub-legacy")).instructions).toBeNull();
    await host.harness.dispose();
  });

  it("passes the thread's title to skipTitles", async () => {
    const host = createHost({
      rules: JSON.stringify([{ threads: "child", skipTitles: "Helpdesk: *", instructions: "Helper." }]),
    });
    await plugin(host.bb);
    expect((await resolve(host, "claude-opus-5-5", "parent-1", "bb-plugins", "Helpdesk: Anna 09:14")).instructions).toBeNull();
    expect((await resolve(host, "claude-opus-5-5", "parent-1", "bb-plugins", "Fix the bug")).instructions).toBe("Helper.");
    expect((await resolve(host, "claude-opus-5-5", "parent-1")).instructions).toBe("Helper.");
    await host.harness.dispose();
  });

  it("resolves form B settings with expanded instructions", async () => {
    const host = createHost({
      rules: JSON.stringify({
        vars: { spawn: "bb thread spawn --parent-self" },
        rules: [{ threads: "top-level", instructions: "Delegate with {{spawn}} and wait." }],
      }),
    });
    await plugin(host.bb);
    expect((await resolve(host, "claude-opus-5-5")).instructions).toBe(
      "Delegate with bb thread spawn --parent-self and wait.",
    );
    await host.harness.dispose();
  });
});
