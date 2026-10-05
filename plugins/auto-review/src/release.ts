import type { ReviewContext } from "./context.js";
import { deferralProviderId, providerReviewInFlight } from "./deferral.js";
import { readDeferrals, removeDeferral } from "./deferrals.js";
import { evaluate } from "./evaluate.js";
import { passesThreadGate } from "./gate.js";
import {
  readState,
  resetToIdlePatch,
  withThreadLock,
  writeState,
} from "./state.js";

/**
 * Resolve a thread id to a gated thread and evaluate it under its own lock.
 * Returns whether evaluation actually ran; `onUnusable` is called when the
 * thread is gone or no longer gated, so each caller can clean up its own way.
 */
export async function resolveAndEvaluate(
  ctx: ReviewContext,
  threadId: string,
  onUnusable: (why: string) => Promise<void>,
): Promise<boolean> {
  const { bb } = ctx;
  let candidate: Awaited<ReturnType<typeof bb.sdk.threads.get>>;
  try {
    candidate = await bb.sdk.threads.get({ threadId });
  } catch (error) {
    await onUnusable(error instanceof Error ? error.message : String(error));
    return false;
  }
  if (!passesThreadGate(candidate)) {
    await onUnusable("thread no longer passes the auto-review thread gate");
    return false;
  }
  await withThreadLock(threadId, () =>
    evaluate(ctx, { ...candidate, id: threadId, projectId: candidate.projectId }),
  );
  return true;
}

/**
 * A review on this provider may just have ended, so let one turn parked on
 * the provider through — from any project. One review per call: the released
 * turn latches its own review immediately, and that review's end drives the
 * next release. A parked turn that turns out to start no review (nothing left
 * to review, or unusable) does not end the call, or the turns behind it would
 * wait for the sweep.
 */
export async function releaseDeferred(ctx: ReviewContext, providerId: string): Promise<void> {
  const { bb } = ctx;
  if (await providerReviewInFlight(ctx, providerId, null)) {
    return;
  }
  for (const entry of await readDeferrals(bb)) {
    if ((await deferralProviderId(ctx, entry)) !== providerId) {
      continue;
    }
    const state = await readState(bb, entry.threadId);
    if (state.phase !== "deferred") {
      await removeDeferral(bb, entry.threadId);
      continue;
    }
    // A child-held turn is not waiting on a provider review; releasing it
    // here on an unrelated same-provider idle could beat bb's wake-up
    // message. Only the sweep re-evaluates it.
    if (state.heldBy !== undefined) {
      continue;
    }
    await resolveAndEvaluate(ctx, entry.threadId, async (why) => {
      bb.log.warn(
        `auto-review: could not release deferred thread ${entry.threadId}: ${why}`,
      );
    });
    if (await providerReviewInFlight(ctx, providerId, null)) {
      return;
    }
  }
}

/**
 * The backstop for a release no event delivered. The review that parked a
 * turn normally releases it from its own idle, but that idle can be missed —
 * a restart, or a blocker that was deleted or left a stale latch behind.
 * Each pass retries every parked turn whose provider no longer has a review
 * in flight.
 */
export async function sweepDeferrals(ctx: ReviewContext): Promise<void> {
  const { bb } = ctx;
  for (const entry of await readDeferrals(bb)) {
    const state = await readState(bb, entry.threadId);
    if (state.phase !== "deferred") {
      await removeDeferral(bb, entry.threadId);
      continue;
    }
    // Same veto `releaseDeferred` applies, and it is what keeps this loop to
    // one release per provider: `evaluate` indexes its review before it
    // sends, so a second entry on the same provider sees the first thread's
    // review in flight and waits for the next pass. A provider that cannot
    // be resolved means the thread is gone, which `resolveAndEvaluate`
    // reports as unusable.
    const providerId = await deferralProviderId(ctx, entry);
    if (
      providerId !== null &&
      (await providerReviewInFlight(ctx, providerId, entry.threadId))
    ) {
      continue;
    }
    await resolveAndEvaluate(ctx, entry.threadId, async (why) => {
      // Unpark as well as de-index. Dropping the index entry alone would
      // leave the thread latched in `deferred` and invisible to every later
      // sweep — the stranding this sweep exists to prevent.
      bb.log.warn(
        `auto-review: dropping the deferred turn for ${entry.threadId}: ${why}`,
      );
      const { set, remove } = resetToIdlePatch();
      await writeState(bb, entry.threadId, set, remove);
      await removeDeferral(bb, entry.threadId);
    });
  }
}
