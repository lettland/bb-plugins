import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import type { ReviewMode } from "./prompt.js";

export const REVIEW_MODES = ["auto", "devkit", "self"] as const;

export const DEFAULT_MERGE_ELIGIBLE_MAINLINES = ["master"];

export const FIRE_REASONS = [
  "fired",
  "deferred",
  "no-authorship",
  "empty-scope",
  "no-turn-start",
  "user-stopped",
  "user-queued",
  "disabled",
  "skipped",
  "sibling-active",
  "send-failed",
  "not-a-branch",
  "status-unavailable",
  "plan-review",
  "plan-reviewed",
  "plan-hold-expired",
  "commit-plan",
] as const;
export type FireReason = (typeof FIRE_REASONS)[number];

export const projectConfigSchema = z.object({
  enabled: z.boolean().optional(),
  mergeEligibleMainlines: z.array(z.string()).optional(),
  reviewMode: z.enum(REVIEW_MODES).optional(),
});
export type ProjectConfig = z.infer<typeof projectConfigSchema>;

export const lastFireSchema = z.object({
  at: z.number(),
  outcome: z.enum(["fired", "deferred", "stood-down"]),
  reason: z.enum(FIRE_REASONS),
  commit: z.boolean(),
  merge: z.boolean(),
  base: z.string().nullable(),
  isWorktree: z.boolean(),
  scopePaths: z.array(z.string()),
});
export type LastFire = z.infer<typeof lastFireSchema>;

export interface GlobalDefaults {
  enabled: boolean;
  mergeEligibleMainlines: string[];
  reviewMode: ReviewMode;
}

export interface EffectiveConfig {
  enabled: boolean;
  mergeEligibleMainlines: string[];
  reviewMode: ReviewMode;
  skipped: boolean;
}

export function parseMainlines(csv: string): string[] {
  return csv
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

export function defineAutoReviewSettings(bb: BbPluginApi) {
  return bb.settings.define({
    enabled: {
      type: "boolean",
      label: "Enabled",
      description:
        "Global kill switch. When off, auto-review never fires in any project.",
      default: true,
    },
    mergeEligibleMainlines: {
      type: "string",
      label: "Merge-eligible mainlines",
      description:
        "Comma-separated branch names treated as personal mainlines a feature branch may be merged into locally (in a worktree or the primary checkout). Default: master.",
      default: "master",
    },
    reviewMode: {
      type: "select",
      label: "Review mode",
      description:
        "How plans and code changes are reviewed. auto: devkit's calibrated review when its devkit_load_skill tool is available, else self-review. devkit: require devkit's review. self: always self-review.",
      options: [...REVIEW_MODES],
      default: "auto",
    },
  });
}

export function globalDefaultsFrom(values: {
  enabled: boolean;
  mergeEligibleMainlines: string;
  reviewMode: string;
}): GlobalDefaults {
  const mainlines = parseMainlines(values.mergeEligibleMainlines);
  const reviewMode = (REVIEW_MODES as readonly string[]).includes(
    values.reviewMode,
  )
    ? (values.reviewMode as ReviewMode)
    : "auto";
  return {
    enabled: values.enabled,
    mergeEligibleMainlines:
      mainlines.length > 0 ? mainlines : [...DEFAULT_MERGE_ELIGIBLE_MAINLINES],
    reviewMode,
  };
}

export function effectiveConfig(
  globals: GlobalDefaults,
  project: ProjectConfig,
  skipped: boolean,
): EffectiveConfig {
  return {
    enabled: project.enabled ?? globals.enabled,
    mergeEligibleMainlines:
      project.mergeEligibleMainlines ?? globals.mergeEligibleMainlines,
    reviewMode: project.reviewMode ?? globals.reviewMode,
    skipped,
  };
}

function projectKey(projectId: string): string {
  return `project:${projectId}`;
}

function lastFireKey(projectId: string, threadId: string): string {
  return `lastfire:${projectId}:${threadId}`;
}

export async function readProjectConfig(
  bb: BbPluginApi,
  projectId: string,
): Promise<ProjectConfig> {
  const raw = await bb.storage.kv.get<unknown>(projectKey(projectId));
  const parsed = projectConfigSchema.safeParse(raw ?? {});
  return parsed.success ? parsed.data : {};
}

export async function writeProjectConfig(
  bb: BbPluginApi,
  projectId: string,
  patch: ProjectConfig,
): Promise<ProjectConfig> {
  const current = await readProjectConfig(bb, projectId);
  const next: ProjectConfig = { ...current, ...patch };
  await bb.storage.kv.set(projectKey(projectId), next);
  return next;
}

export async function readLastFire(
  bb: BbPluginApi,
  projectId: string,
  threadId: string,
): Promise<LastFire | null> {
  const raw = await bb.storage.kv.get<unknown>(lastFireKey(projectId, threadId));
  const parsed = lastFireSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

export async function writeLastFire(
  bb: BbPluginApi,
  projectId: string,
  threadId: string,
  fire: LastFire,
): Promise<void> {
  await bb.storage.kv.set(lastFireKey(projectId, threadId), fire);
}
