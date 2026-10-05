import type { PluginThreadEventPayloads } from "@get-bb/plugin-sdk";
import { effectiveConfig, readProjectConfig } from "./config.js";
import {
  queuedRowExists,
  recordFire,
  type GateThreadLike,
  type ReviewContext,
} from "./context.js";
import { captureSinceSeq } from "./detect.js";
import { passesThreadGate, planGateServes } from "./gate.js";
import {
  isImmediateReactionToDeny,
  planApprovalOf,
  planGateAction,
  userQuestionOf,
  type PendingUserQuestion,
  type PlanApproval,
} from "./plan.js";
import { buildPlanReviewPrompt, PLAN_HOLD_ANSWER } from "./prompt.js";
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
  const config = effectiveConfig(ctx.globals, project, state.skip === true);
  if (!planGateServes(thread, config)) {
    return;
  }

  const action = planGateAction(state, approval.plan, Date.now());
  if (action === "commit-plan") {
    await recordFire(ctx, thread.projectId, thread.id, "stood-down", "commit-plan");
    return;
  }
  if (action === "release") {
    await writeState(bb, thread.id, {}, [...PLAN_GATE_KEYS]);
    await recordFire(ctx, thread.projectId, thread.id, "stood-down", "plan-reviewed");
    return;
  }
  if (action === "hold") {
    await holdOrReleasePlan(ctx, thread, state, approval);
    return;
  }

  await writeState(bb, thread.id, { planReviewArmedAt: Date.now() });
  let queuedMessageId: string | null = null;
  try {
    const result = await bb.sdk.threads.send({
      threadId: thread.id,
      mode: "auto",
      input: [
        {
          type: "text",
          text: buildPlanReviewPrompt({
            reviewMode: config.reviewMode,
            planFilePath: approval.planFilePath,
          }),
          mentions: [],
        },
      ],
    });
    if (result.delivery === "queued") {
      queuedMessageId = result.queuedMessage.id;
      await writeState(bb, thread.id, { planReviewEntryId: queuedMessageId });
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
    return;
  }
  if (await denyPlan(ctx, thread, approval, queuedMessageId)) {
    await recordFire(ctx, thread.projectId, thread.id, "fired", "plan-review");
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
  // Not queued any more means the review was dispatched and this is the
  // reviewed plan, whose dispatch event never reached us.
  await writeState(bb, thread.id, {}, [...PLAN_GATE_KEYS]);
  await recordFire(ctx, 
    thread.projectId,
    thread.id,
    "stood-down",
    queued ? "plan-hold-expired" : "plan-reviewed",
  );
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
  const config = effectiveConfig(ctx.globals, project, state.skip === true);
  if (!config.enabled || config.skipped) {
    return;
  }
  let events: Awaited<ReturnType<typeof bb.sdk.threads.events.list>>;
  try {
    events = await bb.sdk.threads.events.list({
      threadId: thread.id,
      afterSeq: String(sinceSeq),
      types: ["item/started"],
    });
  } catch (error) {
    bb.log.warn(
      `auto-review: could not read events to check the plan-hold reaction in ${thread.id}; leaving it for the user: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return;
  }
  if (!isImmediateReactionToDeny(events)) {
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
