import type { ReviewContext } from "./context.js";
import { removeDeferral } from "./deferrals.js";
import { deleteFindings } from "./findings-store.js";
import { recordUnfinishedReview } from "./review-outcome.js";
import { releaseDeferred, sweepDeferrals, sweepOrphanFindings } from "./release.js";
import { removeReview } from "./reviews.js";
import {
  readState,
  resetToIdlePatch,
  withThreadLock,
  writeState,
} from "./state.js";

/**
 * Clears a thread's latch and its index entries. A deleted thread's findings
 * go with it; a failed or archived one keeps them, and a review it was in the
 * middle of is recorded as not reported so the badge never shows the review
 * before it.
 */
export function unlatch(
  ctx: ReviewContext,
  threadId: string,
  deleted = false,
): Promise<void> {
  const { bb } = ctx;
  return withThreadLock(threadId, async () => {
    const state = await readState(bb, threadId);
    if (!deleted) {
      await recordUnfinishedReview(bb, threadId, state, "gone");
    }
    if (state.phase !== "idle") {
      const { set, remove } = resetToIdlePatch();
      await writeState(bb, threadId, set, remove);
    }
    await removeDeferral(bb, threadId);
    await removeReview(bb, threadId);
    if (deleted) {
      await deleteFindings(bb, threadId);
    }
  });
}

/** A failed, archived or deleted thread may have been the review a turn was parked behind. */
async function onThreadGone(
  ctx: ReviewContext,
  { thread }: { thread: { id: string; providerId: string } },
  deleted = false,
): Promise<void> {
  await unlatch(ctx, thread.id, deleted);
  await releaseDeferred(ctx, thread.providerId);
}

export function registerLifecycleEvents(ctx: ReviewContext): void {
  const { bb } = ctx;
  bb.background.schedule("sweep-deferrals", "*/5 * * * *", async () => {
    // Independent backstops: one failing must not skip the other.
    for (const [name, sweep] of [
      ["deferrals", sweepDeferrals],
      ["orphan findings", sweepOrphanFindings],
    ] as const) {
      try {
        await sweep(ctx);
      } catch (error) {
        bb.log.warn(
          `auto-review: the ${name} sweep failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  });

  // A failed, archived or deleted thread may have been the review a turn was
  // parked behind, and it will not go idle to release it.
  bb.events.on("thread.failed", (payload) => onThreadGone(ctx, payload));
  bb.events.on("thread.archived", (payload) => onThreadGone(ctx, payload));
  bb.events.on("thread.deleted", (payload) => onThreadGone(ctx, payload, true));
}
