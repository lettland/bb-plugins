import { describe, expect, it } from "vitest";
import {
  createFakePluginHost,
  makePluginAgentConfigurationContext,
} from "@get-bb/plugin-sdk/testing";
import plugin from "./server.js";
import { parseRules, resolveInstructions, rulesSettingSchema } from "./src/rules.js";

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
) {
  return { provider, model, project, parentThreadId };
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
    ["{}", "expected array"],
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
  ])("rejects %s", (json, message) => {
    expect(() => parseRules(json)).toThrow(message);
  });

  it("backs the setting's write validation", () => {
    expect(rulesSettingSchema.safeParse("[]").success).toBe(true);
    expect(rulesSettingSchema.safeParse("[{}]").success).toBe(false);
  });
});

describe("plugin", () => {
  function createHost(settings?: Record<string, string>) {
    return createFakePluginHost({ pluginId: "model-instructions", agentSkillIds: ["model-instructions"], settings });
  }

  function resolve(
    host: ReturnType<typeof createHost>,
    model: string,
    parentThreadId: string | null = null,
    project = "bb-plugins",
  ) {
    return host.harness.resolveAgentConfiguration(
      makePluginAgentConfigurationContext({
        thread: { id: "thread-1", parentThreadId },
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
});
