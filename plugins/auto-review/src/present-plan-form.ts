import { basename } from "node:path";
import type { BbPluginApi, PluginAgentToolContext, PluginAgentToolResult } from "@get-bb/plugin-sdk";
import { tryCaptureSinceSeq } from "./detect.js";
import { planFormResolutionSince } from "./detect-plan-form.js";
import {
  PLAN_APPROVAL_PLUGIN_ID,
  PLAN_APPROVAL_RENDERER,
  PLAN_APPROVAL_TIMEOUT_MS,
  PLAN_APPROVAL_TITLE,
  parsePlanApprovalValue,
  planApprovalDescription,
  type PlanApprovalPayload,
} from "./plan-approval-form.js";
import { planFileUnchanged } from "./plan-file.js";
import {
  PRESENT_PLAN_FORM_APPROVED_MESSAGE,
  PRESENT_PLAN_FORM_CHECK_FAILED_MESSAGE,
  PRESENT_PLAN_FORM_OPEN_MESSAGE,
  PRESENT_PLAN_FORM_PLAN_CHANGED_MESSAGE,
  PRESENT_PLAN_FORM_UNREADABLE_MESSAGE,
  presentPlanApprovalCancelledMessage,
  presentPlanChangesRequestedMessage,
  presentPlanFormUnavailableMessage,
} from "./prompt.js";
import type { ReviewContext } from "./context.js";
import { readState, withThreadLock, writeState, type ThreadState } from "./state.js";

/** What a release hands back instead of its text when the approval form is on: the form to open once the thread lock is released. */
export interface NeedsForm {
  form: PlanApprovalPayload;
  /** The resolved path and hash the form's plan text came from, which the answer re-checks; null when the plan was not readable here, so nothing binds an approval. */
  bound: { path: string; sha256: string } | null;
  /** The open-form marker this release wrote; only a clear that still finds it may remove it. */
  openedAt: number;
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

/**
 * How long a fresh open-form marker counts as open without asking the host.
 * A release writes the marker and drops the thread lock before `requestInput`
 * registers the pending interaction; inside that gap the interaction list is
 * empty, so only the marker's age tells a form being opened from a stale one.
 */
export const FORM_OPEN_FRESH_MS = 30_000;

/** Whether the thread's one plan approval form is still open (its marker is set and not stale). */
export function planFormOpen(state: ThreadState, now: number): boolean {
  return state.presentPlanFormOpenAt !== undefined && now - state.presentPlanFormOpenAt < PLAN_APPROVAL_TIMEOUT_MS + FORM_OPEN_GRACE_MS;
}

/** Whether the marker is younger than `FORM_OPEN_FRESH_MS`, so its form may still be registering. */
export function planFormMarkerFresh(state: ThreadState, now: number): boolean {
  if (state.presentPlanFormOpenAt === undefined) return false;
  // A negative age (the clock stepped back) is not fresh: the host check then decides.
  const age = now - state.presentPlanFormOpenAt;
  return age >= 0 && age < FORM_OPEN_FRESH_MS;
}

/**
 * The marker time a release writes: strictly above the one it replaces, so two
 * releases in one millisecond never share a value and a late `finally` that
 * compares before clearing stays exact.
 */
export function nextFormOpenedAt(state: Pick<ThreadState, "presentPlanFormOpenAt">, now: number): number {
  return Math.max(now, (state.presentPlanFormOpenAt ?? 0) + 1);
}

/**
 * Whether a plan approval form of this plugin is still pending in the thread:
 * "pending", "none", or "failed" when the interactions cannot be listed. It
 * tells a live marker from one a restart left behind (the `finally` that
 * clears it never ran). The caller refuses the release on "failed" rather
 * than opening a second form.
 */
export async function planFormPending(bb: BbPluginApi, threadId: string): Promise<"pending" | "none" | "failed"> {
  try {
    const pending = await bb.sdk.threads.interactions.list({ threadId });
    const found = pending.some(
      (interaction) =>
        (interaction.status === "pending" || interaction.status === "resolving") &&
        interaction.origin?.kind === "plugin" &&
        interaction.origin.pluginId === PLAN_APPROVAL_PLUGIN_ID &&
        interaction.origin.rendererId === PLAN_APPROVAL_RENDERER,
    );
    return found ? "pending" : "none";
  } catch (error) {
    bb.log.warn(
      `auto-review: could not list the pending interactions in ${threadId} to check the plan approval form's open marker, so the release is refused: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return "failed";
  }
}

/** The error result for a release that finds another form open; the plan stays armed for the same call to release later. */
export function planFormOpenResult(): PluginAgentToolResult {
  return { content: [{ type: "text", text: PRESENT_PLAN_FORM_OPEN_MESSAGE }], isError: true };
}

/** The error result for a release that cannot tell whether another form is open; the plan stays armed. */
export function planFormCheckFailedResult(): PluginAgentToolResult {
  return { content: [{ type: "text", text: PRESENT_PLAN_FORM_CHECK_FAILED_MESSAGE }], isError: true };
}

/**
 * The options the held form is opened with. `experimental_holdToolCall`,
 * `experimental_requireAppAnswer` and `experimental_detachOnAbort` are not in
 * the SDK types this plugin pins, nor in the published SDK, so the type adds
 * them (@get-bb/plugin-sdk 0.6.79 lacks all three; drop the additions once a
 * pinned SDK types them). Bb builds with the fork change keep the tool call
 * blocked until the form settles and bind the form to the active turn (bb core
 * `apps/server/src/services/plugins/plugin-api.ts` `requestInput`,
 * `apps/server/src/services/interactions/pending-interactions.fork.ts`), and
 * refuse an answer that did not come from the app and record how each answer
 * arrived (`routes/threads/interactions.ts` `answeredVia`, the
 * `plugin_submitted` resolution in `packages/domain/src/pending-interactions.ts`).
 * With `experimental_detachOnAbort`, a tool call that the provider aborts while
 * the form is pending (Codex ends its turn) does not cancel the form: the form
 * stays open, no longer bound to a turn, and the tool's eventual result reaches
 * the agent as a bb message ("Your earlier PresentPlan tool call has finished.
 * Its result: ..."); the answer's resolution carries `heldTurnId`. A form that
 * ends by Cancel or timeout after that wakes no one. Upstream bb ignores all
 * three flags: it detaches the call and records no origin.
 */
type HoldOptions = NonNullable<Parameters<BbPluginApi["ui"]["requestInput"]>[1]> & {
  experimental_holdToolCall?: boolean;
  experimental_requireAppAnswer?: boolean;
  experimental_detachOnAbort?: boolean;
};

/** What the form's resolution means for the tool result: credited as held, an approval that did not count because the plan changed, or not confirmed. */
type FormOutcome = "held" | "plan-changed" | "unavailable";

/**
 * Whether the form's resolution is one the gate will credit: found, held
 * (turn-scoped, or carrying core's `heldTurnId`) and, for an approval,
 * described as approved and answered through the app. A host without the hold
 * detaches the call, so its resolution is thread-scoped with no `heldTurnId`
 * and the agent must not be told to implement from it. An approval needs the
 * app origin because the gate credits only that (`approvedPlanOf`); core already
 * refuses a CLI or API answer to the flagged form, so only a host without the
 * flag leaves one uncredited. That origin rests on the self-declared
 * `x-bb-app-surface` header, so the check is a deterrent: it does not prove who
 * answered. A change request is not credited, so it needs no origin. An approval
 * the plugin recorded as `planChanged` is checked before the approved flag,
 * since it is recorded as not approved. A failed read counts as not held. With
 * one form per thread (`planFormOpen`), the latest resolution after the cursor
 * is this call's form. Each way of failing logs its own cause.
 */
async function formOutcome(
  bb: BbPluginApi,
  threadId: string,
  sinceSeq: number,
  approved: boolean,
  where: string,
): Promise<FormOutcome> {
  try {
    const resolution = await planFormResolutionSince(bb, threadId, sinceSeq);
    if (resolution === null) {
      bb.log.info(`auto-review: the plan approval form for ${where} left no resolution event after it settled, so nothing is approved`);
      return "unavailable";
    }
    if (!resolution.held) {
      bb.log.info(`auto-review: the plan approval form for ${where} was not held by the host (its resolution is not turn-scoped and carries no heldTurnId), so nothing is approved`);
      return "unavailable";
    }
    if (resolution.planChanged) {
      bb.log.info(`auto-review: the plan file for ${where} changed after the form opened, so the approval did not count`);
      return "plan-changed";
    }
    if (approved && !resolution.approved) {
      bb.log.info(`auto-review: the plan approval form for ${where} was answered approved but its resolution does not record approved: true, so nothing is approved`);
      return "unavailable";
    }
    if (approved && !resolution.app) {
      bb.log.info(
        `auto-review: the plan approval form for ${where} was approved by an answer that did not come from the bb app (no answeredVia "app" on the resolution; does your bb support experimental_requireAppAnswer?), so nothing is approved`,
      );
      return "unavailable";
    }
    return "held";
  } catch (error) {
    bb.log.warn(
      `auto-review: could not read the plan approval form's resolution in ${threadId}, so it counts as not held: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return "unavailable";
  }
}

/**
 * Clears the open-form marker this call wrote, and only that one: a late
 * `finally` finds a newer form's timestamp and leaves it. Under the thread
 * lock, so the compare and the clear cannot interleave with a release's write.
 * A failure is logged and never changes the tool result.
 */
async function clearFormOpen(bb: BbPluginApi, threadId: string, openedAt: number): Promise<void> {
  try {
    await withThreadLock(threadId, async () => {
      if ((await readState(bb, threadId)).presentPlanFormOpenAt === openedAt) {
        await writeState(bb, threadId, {}, ["presentPlanFormOpenAt"]);
      }
    });
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
 * holds it, and turns its outcome into the tool result. The call stays blocked
 * inside the turn that asked, or, when the provider aborts it at the end of the
 * turn, continues detached and its result reaches the agent as a bb message. The agent is told to implement only when the host held the form and
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
    await clearFormOpen(review.bb, ctx.threadId, needs.openedAt);
  }
}

async function runPlanApproval(
  review: ReviewContext,
  ctx: PluginAgentToolContext,
  { form, bound }: NeedsForm,
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
  const holdOptions: HoldOptions = {
    signal: ctx.signal,
    experimental_holdToolCall: true,
    experimental_requireAppAnswer: true,
    experimental_detachOnAbort: true,
  };
  let result: Awaited<ReturnType<BbPluginApi["ui"]["requestInput"]>>;
  try {
    result = await bb.ui.requestInput(
      {
        threadId: ctx.threadId,
        rendererId: PLAN_APPROVAL_RENDERER,
        title: PLAN_APPROVAL_TITLE,
        payload: form,
        timeoutMs: PLAN_APPROVAL_TIMEOUT_MS,
        describeSubmission: async (value) => {
          const decision = parsePlanApprovalValue(value);
          // The hash is the one this form was opened with; an approval counts only for a file that still has it.
          const changed = decision.approved && bound !== null && !(await planFileUnchanged(bb, ctx.threadId, bound.path, bound.sha256));
          return planApprovalDescription(decision, changed);
        },
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
  const outcome = await formOutcome(bb, ctx.threadId, sinceSeq, decision.approved, where);
  if (outcome === "plan-changed") {
    return PRESENT_PLAN_FORM_PLAN_CHANGED_MESSAGE;
  }
  if (outcome === "unavailable") {
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
