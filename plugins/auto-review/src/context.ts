import type { BbPluginApi } from "@get-bb/plugin-sdk";
import {
  defineAutoReviewSettings,
  effectiveConfig,
  globalDefaultsFrom,
  writeLastFire,
  type FireReason,
  type GlobalDefaults,
  type LastFire,
} from "./config.js";
import type { GateThread } from "./gate.js";

export interface GateThreadLike extends GateThread {
  id: string;
  projectId: string;
}

export type FireExtra = Partial<Omit<LastFire, "at" | "outcome" | "reason">>;

export type EffectiveConfig = ReturnType<typeof effectiveConfig>;

/** Per-plugin-instance state shared by the auto-review handlers; `globals` follows the settings. */
export interface ReviewContext {
  bb: BbPluginApi;
  settings: ReturnType<typeof defineAutoReviewSettings>;
  globals: GlobalDefaults;
}

export async function createReviewContext(bb: BbPluginApi): Promise<ReviewContext> {
  const settings = defineAutoReviewSettings(bb);
  const ctx: ReviewContext = {
    bb,
    settings,
    globals: globalDefaultsFrom(await settings.get()),
  };
  settings.onChange((next) => {
    ctx.globals = globalDefaultsFrom(next);
  });
  return ctx;
}

export async function recordFire(
  ctx: ReviewContext,
  projectId: string,
  threadId: string,
  outcome: LastFire["outcome"],
  reason: FireReason,
  extra: FireExtra = {},
): Promise<void> {
  const { bb } = ctx;
  const fire: LastFire = {
    at: Date.now(),
    outcome,
    reason,
    commit: extra.commit ?? false,
    merge: extra.merge ?? false,
    base: extra.base ?? null,
    isWorktree: extra.isWorktree ?? false,
    scopePaths: extra.scopePaths ?? [],
  };
  await writeLastFire(bb, projectId, threadId, fire);
}

export async function queuedRowExists(
  ctx: ReviewContext,
  threadId: string,
  entryId: string,
): Promise<boolean> {
  const { bb } = ctx;
  const rows = await bb.sdk.threads.queuedMessages.list({ threadId });
  return rows.some((row) => row.id === entryId);
}
