import { z } from "zod";

const THREAD_SCOPES = ["any", "top-level", "child"] as const;

const globs = z
  .union([z.string(), z.array(z.string())], {
    error: "expected a glob or an array of globs",
  })
  .transform((value) => (Array.isArray(value) ? value : [value]))
  .pipe(z.array(z.string().trim().min(1)).min(1));

const ruleSchema = z
  .object({
    provider: z.string().trim().min(1).optional(),
    model: z.string().trim().min(1).optional(),
    project: globs.optional(),
    skipProjects: globs.optional(),
    skipTitles: globs.optional(),
    threads: z.enum(THREAD_SCOPES).default("any"),
    instructions: z
      .union([z.string(), z.array(z.string())])
      .transform((value) => (Array.isArray(value) ? value.join("\n") : value))
      .pipe(z.string().trim().min(1)),
  })
  .strict();

const rulesSchema = z.array(ruleSchema);

const VAR_NAME_BODY = "[A-Za-z][A-Za-z0-9_-]*";
const VAR_NAME_REGEXP = new RegExp(`^${VAR_NAME_BODY}$`);
const VAR_REF_REGEXP = new RegExp(`\\{\\{(${VAR_NAME_BODY})\\}\\}`, "g");

const varsSchema = z.record(
  z.string().regex(VAR_NAME_REGEXP),
  z.string().refine((value) => value.trim().length > 0, {
    error: "expected a non-blank string",
  }),
);

const objectSchema = z.object({ vars: varsSchema, rules: rulesSchema }).strict();

export type Rule = z.infer<typeof ruleSchema>;

interface Target {
  provider: string;
  model: string;
  project: string;
  parentThreadId: string | null;
  title: string | null;
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

export function parseRules(json: string): Rule[] {
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
    return parsed.data;
  }
  if (typeof raw !== "object" || raw === null)
    throw new Error(
      'expected an array of rules or { "vars": {...}, "rules": [...] }',
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
  return parsed.data.rules.map((rule, ruleIndex) => ({
    ...rule,
    instructions: expand(rule.instructions, parsed.data.vars, ruleIndex),
  }));
}

/** Validates the setting on write so a broken value never gets stored. */
export const rulesSettingSchema = z.string().superRefine((json, ctx) => {
  try {
    parseRules(json);
  } catch (error) {
    ctx.addIssue({
      code: "custom",
      // v8 ignore next -- @preserve parseRules only throws Error, so the non-Error arm is unreachable.
      message: error instanceof Error ? error.message : String(error),
    });
  }
});

function globToRegExp(glob: string): RegExp {
  const escaped = glob
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`);
}

function matches(rule: Rule, target: Target): boolean {
  if (rule.provider && !globToRegExp(rule.provider).test(target.provider))
    return false;
  if (rule.model && !globToRegExp(rule.model).test(target.model)) return false;
  if (
    rule.project &&
    !rule.project.some((glob) => globToRegExp(glob).test(target.project))
  )
    return false;
  if (
    rule.skipProjects?.some((glob) => globToRegExp(glob).test(target.project))
  )
    return false;
  const { title } = target;
  if (title && rule.skipTitles?.some((glob) => globToRegExp(glob).test(title)))
    return false;
  if (rule.threads === "top-level") return target.parentThreadId === null;
  if (rule.threads === "child") return target.parentThreadId !== null;
  return true;
}

/** Every matching rule's instructions in rule order, or null when none match. */
export function resolveInstructions(
  rules: Rule[],
  target: Target,
): string | null {
  const texts = rules
    .filter((rule) => matches(rule, target))
    .map((rule) => rule.instructions);
  return texts.length === 0 ? null : texts.join("\n\n");
}
