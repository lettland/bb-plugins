import type { BbPluginApi } from "@get-bb/plugin-sdk";
import {
  recordFire,
  type EffectiveConfig,
  type FireExtra,
  type GateThreadLike,
  type ReviewContext,
} from "./context.js";
import { decide } from "./decide.js";
import { deferTurn, providerReviewInFlight } from "./deferral.js";
import { removeDeferral } from "./deferrals.js";
import type { TurnChanges } from "./detect.js";
import { buildReviewPrompt, renderScope } from "./prompt.js";
import { withProviderLock } from "./provider-lock.js";
import { addReview, removeReview } from "./reviews.js";
import { resetToIdlePatch, writeState, type ThreadState } from "./state.js";

/**
 * Whether a running plugin serves `bb aislop`. The review only asks for the scan
 * then, so a missing or disabled aislop plugin never shows up as a failed step;
 * a failed lookup counts as absent and never blocks the review itself.
 */
export async function aislopScanAvailable(bb: BbPluginApi): Promise<boolean> {
  try {
    const { plugins } = await bb.sdk.plugins.list();
    return plugins.some(
      (entry) => entry.enabled && entry.status === "running" && entry.cliCommand?.name === "aislop",
    );
  } catch (error) {
    bb.log.warn(
      `auto-review: could not list plugins, leaving the aislop scan out of this review: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return false;
  }
}

export interface DispatchInput {
  thread: GateThreadLike;
  state: ThreadState;
  environmentId: string;
  config: EffectiveConfig;
  decision: ReturnType<typeof decide>;
  base: string;
  isWorktree: boolean;
  scope: string[];
  turn: TurnChanges;
}

async function sendReview(
  ctx: ReviewContext,
  thread: GateThreadLike,
  prompt: string,
  extra: FireExtra,
): Promise<void> {
  const { bb } = ctx;
  await writeState(
    bb,
    thread.id,
    { phase: "awaiting-review", dispatchedAt: Date.now() },
    ["pendingEntryId", "deferredSince", "heldBy"],
  );
  await addReview(bb, { threadId: thread.id, providerId: thread.providerId });
  await removeDeferral(bb, thread.id);
  let result: Awaited<ReturnType<typeof bb.sdk.threads.send>>;
  try {
    result = await bb.sdk.threads.send({
      threadId: thread.id,
      mode: "auto",
      input: [{ type: "text", text: prompt, mentions: [] }],
    });
  } catch (error) {
    bb.log.warn(
      `auto-review: failed to send the review turn for ${thread.id}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    const { set, remove } = resetToIdlePatch();
    await writeState(bb, thread.id, set, remove);
    await removeReview(bb, thread.id);
    await recordFire(ctx, thread.projectId, thread.id, "stood-down", "send-failed", extra);
    return;
  }
  if (result.delivery === "queued") {
    await writeState(bb, thread.id, {
      phase: "pending-dispatch",
      pendingEntryId: result.queuedMessage.id,
    });
  }
  await recordFire(ctx, thread.projectId, thread.id, "fired", "fired", extra);
}

export async function dispatchReview(
  ctx: ReviewContext,
  input: DispatchInput,
): Promise<void> {
  const { thread, state, environmentId, config, decision, base, isWorktree, scope, turn } = input;
  const extra: FireExtra = {
    commit: decision.commit,
    merge: decision.merge,
    base,
    isWorktree,
    scopePaths: scope,
  };
  await withProviderLock(thread.providerId, async () => {
    if (await providerReviewInFlight(ctx, thread.providerId, thread.id)) {
      await deferTurn(ctx, thread, state, environmentId, {
        reason: "sibling-active",
        extra,
      });
      return;
    }

    const prompt = buildReviewPrompt({
      decision,
      reviewMode: config.reviewMode,
      scope: renderScope(scope),
      committedSince:
        turn.commits.length > 0 ? (state.turnStart?.tree?.headSha ?? null) : null,
      aislopScan: await aislopScanAvailable(ctx.bb),
    });
    await sendReview(ctx, thread, prompt, extra);
  });
}
