import type { FireReason } from "./config.js";
import {
  recordFire,
  type FireExtra,
  type GateThreadLike,
  type ReviewContext,
} from "./context.js";
import { addDeferral, type Deferral } from "./deferrals.js";
import { isBusyStatus, reviewInFlight } from "./gate.js";
import { readReviews, removeReview } from "./reviews.js";
import {
  readState,
  REVIEW_IN_FLIGHT_PHASES,
  writeState,
  type ThreadState,
} from "./state.js";

export interface DeferTurnOptions {
  reason: FireReason;
  /** The running children holding the turn; absent waits on a provider review instead. */
  heldBy?: string[];
  extra?: FireExtra;
}

/**
 * Park this turn instead of dropping it. The turn-start cursor is left in
 * place, so when the blocking review ends this review still covers the work
 * this turn authored — and `thread.active` carries that cursor forward if
 * the thread takes another turn in the meantime.
 */
export async function deferTurn(
  ctx: ReviewContext,
  thread: GateThreadLike,
  state: ThreadState,
  environmentId: string,
  options: DeferTurnOptions,
): Promise<void> {
  const { bb } = ctx;
  const { reason, heldBy, extra = {} } = options;
  // Index first, state second. The sweep enumerates the index and prunes an
  // entry whose thread is not actually deferred, so an interruption between
  // these two writes leaves a harmless orphan the next sweep cleans up. The
  // reverse order would leave a thread parked with no index entry — invisible
  // to the sweep, which is the one stranding case the sweep exists to fix.
  await addDeferral(bb, {
    threadId: thread.id,
    projectId: thread.projectId,
    environmentId,
    providerId: thread.providerId,
  });
  const deferredPatch = {
    phase: "deferred" as const,
    deferredSince: state.deferredSince ?? Date.now(),
  };
  if (heldBy === undefined) {
    await writeState(bb, thread.id, deferredPatch, ["heldBy"]);
  } else {
    await writeState(bb, thread.id, { ...deferredPatch, heldBy });
  }
  await recordFire(ctx, thread.projectId, thread.id, "deferred", reason, extra);
}

/**
 * Whether a thread other than `exceptThreadId` has an auto-review queued or
 * running on this provider, in any project. Index entries whose thread no
 * longer holds a review — or no longer exists — are pruned on the way.
 */
export async function providerReviewInFlight(
  ctx: ReviewContext,
  providerId: string,
  exceptThreadId: string | null,
): Promise<boolean> {
  const { bb } = ctx;
  const now = Date.now();
  for (const entry of await readReviews(bb)) {
    if (entry.threadId === exceptThreadId || entry.providerId !== providerId) {
      continue;
    }
    let state: ThreadState;
    let status: string;
    try {
      [state, { status }] = await Promise.all([
        readState(bb, entry.threadId),
        bb.sdk.threads.get({ threadId: entry.threadId }),
      ]);
    } catch {
      await removeReview(bb, entry.threadId);
      continue;
    }
    if (!REVIEW_IN_FLIGHT_PHASES.includes(state.phase)) {
      await removeReview(bb, entry.threadId);
      continue;
    }
    if (reviewInFlight({ state, busy: isBusyStatus(status) }, now)) {
      return true;
    }
  }
  return false;
}

/** The provider a parked turn waits on; entries parked before it was indexed look it up. */
export async function deferralProviderId(ctx: ReviewContext, entry: Deferral): Promise<string | null> {
  const { bb } = ctx;
  if (entry.providerId !== undefined) {
    return entry.providerId;
  }
  try {
    return (await bb.sdk.threads.get({ threadId: entry.threadId })).providerId;
  } catch {
    return null;
  }
}
