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
  ruleLabel,
  unresolvedRefs,
  type Config,
} from "./rules.js";

/** What the save-time checks read. All of it is in memory, so the checks are synchronous. */
export interface SettingsEnv {
  /** Names of the bundled skills. */
  skillNames(): string[];
  /** The scopes a rule may name: the saved scopes plus any other source. */
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
