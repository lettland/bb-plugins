import { type Scope } from "./paths.js";
import type { CacheSnapshot } from "./projects.js";
import {
  activeScopeNames,
  fullLength,
  INSTRUCTIONS_LIMIT,
  matchRules,
  ruleLabel,
  type Rule,
} from "./rules.js";

export type Role = "top-level" | "child";

export interface ThreadType {
  provider: string;
  model: string;
  role: Role;
  /** Project name, or "" for a thread with no project. */
  project: string;
  /** The matched rules' joined text, separators included. */
  length: number;
  /** Indexes of the matched rules. */
  rules: number[];
}

export interface BudgetReport {
  /** How many thread types were resolved. */
  checked: number;
  /** Those whose text is longer than the limit. */
  overflowing: ThreadType[];
}

export interface BudgetGroup {
  /** Labels of the matched rules that every thread type in the group shares. */
  rules: string[];
  /** The longest thread types, at most `SHOWN_PER_GROUP`. */
  shown: ThreadType[];
  /** How many more thread types the group holds. */
  more: number;
}

const SHOWN_PER_GROUP = 5;

/** Which cache list stops the budget from being checked, or null when both are usable. */
export function cacheProblem(snapshot: CacheSnapshot): "provider list" | "project list" | null {
  if (!snapshot.providers.loaded || snapshot.providers.failed) return "provider list";
  if (!snapshot.projects.loaded || snapshot.projects.failed) return "project list";
  return null;
}

export function notCheckable(list: "provider list" | "project list"): string {
  return `budget not checkable yet: ${list} not loaded; retry`;
}

/**
 * Resolves every known thread type: each provider and model, as a top-level and as a child thread,
 * for every project (its name and checkout paths) and for no project. The title is left empty:
 * a skipped title can only remove a rule, so the text of a titled thread is never longer.
 */
export function budgetReport(
  rules: Rule[],
  scopes: Scope[],
  snapshot: CacheSnapshot,
): BudgetReport {
  const projects = [
    ...snapshot.projects.list.map((project) => ({
      name: project.name,
      paths: project.paths,
    })),
    { name: "", paths: [] as string[] },
  ].map((project) => ({
    ...project,
    active: activeScopeNames(scopes, project.paths),
  }));
  let checked = 0;
  const overflowing: ThreadType[] = [];
  for (const provider of snapshot.providers.list)
    for (const model of provider.models)
      for (const role of ["top-level", "child"] as const)
        for (const project of projects) {
          checked += 1;
          const rulesMatched = matchRules(rules, project.active, {
            provider: provider.id,
            model,
            project: project.name,
            parentThreadId: role === "child" ? "child" : null,
            title: null,
            candidatePaths: project.paths,
          });
          const length = fullLength(rules, rulesMatched);
          if (length > INSTRUCTIONS_LIMIT)
            overflowing.push({
              provider: provider.id,
              model,
              role,
              project: project.name,
              length,
              rules: rulesMatched,
            });
        }
  return { checked, overflowing };
}

/** Groups thread types by the set of rules they match; the group with the longest text comes first. */
export function groupOverflows(types: ThreadType[], rules: Rule[]): BudgetGroup[] {
  const groups = new Map<string, ThreadType[]>();
  for (const type of types) {
    const key = type.rules.join(",");
    const group = groups.get(key);
    if (group) group.push(type);
    else groups.set(key, [type]);
  }
  return [...groups.values()]
    .map((members) => members.sort((a, b) => b.length - a.length))
    .sort((a, b) => b[0].length - a[0].length)
    .map((members) => ({
      rules: members[0].rules.map((index) => ruleLabel(rules[index], index)),
      shown: members.slice(0, SHOWN_PER_GROUP),
      more: Math.max(0, members.length - SHOWN_PER_GROUP),
    }));
}

export function describeType(type: ThreadType): string {
  return `${type.provider} ${type.model} ${type.role} project ${type.project === "" ? "(none)" : JSON.stringify(type.project)}: ${type.length}`;
}

export function formatGroups(groups: BudgetGroup[]): string[] {
  const lines: string[] = [];
  for (const group of groups) {
    lines.push(
      `over the ${INSTRUCTIONS_LIMIT}-character limit with ${group.rules.join(", ")}:`,
    );
    for (const type of group.shown) lines.push(`  ${describeType(type)}`);
    if (group.more > 0) lines.push(`  and ${group.more} more`);
  }
  return lines;
}
