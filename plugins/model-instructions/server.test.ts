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

function target(model: string, parentThreadId: string | null = null, provider = "claude-code") {
  return { provider, model, parentThreadId };
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

  function resolve(host: ReturnType<typeof createHost>, model: string, parentThreadId: string | null = null) {
    return host.harness.resolveAgentConfiguration(
      makePluginAgentConfigurationContext({
        thread: { id: "thread-1", parentThreadId },
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
});
