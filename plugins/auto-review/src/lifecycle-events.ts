import type { ReviewContext } from "./context.js";
import { removeDeferral } from "./deferrals.js";
import { releaseDeferred, sweepDeferrals } from "./release.js";
import { removeReview } from "./reviews.js";
import {
  readState,
  resetToIdlePatch,
  withThreadLock,
  writeState,
} from "./state.js";

export function unlatch(ctx: ReviewContext, threadId: string): Promise<void> {
  const { bb } = ctx;
  return withThreadLock(threadId, async () => {
    const state = await readState(bb, threadId);
    if (state.phase !== "idle") {
      const { set, remove } = resetToIdlePatch();
      await writeState(bb, threadId, set, remove);
    }
    await removeDeferral(bb, threadId);
    await removeReview(bb, threadId);
  });
}

/** A failed, archived or deleted thread may have been the review a turn was parked behind. */
async function onThreadGone(
  ctx: ReviewContext,
  { thread }: { thread: { id: string; providerId: string } },
): Promise<void> {
  await unlatch(ctx, thread.id);
  await releaseDeferred(ctx, thread.providerId);
}

export function registerLifecycleEvents(ctx: ReviewContext): void {
  const { bb } = ctx;
  bb.background.schedule("sweep-deferrals", "*/5 * * * *", () => sweepDeferrals(ctx));

  // A failed, archived or deleted thread may have been the review a turn was
  // parked behind, and it will not go idle to release it.
  bb.events.on("thread.failed", (payload) => onThreadGone(ctx, payload));
  bb.events.on("thread.archived", (payload) => onThreadGone(ctx, payload));
  bb.events.on("thread.deleted", (payload) => onThreadGone(ctx, payload));
}
