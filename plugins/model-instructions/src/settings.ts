import { z } from "zod";
import {
  budgetReport,
  cacheProblem,
  formatGroups,
  groupOverflows,
  notCheckable,
} from "./budget.js";
import { buildScope, type Scope } from "./paths.js";
import type { CacheSnapshot } from "./projects.js";
import {
  INSTRUCTIONS_LIMIT,
  parseConfig,
  ruleLabel,
  unresolvedRefs,
  type Config,
} from "./rules.js";

/** What the save-time checks read. All of it is in memory: the schema must be synchronous. */
export interface SettingsEnv {
  /** Names of the bundled skills. */
  skillNames(): string[];
  /** The scopes a rule may name: the setting's own scopes plus any other source. */
  scopesFor(own: Scope[]): Scope[];
  caches(): CacheSnapshot;
}

/** Why the parsed config cannot be saved, or null when it can. */
export function checkConfig(config: Config, env: SettingsEnv): string | null {
  const scopes = env.scopesFor(config.scopes.map((scope) => buildScope(scope)));
  const problems: string[] = [];
  for (const ref of unresolvedRefs(
    config.rules,
    scopes.map((scope) => scope.name),
    env.skillNames(),
  ))
    problems.push(
      ref.kind === "scope"
        ? `${ruleLabel(config.rules[ref.index], ref.index)}: scope "${ref.glob}" matches no defined scope`
        : `${ruleLabel(config.rules[ref.index], ref.index)}: skills "${ref.glob}" matches no bundled skill`,
    );
  config.rules.forEach((rule, index) => {
    if (rule.instructions !== undefined && rule.instructions.length > INSTRUCTIONS_LIMIT)
      problems.push(
        `${ruleLabel(rule, index)}: the instructions are ${rule.instructions.length} characters; the limit is ${INSTRUCTIONS_LIMIT}`,
      );
  });
  if (problems.length > 0) return problems.join("\n");
  // Without any text nothing can overflow, so the caches are not needed.
  if (config.rules.every((rule) => rule.instructions === undefined)) return null;
  const snapshot = env.caches();
  const unusable = cacheProblem(snapshot);
  if (unusable !== null) return notCheckable(unusable);
  const report = budgetReport(config.rules, scopes, snapshot);
  if (report.overflowing.length === 0) return null;
  return formatGroups(groupOverflows(report.overflowing, config.rules)).join("\n");
}

/** The save-time check of a setting text: why it cannot be saved, or null. */
export function settingProblem(json: string, env: SettingsEnv): string | null {
  let config: Config;
  try {
    config = parseConfig(json);
  } catch (error) {
    return (error as Error).message;
  }
  return checkConfig(config, env);
}

/** Validates the setting on write so a broken or over-long value never gets stored. */
export function createRulesSettingSchema(env: SettingsEnv) {
  return z.string().superRefine((json, ctx) => {
    let config: Config;
    try {
      config = parseConfig(json);
    } catch (error) {
      ctx.addIssue({
        code: "custom",
        // v8 ignore next -- @preserve parseConfig only throws Error, so the non-Error arm is unreachable.
        message: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    const problem = checkConfig(config, env);
    if (problem !== null) ctx.addIssue({ code: "custom", message: problem });
  });
}
