import { basename } from "node:path";
import type { PluginThreadEventPayloads } from "@get-bb/plugin-sdk";
import { clearPlanBaseline, planScope, settlePlanBaseline, stagePlanPending } from "./baseline-store.js";
import { effectiveConfig, readProjectConfig } from "./config.js";
import {
  queuedRowExists,
  recordFire,
  type EffectiveConfig,
  type GateThreadLike,
  type ReviewContext,
} from "./context.js";
import { captureSinceSeq, tryCaptureSinceSeq } from "./detect.js";
import { passesThreadGate, planGateServes } from "./gate.js";
import { approvePlan, planHash, reapproveSamePlan } from "./plan-approve.js";
import { answerPlanHoldQuestion } from "./plan-hold-answer.js";
import {
  planApprovalOf,
  planGateAction,
  planReleaseReason,
  planSkillCheck,
  reviewRanSince,
  userQuestionOf,
  warnPlanUnreviewed,
  type PlanApproval,
} from "./plan.js";
import { planHoldDenyMessage } from "./prompt-plan.js";
import { buildPlanReviewPrompt, buildPlanReviewRedoPrompt } from "./prompt.js";
import { REPORT_REVIEW_TOOL_NAME } from "./report-tool.js";
import {
  PLAN_GATE_KEYS,
  planHoldExpired,
  readState,
  withThreadLock,
  writeState,
  type ThreadState,
} from "./state.js";

/**
 * The plan gate's own tools: completing one of these is not the agent working on the review.
 * `ReportReview` is auto-review's own bookkeeping, so even a rejected call proves nothing.
 */
const NATIVE_GATE_TOOLS = ["ExitPlanMode", "EnterPlanMode", "AskUserQuestion", REPORT_REVIEW_TOOL_NAME];

/**
 * Hold a plan's first presentation for review. The review turn is queued
 * BEFORE the approval is denied: a thread awaiting an interaction cannot take
 * a prompt, so the turn waits on the approval and core steers it the moment
 * the deny settles. The deny carries auto-review's own hold text
 * (`planHoldDenyMessage`), so the agent is not told its plan was rejected
 * while it waits; the steered review still only reaches it after its next
 * tool result (Claude Code hands a steered message to the model only then).
 * In between, the agent may still ask the user what to change — `denyPlan`
 * leaves a short-lived `planDenied` cursor for exactly that, which the
 * `interaction.pending` handler below uses to answer that one question
 * itself.
 */
export async function gatePlan(
  ctx: ReviewContext,
  thread: GateThreadLike,
  approval: PlanApproval,
): Promise<void> {
  const { bb } = ctx;
  const state = await readState(bb, thread.id);
  const project = await readProjectConfig(bb, thread.projectId);
  const config = effectiveConfig(ctx.globals, project);
  if (!planGateServes(thread, config)) {
    return;
  }

  const action = planGateAction(state, Date.now());
  if (action === "release") {
    await releaseReviewedPlan(ctx, thread, state, approval, config);
    return;
  }
  if (action === "hold") {
    await holdOrReleasePlan(ctx, thread, state, approval, config);
    return;
  }
  if (await reapproveSamePlan(ctx, thread, state, approval)) {
    return;
  }

  // A new cycle starts clean: keys left by an expired earlier one (a delivery
  // cursor, a queued id) must never leak into this review's evidence.
  await writeState(
    bb,
    thread.id,
    { planReviewArmedAt: Date.now() },
    PLAN_GATE_KEYS.filter((key) => key !== "planReviewArmedAt"),
  );
  const now = Date.now();
  const prompt = buildPlanReviewPrompt({
    reviewMode: config.reviewMode,
    planFilePath: approval.planFilePath,
    autoApprove: config.autoApprovePlans,
    baseline: await planScope(bb, thread.id, approval.planFilePath, approval.plan, now),
  });
  if (await armReview(ctx, thread, approval, prompt)) {
    await stagePlanPending(bb, thread.id, approval.planFilePath, approval.plan, now);
    await recordFire(ctx, thread.projectId, thread.id, "fired", "plan-review");
  }
}

/**
 * Queue a review turn and deny the plan so it lands, for the first
 * presentation and for a redo alike. The cursor the `review-code` check reads
 * from is captured before the send, while the held approval keeps the agent
 * from running tools, so nothing earlier can match; the delivery cursor lands
 * later on purpose and would hide a load the prompt itself triggered. Returns
 * whether the plan is held: false means it is left with the user and the gate
 * is disarmed.
 */
async function armReview(
  ctx: ReviewContext,
  thread: GateThreadLike,
  approval: PlanApproval,
  prompt: string,
): Promise<boolean> {
  const { bb } = ctx;
  const armedSeq = await tryCaptureSinceSeq(
    bb,
    thread.id,
    `the plan review in ${thread.id}; the plan will not be auto-approved or sent back for review-code`,
  );
  await writeState(
    bb,
    thread.id,
    armedSeq === undefined ? {} : { planReviewArmedSeq: armedSeq },
    armedSeq === undefined ? ["planReviewArmedSeq"] : undefined,
  );
  let queuedMessageId: string | null = null;
  try {
    const result = await bb.sdk.threads.send({
      threadId: thread.id,
      mode: "auto",
      input: [{ type: "text", text: prompt, mentions: [] }],
    });
    if (result.delivery === "queued") {
      queuedMessageId = result.queuedMessage.id;
      await writeState(bb, thread.id, { planReviewEntryId: queuedMessageId });
    } else {
      // v8 ignore else -- @preserve the SDK answers queued or sent and nothing else (sendMessageResponseSchema is a discriminated union of "sent" and "queued" delivery literals, node_modules/@get-bb/plugin-sdk/bundled-types/bb-plugin-sdk.d.ts:12313 and :12316), so this side cannot run.
      if (result.delivery === "sent") {
        // Straight into the turn, so there is no dispatch event: the cursor
        // right after the send is where the review's delivery starts.
        await markReviewDelivered(ctx, thread.id);
      }
    }
  } catch (error) {
    // Nothing was queued, so leave the plan with the user untouched.
    bb.log.warn(
      `auto-review: failed to queue the plan review for ${thread.id}; leaving the plan for the user: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    await writeState(bb, thread.id, {}, [...PLAN_GATE_KEYS]);
    await recordFire(ctx, thread.projectId, thread.id, "stood-down", "send-failed");
    return false;
  }
  return denyPlan(ctx, thread, approval, queuedMessageId);
}

/** Records where the plan review reached the agent; failing to means the plan is never auto-approved. */
async function markReviewDelivered(ctx: ReviewContext, threadId: string): Promise<void> {
  const { bb } = ctx;
  try {
    await writeState(bb, threadId, {
      planReviewDeliveredSeq: await captureSinceSeq(bb, threadId),
    });
  } catch (error) {
    bb.log.warn(
      `auto-review: could not record where the plan review was delivered in ${threadId}; the plan will not be auto-approved: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

/**
 * The reviewed plan comes back. When the plan review should have loaded
 * `review-code` and the agent never did (`planSkillCheck`), the plan goes back
 * once for a full review instead; the second miss, or an unreadable check,
 * releases it without an auto-approve. Otherwise disarm the gate, then approve
 * it for the user only when the project opted in AND everything shows the
 * review cycle completed — the skill was loaded, the review was delivered, the
 * arm is fresh, and the agent completed a tool call of its own after delivery
 * (which is when a steered message reaches the model) with no turn ending
 * since, so a stale arm from a review turn that never re-presented through the
 * gate cannot approve a later plan. Anything less leaves the plan with the
 * user, exactly as with the option off.
 *
 * The redo is decided from `state` before the gate's keys are cleared, which
 * would erase `planReviewRedone`. An expired arm is never checked or redone:
 * nothing ties its review to this plan.
 */
async function releaseReviewedPlan(
  ctx: ReviewContext,
  thread: GateThreadLike,
  state: ThreadState,
  approval: PlanApproval,
  config: EffectiveConfig,
): Promise<void> {
  const { bb } = ctx;
  const expired = planHoldExpired(state, Date.now());
  const check = expired
    ? "loaded"
    : await planSkillCheck(bb, thread.id, config.reviewMode, state.planReviewArmedSeq);
  if (check === "missing" && state.planReviewRedone !== true) {
    await redoPlanReview(ctx, thread, approval, config);
    return;
  }
  await writeState(bb, thread.id, {}, [...PLAN_GATE_KEYS]);
  const { planReviewDeliveredSeq } = state;
  // The baseline accepts a review that spans turns: child-thread reviewers end
  // the turn and bb wakes the agent later. Auto-approve still needs the
  // same-turn proof.
  const reviewWorked =
    check === "loaded" &&
    planReviewDeliveredSeq !== undefined &&
    !expired &&
    (await reviewRanSince(bb, thread.id, planReviewDeliveredSeq, NATIVE_GATE_TOOLS, false, true));
  const reviewRan =
    reviewWorked &&
    planReviewDeliveredSeq !== undefined &&
    (await reviewRanSince(bb, thread.id, planReviewDeliveredSeq, NATIVE_GATE_TOOLS, false, false));
  await settlePlanBaseline(bb, thread.id, approval.planFilePath, reviewWorked);
  if (reviewRan && config.autoApprovePlans && approval.canApprove && (await approvePlan(ctx, thread, approval))) {
    await clearPlanBaseline(bb, thread.id, approval.planFilePath);
    return;
  }
  if (check !== "loaded") {
    warnPlanUnreviewed(
      bb,
      thread.id,
      approval.planFilePath === null ? approval.interactionId : basename(approval.planFilePath),
      check,
    );
  }
  // The plan stays with the user, so remember it once: a re-presentation of
  // this exact plan in the same turn is the user's approval arriving again
  // (see `reapproveSamePlan`), not a new plan to hold. Auto-approved plans
  // never reach this path, so auto-review's own approval can never stand in
  // for the user's.
  const releasedSeq = await tryCaptureSinceSeq(
    bb,
    thread.id,
    `the plan left with the user in ${thread.id}; without it a same-turn re-presentation of the approved plan is held for review again`,
  );
  if (releasedSeq !== undefined) {
    await writeState(bb, thread.id, {
      planReleased: {
        interactionId: approval.interactionId,
        planHash: planHash(approval.plan),
        releasedSeq,
      },
    });
  }
  await recordFire(ctx, thread.projectId, thread.id, "stood-down", planReleaseReason(check));
}

/**
 * Send a plan back for a full review: re-arm the gate with a fresh clock and
 * cursor, mark the cycle as redone so the next release cannot redo again, and
 * drop the first round's queued id, delivery cursor and deny cursor so none of
 * them stands in for the redo's.
 */
async function redoPlanReview(
  ctx: ReviewContext,
  thread: GateThreadLike,
  approval: PlanApproval,
  config: EffectiveConfig,
): Promise<void> {
  const { bb } = ctx;
  await writeState(
    bb,
    thread.id,
    { planReviewArmedAt: Date.now(), planReviewRedone: true },
    ["planReviewEntryId", "planReviewDeliveredSeq", "planDenied"],
  );
  // The redo reviews the whole plan: its baseline goes before the prompt is built.
  await clearPlanBaseline(bb, thread.id, approval.planFilePath);
  const prompt = buildPlanReviewRedoPrompt({
    reviewMode: config.reviewMode,
    planFilePath: approval.planFilePath,
    autoApprove: config.autoApprovePlans,
  });
  if (await armReview(ctx, thread, approval, prompt)) {
    await stagePlanPending(bb, thread.id, approval.planFilePath, approval.plan, Date.now());
    await recordFire(ctx, thread.projectId, thread.id, "fired", "plan-review-redo");
  }
}

/**
 * A plan re-presented while its review is recorded as queued. Hold it only
 * while the review really is still in the queue and has not been there past
 * the stale window: the recorded id is cleared only by `message.dispatched`
 * or `message.cancelled`, so trusting it alone would turn one missed event
 * into a deny of every plan the thread presents from then on.
 */
async function holdOrReleasePlan(
  ctx: ReviewContext,
  thread: GateThreadLike,
  state: ThreadState,
  approval: PlanApproval,
  config: EffectiveConfig,
): Promise<void> {
  const { bb } = ctx;
  const entryId = state.planReviewEntryId ??
    // v8 ignore start -- @preserve the only caller (gatePlan, plan-gate.ts:74) runs this when planGateAction returned "hold", which requires state.planReviewEntryId to be defined (plan.ts:380), so the null fallback cannot run.
    null;
  // v8 ignore stop
  const queued =
    entryId !== null && (await queuedRowExists(ctx, thread.id, entryId));
  const expired = planHoldExpired(state, Date.now());
  if (queued && !expired) {
    // The review is still queued behind this approval; denying lets it in.
    await denyPlan(ctx, thread, approval, entryId);
    return;
  }
  if (queued && entryId !== null) {
    // Withdraw it, or it would land in the middle of implementing the plan
    // this release hands to the user.
    await withdrawQueuedReview(ctx, thread.id, entryId);
  }
  if (!queued) {
    // Not queued any more means the review was dispatched and this is the
    // reviewed plan, whose dispatch event never reached us.
    await releaseReviewedPlan(ctx, thread, state, approval, config);
    return;
  }
  await writeState(bb, thread.id, {}, [...PLAN_GATE_KEYS]);
  await recordFire(ctx, thread.projectId, thread.id, "stood-down", "plan-hold-expired");
}

async function withdrawQueuedReview(
  ctx: ReviewContext,
  threadId: string,
  queuedMessageId: string,
): Promise<void> {
  const { bb } = ctx;
  await bb.sdk.threads.queuedMessages
    .delete({ threadId, queuedMessageId })
    .catch((deleteError: unknown) => {
      bb.log.warn(
        `auto-review: could not withdraw the queued plan review ${queuedMessageId} in ${threadId}: ${
          deleteError instanceof Error ? deleteError.message : String(deleteError)
        }`,
      );
    });
}

/**
 * The deny a plan hold resolves with. SDK 0.5.9 predates the resolution's
 * `message` — a newer core delivers it as the agent-facing deny text, and an
 * older host's zod strips the unknown key, which is the bare deny of old.
 * Delete this type once the SDK devDependency includes the field.
 */
type PlanDenyResolution = { decision: "deny"; message: string };

/**
 * Deny a held plan. The deny carries the hold message (`planHoldDenyMessage`),
 * so the agent waiting on the approval reads why the plan is held instead of a
 * bare rejection. If the deny fails the plan is still with the user (or
 * they already answered it), so pull the queued review back out — otherwise
 * it would land after an approval and send the agent back to planning in the
 * middle of implementing — and disarm. A review that was delivered straight
 * into the turn (no queued row) cannot be withdrawn; that is only logged.
 *
 * The timeline cursor for `planDenied` is captured BEFORE the resolve call,
 * not after: the agent can start its next tool call within the resolve's
 * own round-trip, and a cursor taken afterward could already be past that
 * tool call, making it invisible to the next-tool-call guard. Capturing the
 * cursor never blocks the deny itself — if it fails, the deny still goes
 * ahead, just without arming `planDenied` (logged, not fatal). `planDenied`
 * is written only after the resolve has settled — never inside the same
 * try as the deny itself, so a failing metadata write can never be mistaken
 * for a failed deny.
 */
async function denyPlan(
  ctx: ReviewContext,
  thread: GateThreadLike,
  approval: PlanApproval,
  queuedMessageId: string | null,
): Promise<boolean> {
  const { bb } = ctx;
  let sinceSeq: number | null = null;
  try {
    sinceSeq = await captureSinceSeq(bb, thread.id);
  } catch (error) {
    bb.log.warn(
      `auto-review: could not capture a timeline cursor before denying the plan in ${thread.id}; a plan-hold question will not be auto-answered: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  try {
    await bb.sdk.threads.interactions.resolve({
      threadId: thread.id,
      interactionId: approval.interactionId,
      resolution: {
        decision: "deny",
        message: planHoldDenyMessage(approval.planFilePath),
      } as PlanDenyResolution,
    });
  } catch (error) {
    bb.log.warn(
      `auto-review: could not hold the plan for review in ${thread.id}; leaving it for the user: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    if (queuedMessageId !== null) {
      await withdrawQueuedReview(ctx, thread.id, queuedMessageId);
    }
    await writeState(bb, thread.id, {}, [...PLAN_GATE_KEYS]);
    await recordFire(ctx, thread.projectId, thread.id, "stood-down", "send-failed");
    return false;
  }
  if (sinceSeq !== null) {
    try {
      await writeState(bb, thread.id, { planDenied: { at: Date.now(), sinceSeq } });
    } catch (error) {
      bb.log.warn(
        `auto-review: could not arm the plan-hold answer cursor in ${thread.id}; a hold question will not be auto-answered: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
  return true;
}

export async function onInteractionPending(
  ctx: ReviewContext,
  { thread, interaction }: PluginThreadEventPayloads["interaction.pending"],
): Promise<void> {
  if (!passesThreadGate(thread)) {
    return;
  }
  const approval = planApprovalOf(interaction);
  if (approval !== null) {
    await withThreadLock(thread.id, () => gatePlan(ctx, thread, approval));
    return;
  }
  const question = userQuestionOf(interaction);
  if (question !== null) {
    await withThreadLock(thread.id, () => answerPlanHoldQuestion(ctx, thread, question));
  }
}

export function registerPlanGateEvents(ctx: ReviewContext): void {
  ctx.bb.events.on("interaction.pending", (payload) => onInteractionPending(ctx, payload));
}
