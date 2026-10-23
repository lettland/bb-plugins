import { createHash } from "node:crypto";
import type { FireReason } from "./config.js";
import { recordFire, type GateThreadLike, type ReviewContext } from "./context.js";
import type { PlanApproval } from "./plan.js";
import { readState, writeState, type ThreadState } from "./state.js";

/** Sha256 hex of the plan text, for the one-shot `planReleased` record. */
export function planHash(plan: string): string {
  return createHash("sha256").update(plan).digest("hex");
}

/** How many interaction ids `autoResolvedPlanIds` keeps: enough to cover every approval a hold can judge, small enough to stay a record, not a log. */
const AUTO_RESOLVED_PLAN_IDS_MAX = 10;

/**
 * Resolve a plan approval `allow_once` and record the fire under `reason`;
 * `failureLead` and `successLine` are the caller's warn lead and success line.
 * False (warned) leaves the plan where its caller says.
 *
 * The interaction id is recorded under `autoResolvedPlanIds` **before** the
 * resolve, read fresh from the state (`approvePlan` has no `state` argument,
 * and `reapproveSamePlan`'s is stale after its own write): the lifecycle event
 * that records the resolution carries no resolver, so this record is the only
 * way a hold idle tells an approval auto-review gave itself from one the user
 * gave — and writing first means the event can never be read before the id is
 * recorded. A resolve that then fails removes the id again; a removal that
 * fails is logged with the interaction id, since a stale id only makes a later
 * manual approval of the same interaction count as automatic, and its work
 * would then get no follow-up review.
 */
async function resolvePlanApproval(
  ctx: ReviewContext,
  thread: GateThreadLike,
  approval: PlanApproval,
  reason: FireReason,
  failureLead: string,
  successLine: string,
): Promise<boolean> {
  const { bb } = ctx;
  try {
    // Read fresh, so two approvals resolving in one turn keep each other's ids.
    const { autoResolvedPlanIds } = await readState(bb, thread.id);
    await writeState(bb, thread.id, {
      autoResolvedPlanIds: [...(autoResolvedPlanIds ?? []), approval.interactionId].slice(
        -AUTO_RESOLVED_PLAN_IDS_MAX,
      ),
    });
    try {
      await bb.sdk.threads.interactions.resolve({
        threadId: thread.id,
        interactionId: approval.interactionId,
        resolution: { decision: "allow_once", grantedPermissions: null },
      });
    } catch (error) {
      try {
        const after = await readState(bb, thread.id);
        await writeState(bb, thread.id, {
          autoResolvedPlanIds: (after.autoResolvedPlanIds ?? []).filter(
            (id) => id !== approval.interactionId,
          ),
        });
      } catch (removalError) {
        bb.log.warn(
          `auto-review: could not unrecord the auto-approval of interaction ${approval.interactionId} in ${thread.id}; a later manual approval of it may be mistaken for an automatic one: ${
            removalError instanceof Error ? removalError.message : String(removalError)
          }`,
        );
      }
      throw error;
    }
  } catch (error) {
    bb.log.warn(
      `${failureLead}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return false;
  }
  await recordFire(ctx, thread.projectId, thread.id, "fired", reason);
  bb.log.info(successLine);
  return true;
}

/** Resolve the reviewed plan `allow_once`; false (logged) leaves it with the user. */
export async function approvePlan(
  ctx: ReviewContext,
  thread: GateThreadLike,
  approval: PlanApproval,
): Promise<boolean> {
  return resolvePlanApproval(
    ctx,
    thread,
    approval,
    "plan-approved",
    `auto-review: could not auto-approve the reviewed plan in ${thread.id}; leaving it for the user`,
    `auto-review: auto-approved the reviewed plan ${approval.interactionId} in thread ${thread.id}`,
  );
}

/**
 * Whether a plan presented again right after the gate left an identical one
 * with the user is that plan re-presented in the same turn, and can be
 * approved again on that earlier approval instead of being held for another
 * review round — the gate has disarmed, so the hold's usual "a review is
 * still pending" guarantee is gone, and only this record (`planReleased`,
 * written at the release) vouches for the repetition. The guarantees are
 * checkable: the identical plan text (same hash), the earlier interaction
 * resolved as an approval (`allow_once` or `allow_for_session`), and no
 * `turn/completed` or `turn/input/accepted` since the release — no turn ended
 * and no message was delivered, so the re-presentation cannot carry anything
 * new. The record is one-shot: removed before any check, so a different plan,
 * a held plan or a later turn can never reuse it.
 */
export async function reapproveSamePlan(
  ctx: ReviewContext,
  thread: GateThreadLike,
  state: ThreadState,
  approval: PlanApproval,
): Promise<boolean> {
  const { bb } = ctx;
  const released = state.planReleased;
  if (released === undefined) {
    return false;
  }
  await writeState(bb, thread.id, {}, ["planReleased"]);
  if (!approval.canApprove || released.planHash !== planHash(approval.plan)) {
    return false;
  }
  try {
    const earlier = await bb.sdk.threads.interactions.get({
      threadId: thread.id,
      interactionId: released.interactionId,
    });
    const resolution = earlier.resolution;
    if (
      earlier.status !== "resolved" ||
      resolution === null ||
      !("decision" in resolution) ||
      (resolution.decision !== "allow_once" && resolution.decision !== "allow_for_session")
    ) {
      return false;
    }
    const events = await bb.sdk.threads.events.list({
      threadId: thread.id,
      afterSeq: String(released.releasedSeq),
      types: ["turn/completed", "turn/input/accepted"],
      limit: "1",
    });
    if (events.length > 0) {
      return false;
    }
  } catch (error) {
    bb.log.warn(
      `auto-review: could not check the earlier approval of this plan in ${thread.id}; leaving it for a normal review: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return false;
  }
  return resolvePlanApproval(
    ctx,
    thread,
    approval,
    "plan-already-approved",
    `auto-review: could not re-approve the re-presented plan in ${thread.id}; leaving it for a normal review`,
    `auto-review: approved plan ${approval.interactionId} in thread ${thread.id} again: the identical plan ${released.interactionId} was approved earlier in this turn`,
  );
}
