import { basename } from "node:path";
import type { BbPluginApi, PluginAgentToolContext, PluginAgentToolResult } from "@get-bb/plugin-sdk";
import { tryCaptureSinceSeq } from "./detect.js";
import { planFormResolutionSince } from "./detect-plan-form.js";
import {
  PLAN_APPROVAL_RENDERER,
  PLAN_APPROVAL_TIMEOUT_MS,
  PLAN_APPROVAL_TITLE,
  parsePlanApprovalValue,
  planApprovalDescription,
  type PlanApprovalPayload,
} from "./plan-approval-form.js";
import {
  PRESENT_PLAN_FORM_APPROVED_MESSAGE,
  PRESENT_PLAN_FORM_OPEN_MESSAGE,
  PRESENT_PLAN_FORM_UNREADABLE_MESSAGE,
  presentPlanApprovalCancelledMessage,
  presentPlanChangesRequestedMessage,
  presentPlanFormUnavailableMessage,
} from "./prompt.js";
import type { ReviewContext } from "./context.js";
import { writeState, type ThreadState } from "./state.js";

/** What a release hands back instead of its text when the approval form is on: the form to open once the thread lock is released. */
export interface NeedsForm {
  form: PlanApprovalPayload;
}

export function needsForm(result: PluginAgentToolResult | NeedsForm): result is NeedsForm {
  return typeof result === "object" && "form" in result;
}

/**
 * How long past the form's own timeout an open-form marker still blocks a
 * second form. A crash that skips `askPlanApproval`'s `finally` leaves the
 * marker behind; after this window it no longer blocks.
 */
const FORM_OPEN_GRACE_MS = 60_000;

/** Whether the thread's one plan approval form is still open (its marker is set and not stale). */
export function planFormOpen(state: ThreadState, now: number): boolean {
  return state.presentPlanFormOpenAt !== undefined && now - state.presentPlanFormOpenAt < PLAN_APPROVAL_TIMEOUT_MS + FORM_OPEN_GRACE_MS;
}

/** The error result for a release that finds another form open; the plan stays armed for the same call to release later. */
export function planFormOpenResult(): PluginAgentToolResult {
  return { content: [{ type: "text", text: PRESENT_PLAN_FORM_OPEN_MESSAGE }], isError: true };
}

/**
 * The options the held form is opened with. `experimental_holdToolCall` and
 * `experimental_requireAppAnswer` are not in the SDK types this plugin pins,
 * nor in the published SDK, so the type adds them. Bb builds with the fork
 * change keep the tool call blocked until the form settles and bind the form
 * to the active turn (bb core `apps/server/src/services/plugins/plugin-api.ts`
 * `requestInput`, `apps/server/src/services/interactions/pending-interactions.fork.ts`),
 * and refuse an answer that did not come from the app and record how each
 * answer arrived (`routes/threads/interactions.ts` `answeredVia`, the
 * `plugin_submitted` resolution in `packages/domain/src/pending-interactions.ts`);
 * upstream bb ignores both flags: it detaches the call and records no origin.
 */
type HoldOptions = NonNullable<Parameters<BbPluginApi["ui"]["requestInput"]>[1]> & {
  experimental_holdToolCall?: boolean;
  experimental_requireAppAnswer?: boolean;
};

/**
 * Whether the form's resolution is one the gate will credit: found,
 * turn-scoped, and, for an approval, described as approved and answered
 * through the app. A host without the hold detaches the call, so its
 * resolution is thread-scoped and the agent must not be told to implement from
 * it. An approval needs the app origin because the gate credits only that
 * (`approvedPlanOf`); core already refuses a CLI or API answer to the flagged
 * form, so only a host without the flag leaves one uncredited. A change request
 * is not credited, so it needs no origin. A failed read counts as not held.
 * With one form per thread (`planFormOpen`), the latest resolution after the
 * cursor is this call's form. Each way of failing logs its own cause.
 */
async function formHeld(
  bb: BbPluginApi,
  threadId: string,
  sinceSeq: number,
  approved: boolean,
  where: string,
): Promise<boolean> {
  try {
    const resolution = await planFormResolutionSince(bb, threadId, sinceSeq);
    if (resolution === null) {
      bb.log.info(`auto-review: the plan approval form for ${where} left no resolution event after it settled, so nothing is approved`);
      return false;
    }
    if (!resolution.held) {
      bb.log.info(`auto-review: the plan approval form for ${where} was not held by the host (its resolution is not turn-scoped), so nothing is approved`);
      return false;
    }
    if (approved && !resolution.approved) {
      bb.log.info(`auto-review: the plan approval form for ${where} was answered approved but its resolution does not record approved: true, so nothing is approved`);
      return false;
    }
    if (approved && !resolution.app) {
      bb.log.info(
        `auto-review: the plan approval form for ${where} was approved by an answer that did not come from the bb app (no answeredVia "app" on the resolution; does your bb support experimental_requireAppAnswer?), so nothing is approved`,
      );
      return false;
    }
    return true;
  } catch (error) {
    bb.log.warn(
      `auto-review: could not read the plan approval form's resolution in ${threadId}, so it counts as not held: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return false;
  }
}

/** Clears the open-form marker; a failure is logged and never changes the tool result. */
async function clearFormOpen(bb: BbPluginApi, threadId: string): Promise<void> {
  try {
    await writeState(bb, threadId, {}, ["presentPlanFormOpenAt"]);
  } catch (error) {
    bb.log.warn(
      `auto-review: could not clear the plan approval form's open marker in ${threadId}; it stops blocking after its window: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

/**
 * Opens the plan approval form, outside the thread lock so a pending form never
 * holds it, and turns its outcome into the tool result inside the same blocked
 * turn. The agent is told to implement only when the host held the form and
 * the gate will credit the approval; otherwise it is told the form could not
 * confirm an answer (`presentPlanFormUnavailableMessage`), never to wait for a
 * chat approval, which the form instructions do not accept. Whatever the
 * outcome, the open-form marker the release wrote is cleared on the way out.
 */
export async function askPlanApproval(
  review: ReviewContext,
  ctx: PluginAgentToolContext,
  needs: NeedsForm,
): Promise<PluginAgentToolResult> {
  try {
    return await runPlanApproval(review, ctx, needs);
  } finally {
    await clearFormOpen(review.bb, ctx.threadId);
  }
}

async function runPlanApproval(
  review: ReviewContext,
  ctx: PluginAgentToolContext,
  { form }: NeedsForm,
): Promise<PluginAgentToolResult> {
  const { bb } = review;
  const unavailable = presentPlanFormUnavailableMessage(form.reviewed);
  const where = `${basename(form.planFilePath)} in thread ${ctx.threadId}`;
  const sinceSeq = await tryCaptureSinceSeq(
    bb,
    ctx.threadId,
    `the plan approval form in ${ctx.threadId}; no form is opened`,
  );
  if (sinceSeq === undefined) {
    return unavailable;
  }
  const holdOptions: HoldOptions = { signal: ctx.signal, experimental_holdToolCall: true, experimental_requireAppAnswer: true };
  let result: Awaited<ReturnType<BbPluginApi["ui"]["requestInput"]>>;
  try {
    result = await bb.ui.requestInput(
      {
        threadId: ctx.threadId,
        rendererId: PLAN_APPROVAL_RENDERER,
        title: PLAN_APPROVAL_TITLE,
        payload: form,
        timeoutMs: PLAN_APPROVAL_TIMEOUT_MS,
        describeSubmission: (value) => planApprovalDescription(parsePlanApprovalValue(value)),
      },
      holdOptions,
    );
  } catch (error) {
    bb.log.warn(
      `auto-review: the plan approval form for ${where} failed, so the plan is released without it: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return unavailable;
  }
  if (result.outcome === "cancelled") {
    bb.log.info(`auto-review: the plan approval form for ${where} was cancelled (${result.reason})`);
    return presentPlanApprovalCancelledMessage(result.reason);
  }
  const decision = parsePlanApprovalValue(result.value);
  if (!(await formHeld(bb, ctx.threadId, sinceSeq, decision.approved, where))) {
    return unavailable;
  }
  if ("unreadable" in decision) {
    bb.log.info(`auto-review: the plan approval form for ${where} returned an answer that could not be read, so nothing is approved`);
    return PRESENT_PLAN_FORM_UNREADABLE_MESSAGE;
  }
  bb.log.info(
    `auto-review: the plan approval form for ${where} ${decision.approved ? "approved the plan" : "asked for changes"}`,
  );
  return decision.approved ? PRESENT_PLAN_FORM_APPROVED_MESSAGE : presentPlanChangesRequestedMessage(decision.feedback);
}
