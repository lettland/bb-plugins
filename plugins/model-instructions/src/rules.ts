import { z } from "zod";

const THREAD_SCOPES = ["any", "top-level", "child"] as const;

const ruleSchema = z
  .object({
    provider: z.string().trim().min(1).optional(),
    model: z.string().trim().min(1).optional(),
    threads: z.enum(THREAD_SCOPES).default("any"),
    instructions: z
      .union([z.string(), z.array(z.string())])
      .transform((value) => (Array.isArray(value) ? value.join("\n") : value))
      .pipe(z.string().trim().min(1)),
  })
  .strict();

const rulesSchema = z.array(ruleSchema);

export type Rule = z.infer<typeof ruleSchema>;

interface Target {
  provider: string;
  model: string;
  parentThreadId: string | null;
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
  const parsed = rulesSchema.safeParse(raw);
  if (!parsed.success) throw new Error(z.prettifyError(parsed.error));
  return parsed.data;
}

/** Validates the setting on write so a broken value never gets stored. */
export const rulesSettingSchema = z.string().superRefine((json, ctx) => {
  try {
    parseRules(json);
  } catch (error) {
    ctx.addIssue({
      code: "custom",
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
