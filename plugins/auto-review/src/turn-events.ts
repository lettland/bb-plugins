import type { PluginThreadEventPayloads } from "@get-bb/plugin-sdk";
import type { ReviewContext } from "./context.js";
import { captureSinceSeq, captureTree } from "./detect.js";
import { handleIdle } from "./evaluate.js";
import { passesThreadGate } from "./gate.js";
import { releaseDeferred } from "./release.js";
import { removeReview } from "./reviews.js";
import {
  PLAN_GATE_KEYS,
  readState,
  resetToIdlePatch,
  withThreadLock,
  writeState,
} from "./state.js";

export async function onThreadActive(
  ctx: ReviewContext,
  { thread }: PluginThreadEventPayloads["thread.active"],
): Promise<void> {
  const { bb } = ctx;
  if (!passesThreadGate(thread)) {
    return;
  }
  await withThreadLock(thread.id, async () => {
    const state = await readState(bb, thread.id);
    if (
      (state.phase === "deferred" || state.turnDecided !== true) &&
      state.turnStart !== undefined
    ) {
      // A deferred turn, or one no idle has decided yet (its review was
      // folded into this turn, or its idle is still to be handled), is owed
      // a review. Keep its (earlier) cursor so the eventual review covers
      // that turn's work as well as this one's, instead of starting the
      // authorship window over and losing it.
      return;
    }
    const startedAt = Date.now();
    // The tree as this turn found it, so edits no timeline row records
    // (shell commands, scripts, commits) are still attributed at idle.
    // Taken alongside the cursor: the agent is already running, and an edit
    // that lands before the snapshot would be absorbed into it.
    const [sinceSeq, tree] = await Promise.all([
      captureSinceSeq(bb, thread.id),
      thread.environmentId === null
        ? Promise.resolve(undefined)
        : captureTree(bb, thread.environmentId),
    ]);
    await writeState(
      bb,
      thread.id,
      { turnStart: { sinceSeq, startedAt, ...(tree === undefined ? {} : { tree }) } },
      ["turnDecided"],
    );
  });
}

export async function onThreadIdle(
  ctx: ReviewContext,
  { thread }: PluginThreadEventPayloads["thread.idle"],
): Promise<void> {
  const { bb } = ctx;
  if (!passesThreadGate(thread)) {
    return;
  }
  await withThreadLock(thread.id, async () => {
    // The turn ended, so any `planDenied` cursor from a deny earlier in it
    // is no longer "the next tool call" for anything — clear it, when
    // present, before handleIdle's own early returns so a question in some
    // later turn is never mistaken for a reaction to this one's deny.
    const state = await readState(bb, thread.id);
    if (state.planDenied !== undefined) {
      try {
        await writeState(bb, thread.id, {}, ["planDenied"]);
      } catch (error) {
        bb.log.warn(
          `auto-review: could not clear planDenied in ${thread.id}; continuing: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    await handleIdle(ctx, thread);
  });
  // Outside the thread lock, and outside evaluate's provider lock, so
  // releasing another turn cannot deadlock against the work we just did.
  await releaseDeferred(ctx, thread.providerId);
}

export async function onMessageDispatched(
  ctx: ReviewContext,
  { entry }: PluginThreadEventPayloads["message.dispatched"],
): Promise<void> {
  const { bb } = ctx;
  await withThreadLock(entry.threadId, async () => {
    const state = await readState(bb, entry.threadId);
    if (state.planReviewEntryId === entry.id) {
      // The review is in the agent's hands; its next presentation is the
      // reviewed plan.
      await writeState(bb, entry.threadId, {}, ["planReviewEntryId"]);
      return;
    }
    if (
      state.phase === "pending-dispatch" &&
      state.pendingEntryId === entry.id
    ) {
      await writeState(bb, entry.threadId, { phase: "awaiting-review" }, [
        "pendingEntryId",
      ]);
    }
  });
}

export async function onMessageCancelled(
  ctx: ReviewContext,
  { entry }: PluginThreadEventPayloads["message.cancelled"],
): Promise<void> {
  const { bb } = ctx;
  const cancelledReview = await withThreadLock(entry.threadId, async () => {
    const state = await readState(bb, entry.threadId);
    if (state.planReviewEntryId === entry.id) {
      // The review never ran, so the next plan still owes one.
      await writeState(bb, entry.threadId, {}, [...PLAN_GATE_KEYS]);
      return false;
    }
    if (
      state.phase === "pending-dispatch" &&
      state.pendingEntryId === entry.id
    ) {
      const { set, remove } = resetToIdlePatch();
      await writeState(bb, entry.threadId, set, remove);
      await removeReview(bb, entry.threadId);
      return true;
    }
    return false;
  });
  if (cancelledReview) {
    const { providerId } = await bb.sdk.threads.get({ threadId: entry.threadId });
    await releaseDeferred(ctx, providerId);
  }
}

export function registerTurnEvents(ctx: ReviewContext): void {
  ctx.bb.events.on("thread.active", (payload) => onThreadActive(ctx, payload));
  ctx.bb.events.on("thread.idle", (payload) => onThreadIdle(ctx, payload));
  ctx.bb.events.on("message.dispatched", (payload) => onMessageDispatched(ctx, payload));
  ctx.bb.events.on("message.cancelled", (payload) => onMessageCancelled(ctx, payload));
}
