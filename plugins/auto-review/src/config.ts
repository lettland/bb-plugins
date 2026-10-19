import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import type { ReviewMode } from "./prompt.js";
import { createKeyedLock } from "./keyed-lock.js";

export const REVIEW_MODES = ["auto", "devkit", "self"] as const;

export const DEFAULT_MERGE_ELIGIBLE_MAINLINES = ["master"];

// "skipped" and "commit-plan" are legacy: accepted from old stored state, never written.
export const FIRE_REASONS = [
  "fired",
  "deferred",
  "no-authorship",
  "unclaimed-changes",
  "changed-while-parked",
  "empty-scope",
  "no-turn-start",
  "user-stopped",
  "user-queued",
  "disabled",
  "skipped",
  "sibling-active",
  "children-active",
  "send-failed",
  "not-a-branch",
  "status-unavailable",
  "plan-review",
  "plan-reviewed",
  "plan-hold-expired",
  "plan-hold-answered",
  "plan-approved",
  "plan-review-redo",
  "plan-review-incomplete",
  "plan-review-unverified",
  "already-reviewed",
  "no-new-work",
  "stale-park",
  "already-pushed",
  "commit-plan",
] as const;
export type FireReason = (typeof FIRE_REASONS)[number];

export const projectConfigSchema = z.object({
  enabled: z.boolean().optional(),
  mergeEligibleMainlines: z.array(z.string()).optional(),
  reviewMode: z.enum(REVIEW_MODES).optional(),
  autoApprovePlans: z.boolean().optional(),
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
  /** How many changes stood unclaimed by the thread's family; a count, never the paths. */
  unclaimedCount: z.number().int().nonnegative().optional(),
  /** How many changes were made while the turn waited in the review queue and left out; with the commits that arrived then and up to five example paths. */
  parkedCount: z.number().int().nonnegative().optional(),
  parkedCommits: z.array(z.string()).optional(),
  parkedPaths: z.array(z.string()).optional(),
  /** The turn's commits a parked stand-down left unreviewed and unscanned. */
  skippedCommits: z.array(z.string()).optional(),
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
  /** Per project only, off by default: approve a plan that completed the review cycle. */
  autoApprovePlans: boolean;
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
): EffectiveConfig {
  return {
    enabled: project.enabled ?? globals.enabled,
    mergeEligibleMainlines:
      project.mergeEligibleMainlines ?? globals.mergeEligibleMainlines,
    reviewMode: project.reviewMode ?? globals.reviewMode,
    autoApprovePlans: project.autoApprovePlans ?? false,
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

const withProjectLock = createKeyedLock();

/** The read-merge-write itself; callers hold the project's lock. */
async function mergeProjectConfig(
  bb: BbPluginApi,
  projectId: string,
  patch: ProjectConfig,
): Promise<ProjectConfig> {
  const current = await readProjectConfig(bb, projectId);
  const next: ProjectConfig = { ...current, ...patch };
  await bb.storage.kv.set(projectKey(projectId), next);
  return next;
}

/** Serialized per project, so concurrent writers (CLI and settings page) cannot drop each other's keys. */
export function writeProjectConfig(
  bb: BbPluginApi,
  projectId: string,
  patch: ProjectConfig,
): Promise<ProjectConfig> {
  return withProjectLock(projectId, () => mergeProjectConfig(bb, projectId, patch));
}

/**
 * The one writer of `autoApprovePlans`, so every flip is logged whichever
 * surface made it. `source` says who flipped it (`cli (thread <id>)`, `cli (terminal)`, `rpc`).
 */
export function setAutoApprovePlans(
  bb: BbPluginApi,
  projectId: string,
  value: boolean,
  source: string,
): Promise<void> {
  return withProjectLock(projectId, async () => {
    const before = (await readProjectConfig(bb, projectId)).autoApprovePlans ?? false;
    await mergeProjectConfig(bb, projectId, { autoApprovePlans: value });
    bb.log.info(
      `plan auto-approve for project ${projectId}: ${before} -> ${value} (via ${source})`,
    );
  });
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
