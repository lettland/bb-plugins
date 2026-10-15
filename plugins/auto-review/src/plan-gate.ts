import { basename } from "node:path";
import type { PluginThreadEventPayloads } from "@get-bb/plugin-sdk";
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
import {
  EVENT_PAGE_MAX,
  isImmediateReactionToDeny,
  planApprovalOf,
  planGateAction,
  planReleaseReason,
  planSkillCheck,
  reviewRanSince,
  userQuestionOf,
  warnPlanUnreviewed,
  type PendingUserQuestion,
  type PlanApproval,
} from "./plan.js";
import { buildPlanReviewPrompt, buildPlanReviewRedoPrompt, PLAN_HOLD_ANSWER } from "./prompt.js";
import { REPORT_REVIEW_TOOL_NAME } from "./report-tool.js";
import {
  PLAN_GATE_KEYS,
  planDenyFresh,
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
 * the deny settles. But the deny's own text — core's, not auto-review's —
 * reaches the agent first and reads as the user rejecting the plan; the
 * steered review only reaches it after its next tool result (Claude Code
 * hands a steered message to the model only then). In between, the agent
 * may ask the user what to change — `denyPlan` leaves a short-lived
 * `planDenied` cursor for exactly that, which the `interaction.pending`
 * handler below uses to answer that one question itself.
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

  // A new cycle starts clean: keys left by an expired earlier one (a delivery
  // cursor, a queued id) must never leak into this review's evidence.
  await writeState(
    bb,
    thread.id,
    { planReviewArmedAt: Date.now() },
    PLAN_GATE_KEYS.filter((key) => key !== "planReviewArmedAt"),
  );
  const prompt = buildPlanReviewPrompt({
    reviewMode: config.reviewMode,
    planFilePath: approval.planFilePath,
    autoApprove: config.autoApprovePlans,
  });
  if (await armReview(ctx, thread, approval, prompt)) {
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
    } else if (result.delivery === "sent") {
      // Straight into the turn, so there is no dispatch event: the cursor
      // right after the send is where the review's delivery starts.
      await markReviewDelivered(ctx, thread.id);
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
  if (
    check === "loaded" &&
    config.autoApprovePlans &&
    approval.canApprove &&
    planReviewDeliveredSeq !== undefined &&
    !expired &&
    (await reviewRanSince(bb, thread.id, planReviewDeliveredSeq, NATIVE_GATE_TOOLS, false)) &&
    (await approvePlan(ctx, thread, approval))
  ) {
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
  await recordFire(ctx, thread.projectId, thread.id, "stood-down", planReleaseReason(check));
}

/** Resolve the reviewed plan `allow_once`; false (logged) leaves it with the user. */
async function approvePlan(
  ctx: ReviewContext,
  thread: GateThreadLike,
  approval: PlanApproval,
): Promise<boolean> {
  const { bb } = ctx;
  try {
    await bb.sdk.threads.interactions.resolve({
      threadId: thread.id,
      interactionId: approval.interactionId,
      resolution: { decision: "allow_once", grantedPermissions: null },
    });
  } catch (error) {
    bb.log.warn(
      `auto-review: could not auto-approve the reviewed plan in ${thread.id}; leaving it for the user: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return false;
  }
  await recordFire(ctx, thread.projectId, thread.id, "fired", "plan-approved");
  bb.log.info(
    `auto-review: auto-approved the reviewed plan ${approval.interactionId} in thread ${thread.id}`,
  );
  return true;
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
  const prompt = buildPlanReviewRedoPrompt({
    reviewMode: config.reviewMode,
    planFilePath: approval.planFilePath,
    autoApprove: config.autoApprovePlans,
  });
  if (await armReview(ctx, thread, approval, prompt)) {
    await recordFire(ctx, thread.projectId, thread.id, "fired", "plan-review-redo");
  }
}

/**
 * A plan re-presented while its review is recorded as queued. Hold it only
 * while the review really is still in the queue and has not been there past
 * the stale window: the recorded id is cleared only by `message.dispatched`
 * or `message.cancelled`, so trusting it alone would turn one missed event
 * into a bare deny of every plan the thread presents from then on.
 */
async function holdOrReleasePlan(
  ctx: ReviewContext,
  thread: GateThreadLike,
  state: ThreadState,
  approval: PlanApproval,
  config: EffectiveConfig,
): Promise<void> {
  const { bb } = ctx;
  const entryId = state.planReviewEntryId ?? null;
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
 * Deny a held plan. If the deny fails the plan is still with the user (or
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
      resolution: { decision: "deny" },
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

/**
 * Answer, in the user's name, a `user_question` the agent raises as its
 * very next tool call after a plan deny — the deny's own reason reaching it
 * before the queued review does (see `gatePlan`). Absent, there is nothing
 * to do. Present, it is one-shot: removed right away, before any of the
 * checks below, so whether they pass or fail, a later question must not
 * find it still armed.
 */
export async function answerPlanHoldQuestion(
  ctx: ReviewContext,
  thread: GateThreadLike,
  question: PendingUserQuestion,
): Promise<void> {
  const { bb } = ctx;
  const state = await readState(bb, thread.id);
  if (state.planDenied === undefined) {
    return;
  }
  const { sinceSeq } = state.planDenied;
  await writeState(bb, thread.id, {}, ["planDenied"]);
  if (!planDenyFresh(state, Date.now())) {
    return;
  }
  const project = await readProjectConfig(bb, thread.projectId);
  const config = effectiveConfig(ctx.globals, project);
  if (!config.enabled) {
    return;
  }
  let events: Awaited<ReturnType<typeof bb.sdk.threads.events.list>>;
  try {
    events = await bb.sdk.threads.events.list({
      threadId: thread.id,
      afterSeq: String(sinceSeq),
      types: ["item/started"],
      order: "asc",
      limit: String(EVENT_PAGE_MAX),
    });
  } catch (error) {
    bb.log.warn(
      `auto-review: could not read events to check the plan-hold reaction in ${thread.id}; leaving it for the user: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return;
  }
  // `isImmediateReactionToDeny` needs every event since the deny, and the log
  // is paged: a full page may hide later tool work, so it fails closed too.
  if (events.length >= EVENT_PAGE_MAX || !isImmediateReactionToDeny(events)) {
    // Real tool work happened since the deny, so this question is not
    // necessarily about the held plan — leave it with the user.
    return;
  }
  try {
    await bb.sdk.threads.interactions.resolve({
      threadId: thread.id,
      interactionId: question.interactionId,
      resolution: {
        kind: "user_answer",
        answers: Object.fromEntries(
          question.questionIds.map((id) => [id, { selected: [], freeText: PLAN_HOLD_ANSWER }]),
        ),
      },
    });
  } catch (error) {
    bb.log.warn(
      `auto-review: could not auto-answer the plan-hold question in ${thread.id}; leaving it for the user: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return;
  }
  await recordFire(ctx, thread.projectId, thread.id, "fired", "plan-hold-answered");
  bb.log.info(
    `auto-review: auto-answered the plan-hold question ${question.interactionId} in thread ${thread.id}`,
  );
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
