import type { BbPluginApi } from "@get-bb/plugin-sdk";
import {
  defineAutoReviewSettings,
  effectiveConfig,
  globalDefaultsFrom,
  readProjectConfig,
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

export type FireExtra = Partial<Omit<LastFire, "at" | "outcome" | "reason" | "planReviewTier">>;

export type EffectiveConfig = ReturnType<typeof effectiveConfig>;

const THREAD_OPT_OUT_PREFIX = "thread-review-opt-out:";

/** Per-plugin-instance state shared by the auto-review handlers; `globals` follows the settings. */
export interface ReviewContext {
  bb: BbPluginApi;
  settings: ReturnType<typeof defineAutoReviewSettings>;
  globals: GlobalDefaults;
  // Private KV keys, separate from thread metadata that the agent can write.
  threadOptOuts: Set<string>;
}

export async function createReviewContext(bb: BbPluginApi): Promise<ReviewContext> {
  const settings = defineAutoReviewSettings(bb);
  const ctx: ReviewContext = {
    bb,
    settings,
    globals: globalDefaultsFrom(await settings.get()),
    threadOptOuts: new Set(
      (await bb.storage.kv.list(THREAD_OPT_OUT_PREFIX)).map((key) => key.slice(THREAD_OPT_OUT_PREFIX.length)),
    ),
  };
  settings.onChange((next) => {
    ctx.globals = globalDefaultsFrom(next);
  });
  return ctx;
}

/** Call under the thread lock so the persisted choice and live lookup agree. */
export async function setThreadOptOut(ctx: ReviewContext, threadId: string, skip: boolean): Promise<void> {
  const key = THREAD_OPT_OUT_PREFIX + threadId;
  if (skip) {
    await ctx.bb.storage.kv.set(key, true);
    ctx.threadOptOuts.add(threadId);
  } else {
    await ctx.bb.storage.kv.delete(key);
    ctx.threadOptOuts.delete(threadId);
  }
}

export async function readThreadConfig(
  ctx: ReviewContext,
  projectId: string,
  eligibleThreadId: string | null,
): Promise<EffectiveConfig> {
  const project = await readProjectConfig(ctx.bb, projectId);
  const skipAutoReview = eligibleThreadId !== null && ctx.threadOptOuts.has(eligibleThreadId);
  return effectiveConfig(ctx.globals, project, skipAutoReview);
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
    ...(extra.unclaimedCount === undefined ? {} : { unclaimedCount: extra.unclaimedCount }),
    ...(extra.parkedCount === undefined ? {} : { parkedCount: extra.parkedCount }),
    ...(extra.parkedCommits === undefined ? {} : { parkedCommits: extra.parkedCommits }),
    ...(extra.parkedPaths === undefined ? {} : { parkedPaths: extra.parkedPaths }),
    ...(extra.skippedCommits === undefined ? {} : { skippedCommits: extra.skippedCommits }),
    ...(extra.planReviewerCount === undefined ? {} : { planReviewerCount: extra.planReviewerCount }),
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
