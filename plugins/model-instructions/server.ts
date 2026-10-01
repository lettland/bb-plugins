import type { BbPluginApi } from "@get-bb/plugin-sdk";
import {
  parseRules,
  resolveInstructions,
  rulesSettingSchema,
  type Rule,
} from "./src/rules.js";

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    rules: {
      type: "string",
      label: "Rules",
      description:
        'JSON array of rules. Each rule: { "provider"?: glob, "model"?: glob, "project"?: glob, "threads"?: "any" | "top-level" | "child", "instructions": string | string[] }. Every matching rule\'s instructions are added to the thread, in order.',
      experimental_multiline: true,
      experimental_schema: rulesSettingSchema,
      default: "[]",
    },
  });

  function load(json: string): Rule[] {
    try {
      const rules = parseRules(json);
      bb.log.info(`loaded ${rules.length} rule(s)`);
      return rules;
    } catch (error) {
      bb.log.warn(
        `rules setting ignored: ${error instanceof Error ? error.message : String(error)}`,
      );
      return [];
    }
  }

  let rules = load((await settings.get()).rules);
  settings.onChange((next) => {
    rules = load(next.rules);
  });

  bb.agents.configure((context) => {
    const instructions = resolveInstructions(rules, {
      provider: context.provider.id,
      model: context.provider.model,
      project: context.project.name,
      parentThreadId: context.thread.parentThreadId,
    });
    return {
      tools: [],
      skills: ["model-instructions"],
      ...(instructions === null ? {} : { instructions }),
    };
  });
}
