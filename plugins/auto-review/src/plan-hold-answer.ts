import { effectiveConfig, readProjectConfig } from "./config.js";
import { recordFire, type GateThreadLike, type ReviewContext } from "./context.js";
import { EVENT_PAGE_MAX, isImmediateReactionToDeny, type PendingUserQuestion } from "./plan.js";
import { PLAN_HOLD_ANSWER } from "./prompt.js";
import { planDenyFresh, readState, writeState } from "./state.js";

/**
 * Answer, in the user's name, a `user_question` the agent raises as its
 * very next tool call after a plan deny — the deny's text (auto-review's own
 * now, a bare rejection on an older host) reaching it before the queued
 * review does (see `gatePlan`). Absent, there is nothing
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
      types: ["item/started", "provider/unhandled"],
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
