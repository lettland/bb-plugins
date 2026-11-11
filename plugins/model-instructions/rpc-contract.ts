import type { PluginRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

// Imported by the settings form as well as the server: nothing here may import a node module.

const rawScopeSchema = z.strictObject({
  name: z.string(),
  paths: z.array(z.string()),
});

const rawRuleSchema = z.strictObject({
  name: z.string().optional(),
  provider: z.string().optional(),
  model: z.string().optional(),
  project: z.array(z.string()).optional(),
  skipProjects: z.array(z.string()).optional(),
  skipTitles: z.array(z.string()).optional(),
  scope: z.array(z.string()).optional(),
  skills: z.array(z.string()).optional(),
  threads: z.enum(["any", "top-level", "child"]),
  instructions: z.string().optional(),
});

/**
 * The config as stored: `{{name}}` references unexpanded, instructions one string, glob fields
 * arrays, an empty field left out. Strict: a scope with `claudeConfigDir` has no place in it.
 */
export const rawConfigSchema = z.strictObject({
  vars: z.record(z.string(), z.string()),
  scopes: z.array(rawScopeSchema),
  rules: z.array(rawRuleSchema),
});
export type RawConfig = z.infer<typeof rawConfigSchema>;

const listStateSchema = z.strictObject({
  loaded: z.boolean(),
  failed: z.boolean(),
});
export type ListState = z.infer<typeof listStateSchema>;

const overBudgetSchema = z.strictObject({
  provider: z.string(),
  model: z.string(),
  role: z.enum(["top-level", "child"]),
  project: z.string(),
  length: z.number(),
  rules: z.array(z.number()),
  since: z.string(),
});
export type OverBudgetRecord = z.infer<typeof overBudgetSchema>;

const stateSchema = z.strictObject({
  config: rawConfigSchema,
  providers: z.array(z.strictObject({ id: z.string(), models: z.array(z.string()) })),
  projects: z.array(z.strictObject({ id: z.string(), name: z.string() })),
  skills: z.array(z.strictObject({ name: z.string(), description: z.string() })),
  /** Profile scopes by name and paths only; their Claude config dir is never sent. */
  profileScopes: z.array(rawScopeSchema),
  /** Saved scopes that a profile scope of the same name overrides. */
  ignoredScopes: z.array(z.string()),
  cache: z.strictObject({ providers: listStateSchema, projects: listStateSchema }),
  overBudget: z.array(overBudgetSchema),
  /** The old `rules` setting text that could not be imported, with the reason; null when none is kept. */
  loadError: z.strictObject({ message: z.string(), legacyText: z.string() }).nullable(),
});
export type ConfigState = z.infer<typeof stateSchema>;

export const modelInstructionsRpcContract = {
  getState: {
    input: z.null(),
    output: stateSchema,
  },
  saveConfig: {
    // Typed as RawConfig but not parsed here: parseRawConfig is the one validation, and a zod record
    // would drop a `__proto__` key before the handler could reject it.
    input: z.strictObject({ config: z.custom<RawConfig>() }),
    output: stateSchema,
  },
  dismissLegacy: {
    input: z.null(),
    output: stateSchema,
  },
} satisfies PluginRpcContract;

export type ModelInstructionsRpcContract = typeof modelInstructionsRpcContract;
