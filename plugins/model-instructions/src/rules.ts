import path from "node:path";
import { z } from "zod";
import { activeScopes, activeScopesIn, type Scope } from "./paths.js";

const THREAD_SCOPES = ["any", "top-level", "child"] as const;

/** bb cuts a plugin's instructions at this many characters. */
export const INSTRUCTIONS_LIMIT = 4096;
/** The always-injected bundled skill; skill claims never match it. */
export const SELF_SKILL = "model-instructions";
const SEPARATOR = "\n\n";
const MAX_SCOPES = 32;
const MAX_SCOPE_PATHS = 16;
const MAX_NAME = 128;
const MAX_PATH = 1024;

const globs = z
  .union([z.string(), z.array(z.string())], {
    error: "expected a glob or an array of globs",
  })
  .transform((value) => (Array.isArray(value) ? value : [value]))
  .pipe(z.array(z.string().trim().min(1)).min(1));

// C0/C1 controls and the Unicode line separators: a name with one would add fake lines to logs and status.
const NAME_CONTROL = /[\p{Cc}\u2028\u2029]/u;

const nameSchema = z
  .string()
  .trim()
  .min(1)
  .max(MAX_NAME)
  .refine((value) => !NAME_CONTROL.test(value), {
    error: "the name must not contain control characters",
  });

const scopePathSchema = z
  .string()
  .trim()
  .max(MAX_PATH)
  .refine((value) => value.startsWith("~/") || path.isAbsolute(value), {
    error: 'expected an absolute path or a path starting with "~/"',
  });

const scopeSchema = z
  .object({
    name: nameSchema,
    paths: z.array(scopePathSchema).min(1).max(MAX_SCOPE_PATHS),
  })
  .strict();

const scopesSchema = z
  .array(scopeSchema)
  .max(MAX_SCOPES)
  .superRefine((scopes, ctx) => {
    const seen = new Set<string>();
    scopes.forEach((scope, index) => {
      if (seen.has(scope.name))
        ctx.addIssue({
          code: "custom",
          path: [index, "name"],
          message: `the scope name "${scope.name}" is used twice`,
        });
      seen.add(scope.name);
    });
  });

const ruleSchema = z
  .object({
    name: nameSchema.optional(),
    provider: z.string().trim().min(1).optional(),
    model: z.string().trim().min(1).optional(),
    project: globs.optional(),
    skipProjects: globs.optional(),
    skipTitles: globs.optional(),
    scope: globs.optional(),
    skills: globs.optional(),
    threads: z.enum(THREAD_SCOPES).default("any"),
    instructions: z
      .union([z.string(), z.array(z.string())])
      .transform((value) => (Array.isArray(value) ? value.join("\n") : value))
      .pipe(z.string().trim().min(1))
      .optional(),
  })
  .strict()
  .refine((rule) => rule.instructions !== undefined || rule.skills !== undefined, {
    error: 'a rule needs "instructions", "skills", or both',
  });

const rulesSchema = z.array(ruleSchema).superRefine((rules, ctx) => {
  const seen = new Set<string>();
  rules.forEach((rule, index) => {
    if (rule.name === undefined) return;
    if (seen.has(rule.name))
      ctx.addIssue({
        code: "custom",
        path: [index, "name"],
        message: `the rule name "${rule.name}" is used twice`,
      });
    seen.add(rule.name);
  });
});

const VAR_NAME_BODY = "[A-Za-z][A-Za-z0-9_-]*";
const VAR_NAME_REGEXP = new RegExp(`^${VAR_NAME_BODY}$`);
const VAR_REF_REGEXP = new RegExp(`\\{\\{(${VAR_NAME_BODY})\\}\\}`, "g");

const varsSchema = z.record(
  z.string().regex(VAR_NAME_REGEXP),
  z.string().refine((value) => value.trim().length > 0, {
    error: "expected a non-blank string",
  }),
);

const objectSchema = z
  .object({
    vars: varsSchema.default({}),
    scopes: scopesSchema.default([]),
    rules: rulesSchema,
  })
  .strict();

export type Rule = z.infer<typeof ruleSchema>;

/** A scope as written in the setting: paths not normalized yet. */
export type ScopeDef = z.infer<typeof scopeSchema>;

export interface Config {
  rules: Rule[];
  scopes: ScopeDef[];
}

export interface Target {
  provider: string;
  model: string;
  project: string;
  parentThreadId: string | null;
  title: string | null;
  /** The environment path and the project's checkout paths; a `scope` rule matches against them. */
  candidatePaths: string[];
}

/** One pass, so a var value's own {{...}} text stays literal. */
function expand(
  instructions: string,
  vars: Record<string, string>,
  ruleIndex: number,
): string {
  return instructions.replace(
    VAR_REF_REGEXP,
    (ref, name: string) => {
      if (!Object.hasOwn(vars, name))
        throw new Error(`rules[${ruleIndex}]: unknown variable ${ref}`);
      return vars[name];
    },
  );
}

export function parseConfig(json: string): Config {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (error) {
    throw new Error(
      `not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (Array.isArray(raw)) {
    const parsed = rulesSchema.safeParse(raw);
    if (!parsed.success) throw new Error(z.prettifyError(parsed.error));
    return { rules: parsed.data, scopes: [] };
  }
  if (typeof raw !== "object" || raw === null)
    throw new Error(
      'expected an array of rules or { "vars"?: {...}, "scopes"?: [...], "rules": [...] }',
    );
  // zod's record drops a __proto__ key silently, so reject it loudly first.
  const { vars } = raw as { vars?: unknown };
  if (
    typeof vars === "object" &&
    vars !== null &&
    Object.hasOwn(vars, "__proto__")
  )
    throw new Error('invalid variable name "__proto__" at vars');
  const parsed = objectSchema.safeParse(raw);
  if (!parsed.success) throw new Error(z.prettifyError(parsed.error));
  return {
    scopes: parsed.data.scopes,
    rules: parsed.data.rules.map((rule, ruleIndex) => ({
      ...rule,
      instructions:
        rule.instructions === undefined
          ? undefined
          : expand(rule.instructions, parsed.data.vars, ruleIndex),
    })),
  };
}

export function parseRules(json: string): Rule[] {
  return parseConfig(json).rules;
}

const globCache = new Map<string, RegExp>();

export function globToRegExp(glob: string): RegExp {
  let regexp = globCache.get(glob);
  if (regexp === undefined) {
    const escaped = glob
      .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
      .replace(/\*/g, ".*");
    regexp = new RegExp(`^${escaped}$`);
    globCache.set(glob, regexp);
  }
  return regexp;
}

export function anyGlobMatches(patterns: readonly string[], value: string): boolean {
  return patterns.some((glob) => globToRegExp(glob).test(value));
}

/** The rule's name, or its position in the setting. */
export function ruleLabel(rule: Rule, index: number): string {
  return rule.name ?? `rules[${index}]`;
}

function matches(rule: Rule, target: Target, activeNames: string[]): boolean {
  if (rule.scope && !activeNames.some((name) => anyGlobMatches(rule.scope!, name)))
    return false;
  if (rule.provider && !globToRegExp(rule.provider).test(target.provider))
    return false;
  if (rule.model && !globToRegExp(rule.model).test(target.model)) return false;
  if (rule.project && !anyGlobMatches(rule.project, target.project))
    return false;
  if (rule.skipProjects && anyGlobMatches(rule.skipProjects, target.project))
    return false;
  const { title } = target;
  if (title && rule.skipTitles && anyGlobMatches(rule.skipTitles, title))
    return false;
  if (rule.threads === "top-level") return target.parentThreadId === null;
  if (rule.threads === "child") return target.parentThreadId !== null;
  return true;
}

/** Names of the scopes whose paths contain one of the candidate paths. */
export function activeScopeNames(scopes: Scope[], candidatePaths: string[]): string[] {
  return activeScopes(scopes, candidatePaths).map((scope) => scope.name);
}

/** Like `activeScopeNames`, for directories that are normalized already. */
export function activeScopeNamesIn(scopes: Scope[], dirs: string[]): string[] {
  return activeScopesIn(scopes, dirs).map((scope) => scope.name);
}

/** Indexes of the rules that match the target, in rule order. `activeNames` are the target's active scopes. */
export function matchRules(
  rules: Rule[],
  activeNames: string[],
  target: Target,
): number[] {
  const found: number[] = [];
  rules.forEach((rule, index) => {
    if (matches(rule, target, activeNames)) found.push(index);
  });
  return found;
}

/** The text of a rule that has instructions; every caller has filtered for them. */
const textOf = (rules: Rule[], index: number): string => rules[index].instructions!;

/** The length of the matched rules' joined text, separators included; no budget applied. */
export function fullLength(rules: Rule[], matched: number[]): number {
  const texts = matched.filter((index) => rules[index].instructions !== undefined);
  if (texts.length === 0) return 0;
  return (
    texts.reduce((sum, index) => sum + textOf(rules, index).length, 0) +
    SEPARATOR.length * (texts.length - 1)
  );
}

export function omittedNotice(count: number): string {
  return `[model-instructions: ${count} rule(s) omitted: over the ${INSTRUCTIONS_LIMIT}-character limit; tell the user to run bb model-instructions status]`;
}

export interface Resolved {
  text: string | null;
  /** Labels of the rules left out of `text` because of the limit. */
  dropped: string[];
  /** The instruction length of each dropped rule, in the same order. */
  droppedLengths: number[];
  /** Skill names to inject: `model-instructions` first, then the claimed ones sorted. */
  skills: string[];
}

/** The skills the matched rules claim, never including the always-injected one. */
export function claimedSkills(
  rules: Rule[],
  matched: number[],
  skills: readonly string[],
): string[] {
  const claimed = new Set<string>();
  for (const index of matched)
    for (const glob of rules[index].skills ?? [])
      for (const name of skills)
        if (name !== SELF_SKILL && globToRegExp(glob).test(name)) claimed.add(name);
  return [...claimed].sort();
}

/**
 * Builds the text and skills for already matched rules. A text that fits within the limit is
 * never touched. Otherwise rules are added in order while the text, the separator and the
 * omission notice still fit; the first rule that does not fit and every later one are dropped whole.
 */
export function compose(
  rules: Rule[],
  matched: number[],
  skills: readonly string[],
): Resolved {
  const withText = matched.filter((index) => rules[index].instructions !== undefined);
  let keep = withText.length;
  if (fullLength(rules, matched) > INSTRUCTIONS_LIMIT) {
    const budget =
      INSTRUCTIONS_LIMIT - omittedNotice(rules.length).length - SEPARATOR.length;
    let total = 0;
    keep = 0;
    for (const index of withText) {
      const next =
        total + (keep > 0 ? SEPARATOR.length : 0) + textOf(rules, index).length;
      if (next > budget) break;
      total = next;
      keep += 1;
    }
  }
  const parts = withText.slice(0, keep).map((index) => textOf(rules, index));
  const droppedIndexes = withText.slice(keep);
  if (droppedIndexes.length > 0) parts.push(omittedNotice(droppedIndexes.length));
  return {
    text: parts.length === 0 ? null : parts.join(SEPARATOR),
    dropped: droppedIndexes.map((index) => ruleLabel(rules[index], index)),
    droppedLengths: droppedIndexes.map((index) => textOf(rules, index).length),
    skills: [SELF_SKILL, ...claimedSkills(rules, matched, skills)],
  };
}

/** Everything a thread gets from the rules: the text, the rules left out of it, and the skills. */
export function resolve(
  rules: Rule[],
  scopes: Scope[],
  skills: readonly string[],
  target: Target,
): Resolved {
  const matched = matchRules(
    rules,
    activeScopeNames(scopes, target.candidatePaths),
    target,
  );
  return compose(rules, matched, skills);
}

/**
 * Every matching rule's instructions in rule order, or null when none match.
 * Kept for the array-form behaviour tests: no scopes, no skills.
 */
export function resolveInstructions(
  rules: Rule[],
  target: Omit<Target, "candidatePaths">,
): string | null {
  return resolve(rules, [], [], { ...target, candidatePaths: [] }).text;
}

export interface UnresolvedRef {
  index: number;
  kind: "scope" | "skills";
  glob: string;
}

/** `scope` and `skills` globs that match no defined scope name or no bundled skill. */
export function unresolvedRefs(
  rules: Rule[],
  scopeNames: readonly string[],
  skillNames: readonly string[],
): UnresolvedRef[] {
  const found: UnresolvedRef[] = [];
  const bundled = skillNames.filter((name) => name !== SELF_SKILL);
  rules.forEach((rule, index) => {
    for (const glob of rule.scope ?? [])
      if (!scopeNames.some((name) => globToRegExp(glob).test(name)))
        found.push({ index, kind: "scope", glob });
    for (const glob of rule.skills ?? [])
      if (!bundled.some((name) => globToRegExp(glob).test(name)))
        found.push({ index, kind: "skills", glob });
  });
  return found;
}

/** The setting's rules that claim a bundled skill. */
export function claimants(rules: Rule[], skillName: string): number[] {
  const found: number[] = [];
  rules.forEach((rule, index) => {
    if (
      skillName !== SELF_SKILL &&
      (rule.skills ?? []).some((glob) => globToRegExp(glob).test(skillName))
    )
      found.push(index);
  });
  return found;
}
