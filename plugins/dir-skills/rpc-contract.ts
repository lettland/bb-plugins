import type { PluginRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

/**
 * One scope as the settings form edits and stores it. Strict: an unknown key
 * such as `claudeConfigDir` is rejected, never dropped silently. A Claude
 * profile can only be set in ~/.bb/dir-skills/scopes.json.
 */
export const uiScopeSchema = z.strictObject({
  name: z.string().max(128),
  paths: z.array(z.string().max(1024)).max(16),
  skills: z.array(z.string().max(128)).max(64),
});
export type UiScope = z.infer<typeof uiScopeSchema>;

export const uiScopesSchema = z.array(uiScopeSchema).max(32);

const fileScopeSchema = z.object({
  name: z.string(),
  paths: z.array(z.string()),
  skills: z.array(z.string()),
  source: z.enum(["shipped", "file"]),
  /** Whether the scope sets a Claude profile. The profile itself is never sent. */
  hasProfile: z.boolean(),
  /** Whether one of the UI scopes replaces this scope. */
  replacedByUi: z.boolean(),
});
export type FileScope = z.infer<typeof fileScopeSchema>;

const scopesSnapshotSchema = z.object({
  /** The scopes of the shipped scopes.json and ~/.bb/dir-skills/scopes.json, one per name, before the UI layer. */
  fileScopes: z.array(fileScopeSchema),
  /** The stored UI scopes as saved; [] when `settingError` is set. */
  uiScopes: uiScopesSchema,
  skills: z.array(z.object({ name: z.string(), description: z.string() })),
  /** Names of UI scopes that the active state ignores. */
  skipped: z.array(z.string()),
  /** Why the stored value was ignored, or null. */
  settingError: z.string().nullable(),
});
export type ScopesSnapshot = z.infer<typeof scopesSnapshotSchema>;

export const dirSkillsRpcContract = {
  getScopes: {
    input: z.null(),
    output: scopesSnapshotSchema,
  },
  saveScopes: {
    input: z.strictObject({ scopes: uiScopesSchema }),
    output: scopesSnapshotSchema,
  },
} satisfies PluginRpcContract;

export type DirSkillsRpcContract = typeof dirSkillsRpcContract;
