import type { FireReason } from "./config.js";
import {
  recordFire,
  type FireExtra,
  type GateThreadLike,
  type ReviewContext,
} from "./context.js";
import { removeDeferral } from "./deferrals.js";
import { resetToIdlePatch, writeState, type ThreadState } from "./state.js";

/**
 * End the turn without a review. A turn that had been deferred is unparked
 * here too — otherwise a deferral that later turns out to have nothing to
 * review would latch the thread in `deferred` and freeze its cursor.
 */
export async function standDown(
  ctx: ReviewContext,
  thread: GateThreadLike,
  state: ThreadState,
  reason: FireReason,
  extra: FireExtra = {},
): Promise<void> {
  const { bb } = ctx;
  if (state.phase === "deferred") {
    const { set, remove } = resetToIdlePatch();
    await writeState(bb, thread.id, set, remove);
    await removeDeferral(bb, thread.id);
  }
  await recordFire(ctx, thread.projectId, thread.id, "stood-down", reason, extra);
}

/**
 * Leaves the thread idle with its turn cursor kept and the turn undecided, so
 * the next `thread.active` keeps the earlier cursor and the review that
 * eventually fires covers this turn's work too. A parked turn is unparked.
 */
export async function keepCursor(ctx: ReviewContext, thread: GateThreadLike, state: ThreadState): Promise<void> {
  const { bb } = ctx;
  await writeState(bb, thread.id, { phase: "idle" }, [
    "deferredSince",
    "turnDecided",
    "heldBy",
  ]);
  if (state.phase === "deferred") {
    await removeDeferral(bb, thread.id);
  }
}
