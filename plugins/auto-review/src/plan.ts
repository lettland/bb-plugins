import type { BbPluginApi, PluginThreadEventPayloads } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { devkitRunning } from "./dispatch.js";
import { EVENT_PAGE_MAX } from "./detect-events.js";
import type { ReviewMode } from "./prompt.js";
import { planHoldExpired, type ThreadState } from "./state.js";

type PendingInteraction = PluginThreadEventPayloads["interaction.pending"]["interaction"];
type ThreadEventRow = Awaited<ReturnType<BbPluginApi["sdk"]["threads"]["events"]["list"]>>[number];

/** The payload of a pending interaction, or null once it has settled. */
function pendingPayload(interaction: PendingInteraction): PendingInteraction["payload"] | null {
  return interaction.status === "pending" ? interaction.payload : null;
}

export interface PlanApproval {
  interactionId: string;
  plan: string;
  planFilePath: string | null;
  /** Whether the provider lets the plan be approved (`allow_once`), not only denied. */
  canApprove: boolean;
}

/**
 * The plan-approval request a provider raises when an agent presents a plan
 * (Claude Code's ExitPlanMode), or null for any other interaction. Only a
 * pending approval that can be denied is gateable: the gate works by denying
 * the first presentation.
 */
export function planApprovalOf(interaction: PendingInteraction): PlanApproval | null {
  const payload = pendingPayload(interaction);
  if (payload === null || payload.kind !== "approval" || payload.subject.kind !== "plan") {
    return null;
  }
  if (!payload.availableDecisions.includes("deny")) {
    return null;
  }
  return {
    interactionId: interaction.id,
    plan: payload.subject.plan,
    planFilePath: payload.subject.planFilePath,
    canApprove: payload.availableDecisions.includes("allow_once"),
  };
}

export interface PendingUserQuestion {
  interactionId: string;
  questionIds: string[];
}

/**
 * The native `AskUserQuestion` interaction (Claude Code; a `user_question`
 * payload) a provider raises, or null for any other interaction — including
 * the bb-bridge `mcp__bb-bridge__AskUserQuestion`, which raises a plugin
 * interaction that cannot take a `user_answer` resolution. Only a question
 * where every option allows free text can carry auto-review's answer.
 */
export function userQuestionOf(interaction: PendingInteraction): PendingUserQuestion | null {
  const payload = pendingPayload(interaction);
  if (payload === null || payload.kind !== "user_question") {
    return null;
  }
  if (!payload.questions.every((question) => question.allowFreeText)) {
    return null;
  }
  return {
    interactionId: interaction.id,
    questionIds: payload.questions.map((question) => question.id),
  };
}

/**
 * Whether every event since a plan deny is harmless: the agent's thinking,
 * its own preamble text, or the native `AskUserQuestion` item the held
 * question itself raised. Any other item/started is real work done in
 * between, so the question that follows it is not necessarily about the held
 * plan.
 *
 * An `agentMessage` item no longer disqualifies on its own: the deny text
 * reads as a rejection until the steered review arrives, so preamble text in
 * the same response as the question is exactly the reaction this function
 * exists to wave through (thr_ijhpz5srpe seq 2059-2064, 2026-10-26: text and
 * question, one response). What does disqualify is a delivered steer — core
 * records it as a `provider/unhandled` row with `rawType: "sdk/user"`, and
 * once the steered user message is in the log the review has reached the
 * agent, so a question after it is not the deny's immediate reaction. An
 * `sdk/user` row whose content is an array (replayed tool results) is not a
 * steer; one whose content path is missing or of no known shape fails closed
 * and counts as a steer. `provider/unhandled` rows of any other rawType are
 * not user messages at all.
 *
 * `AskUserQuestion` only counts when `item.server` is unset: core classifies
 * the bb-bridge `mcp__bb-bridge__AskUserQuestion` (and any other MCP tool) as
 * tool `AskUserQuestion` with a `server`, and that one raises a plugin
 * interaction auto-review's answer cannot resolve — so a server-set
 * `AskUserQuestion` is real tool work, not the question this function exists
 * to wave through.
 */
export function isImmediateReactionToDeny(events: readonly ThreadEventRow[]): boolean {
  return events.every((event) => {
    if (event.type === "provider/unhandled") {
      return !isDeliveredSteer(event.data);
    }
    if (event.type !== "item/started") {
      return true;
    }
    const { item } = event.data;
    return (
      item.type === "reasoning" ||
      item.type === "agentMessage" ||
      (item.type === "toolCall" && item.tool === "AskUserQuestion" && item.server === undefined)
    );
  });
}

/** The `rawType` of a `provider/unhandled` row, read to tell a steered user message from every other unhandled event. */
const UNHANDLED_RAW_TYPE = z.object({ rawType: z.string() });

/** The path under `data` where a steered user row carries its content (thr_ijhpz5srpe seq 2069, 2026-10-26). */
const STEER_CONTENT = z.object({
  rawEvent: z.object({
    params: z.object({
      message: z.object({
        message: z.object({ content: z.union([z.string(), z.array(z.unknown())]) }),
      }),
    }),
  }),
});

/**
 * Whether a `provider/unhandled` row is the steered review reaching the agent:
 * an `sdk/user` row whose content is a string. An `sdk/user` row whose content
 * path cannot be read counts as a steer too (fail closed); an array is
 * replayed tool results, and any other rawType is not a user row at all.
 */
function isDeliveredSteer(data: unknown): boolean {
  const kind = UNHANDLED_RAW_TYPE.safeParse(data);
  if (!kind.success || kind.data.rawType !== "sdk/user") {
    return false;
  }
  const row = STEER_CONTENT.safeParse(data);
  if (!row.success) {
    return true;
  }
  return typeof row.data.rawEvent.params.message.message.content === "string";
}

/**
 * Whether the plan review reached the agent: at least one completed tool call
 * that is not one of the plan gate's own tools, and no turn that ended in
 * between. A steered message only reaches the model after a tool result that
 * returns after its delivery, so a completed non-gate tool call past the
 * delivery cursor means the agent has had the review in front of it. bb
 * emits `turn/completed` only when a turn really ends — steering a queued
 * message into a running turn emits none — so one past the cursor means the
 * review's turn is over and a plan presented now is not its re-presentation.
 * The inverse idea of `isImmediateReactionToDeny`.
 *
 * `turnEnded` is the caller's answer to "did any `turn/completed` follow the
 * cursor?", read from a query of its own (see `reviewRanSince`): it cannot be
 * derived from `events`, a page of completed items that may stop short of it.
 *
 * A call with `parentToolCallId` is a subagent's; `countSubagentCalls` says
 * whether that is evidence. The native gate needs the agent's own call (the
 * steered review reaches the main model after its own tool result), while
 * `PresentPlan` accepts a review run in a subagent.
 */
export function reviewReachedAgent(
  events: readonly ThreadEventRow[],
  gateTools: readonly string[],
  countSubagentCalls: boolean,
  turnEnded: boolean,
): boolean {
  if (turnEnded) {
    return false;
  }
  return events.some(
    (event) =>
      event.type === "item/completed" &&
      event.data.item.type === "toolCall" &&
      !gateTools.includes(event.data.item.tool) &&
      (countSubagentCalls || event.data.item.parentToolCallId === undefined),
  );
}

export { EVENT_PAGE_MAX };

/**
 * `reviewReachedAgent` over the thread's events since a cursor. The event log
 * is paged, so one mixed query could return a page of completed tool calls that
 * ends before a later `turn/completed`, and the turn boundary would go unseen.
 * It is therefore its own query, asking (oldest first) for the single first
 * turn end: any row means a turn ended, whatever the page size. The
 * completed-item query asks for one full page, oldest first, so it can only
 * come up short, which fails closed.
 *
 * The two reads run in sequence, items first. Every turn end that precedes a
 * returned item already exists when that item is read, so the later turn read
 * is guaranteed to see it; run the other way round (or concurrently), a turn
 * could end between the reads and a tool call from after it would count as
 * proof. A failed read of either counts as no proof: the plan then stays with
 * the user.
 *
 * `acrossTurns` accepts a review that a later turn completes: child-thread
 * reviewers end the agent's turn and bb wakes it afterwards, so a turn end is
 * then no evidence against the review. When it is true the `turn/completed`
 * read is skipped and no turn counts as ended; the same-turn rule is for the
 * callers that must not let a stale arm approve a later plan.
 */
export async function reviewRanSince(
  bb: BbPluginApi,
  threadId: string,
  sinceSeq: number,
  gateTools: readonly string[],
  countSubagentCalls: boolean,
  acrossTurns: boolean,
): Promise<boolean> {
  try {
    const afterSeq = String(sinceSeq);
    const events = await bb.sdk.threads.events.list({
      threadId,
      afterSeq,
      types: ["item/completed"],
      order: "asc",
      limit: String(EVENT_PAGE_MAX),
    });
    let turnEnded = false;
    if (!acrossTurns) {
      const turnEnds = await bb.sdk.threads.events.list({
        threadId,
        afterSeq,
        types: ["turn/completed"],
        order: "asc",
        limit: "1",
      });
      turnEnded = turnEnds.length > 0;
    }
    return reviewReachedAgent(events, gateTools, countSubagentCalls, turnEnded);
  } catch (error) {
    bb.log.warn(
      `auto-review: could not read events to check the plan review ran in ${threadId}; leaving the plan for the user: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return false;
  }
}

/** Pages of completed items `reviewSkillLoaded` reads before it gives up; a subagent's rows fill pages too and cannot be filtered out of the query. */
export const PLAN_EVIDENCE_PAGE_CAP = 20;

export type SkillLoad = "loaded" | "missing" | "unknown";

/**
 * "loaded" for the first completed `review-code` load the agent made itself in
 * a page of completed items, "unknown" for an agent load that records no
 * arguments, or null when there is none.
 */
function skillLoadIn(events: readonly ThreadEventRow[]): "loaded" | "unknown" | null {
  for (const event of events) {
    if (event.type !== "item/completed") {
      continue;
    }
    const { item } = event.data;
    if (
      item.type !== "toolCall" ||
      item.tool !== "devkit_load_skill" ||
      item.parentToolCallId !== undefined ||
      item.status !== "completed"
    ) {
      continue;
    }
    if (item.arguments === undefined) {
      return "unknown";
    }
    if (item.arguments.slug === "review-code") {
      return "loaded";
    }
  }
  return null;
}

/**
 * Whether the agent's completed `review-code` load is in the log after the
 * cursor: "missing" once every row was read without one, "unknown" for a load
 * with no arguments or a log longer than the page cap reads. Completed items
 * are paged oldest first, stopping at the first match.
 */
async function firstSkillLoad(
  bb: BbPluginApi,
  threadId: string,
  sinceSeq: number,
): Promise<SkillLoad> {
  let afterSeq = sinceSeq;
  for (let page = 0; page < PLAN_EVIDENCE_PAGE_CAP; page += 1) {
    const events = await bb.sdk.threads.events.list({
      threadId,
      afterSeq: String(afterSeq),
      types: ["item/completed"],
      order: "asc",
      limit: String(EVENT_PAGE_MAX),
    });
    const found = skillLoadIn(events);
    const last = events.at(-1);
    if (found !== null) {
      return found;
    }
    if (last === undefined || events.length < EVENT_PAGE_MAX) {
      return "missing";
    }
    afterSeq = last.seq;
  }
  return "unknown";
}

/**
 * Whether the agent itself loaded `review-code` since the cursor: an
 * anti-shortcut check, not proof the review ran. A load that failed, one by a
 * subagent (`parentToolCallId` set), another slug or a reference does not
 * count; `server` is not checked, so a relabel never turns every plan into a
 * redo. Unlike `reviewRanSince` it ignores turn ends: the review may be
 * dispatched as a new turn after the agent ended its own, or the agent may be
 * woken in a later turn by the child threads it started, and any of those
 * loads is the one this check wants. A read error, no cursor, an agent load
 * that records no arguments, or the page cap reached without a match is
 * "unknown", never "missing": only reading every row and finding none says the
 * skill was skipped.
 */
export async function reviewSkillLoaded(
  bb: BbPluginApi,
  threadId: string,
  sinceSeq: number | undefined,
): Promise<SkillLoad> {
  if (sinceSeq === undefined) {
    return "unknown";
  }
  return firstSkillLoad(bb, threadId, sinceSeq).catch((error: unknown): SkillLoad => {
    bb.log.warn(
      `auto-review: could not read events to check review-code was loaded in ${threadId}; the review cannot be verified: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return "unknown";
  });
}

/**
 * `reviewSkillLoaded` where the plan review runs devkit's `review-code`: in
 * `devkit` mode, and in `auto` mode while the devkit plugin is running. Where
 * it is not required (`self`, `auto` with devkit absent) the result is
 * "loaded", so those plans behave as before; a failed plugin lookup is
 * "unknown".
 */
export async function planSkillCheck(
  bb: BbPluginApi,
  threadId: string,
  reviewMode: ReviewMode,
  armedSeq: number | undefined,
): Promise<SkillLoad> {
  if (reviewMode === "self") {
    return "loaded";
  }
  if (reviewMode === "auto") {
    const devkit = await devkitRunning(bb);
    if (devkit !== "running") {
      return devkit === "absent" ? "loaded" : "unknown";
    }
  }
  return reviewSkillLoaded(bb, threadId, armedSeq);
}

/** The fire reason of a plan released after its `review-code` check: "plan-reviewed" unless the check came back missing or unknown. */
export function planReleaseReason(
  check: SkillLoad,
): "plan-reviewed" | "plan-review-incomplete" | "plan-review-unverified" {
  if (check === "missing") {
    return "plan-review-incomplete";
  }
  return check === "unknown" ? "plan-review-unverified" : "plan-reviewed";
}

/** The durable record of a plan released without an auto-approve for want of a verified review; `fire` records only the last one. */
export function warnPlanUnreviewed(
  bb: BbPluginApi,
  threadId: string,
  planName: string,
  check: "missing" | "unknown",
): void {
  bb.log.warn(
    check === "missing"
      ? `auto-review: plan ${planName} in thread ${threadId} was released without a complete calibrated review: review-code was not loaded after the redo; check the plan yourself before approving`
      : `auto-review: could not verify that review-code was loaded for plan ${planName} in thread ${threadId}; released without auto-approval`,
  );
}

export type PlanGateAction = "review" | "hold" | "release";

/**
 * Single-fire per presentation, loop-safe by construction: the review edits the
 * plan, so a content key would re-block the revised plan forever. Instead the
 * first presentation is held for review and arms the gate, and the next one —
 * the reviewed plan — is released to the user and disarms it, ready for the
 * thread's next plan.
 *
 * "hold" covers a re-presentation that beats the review turn: whatever the
 * deny's message tells it, the agent may re-present before core dispatches
 * the queued review. Releasing that plan would hand the user an unreviewed plan and land
 * the review in the middle of implementing it, so it is denied again and the
 * still-queued review follows.
 *
 * A presentation with no review queued (`planReviewEntryId` undefined) is
 * normally the reviewed plan coming back — released once. But an arm older
 * than its window (`planHoldExpired`: the stale window, or the continuation
 * cap once the review was delivered) means whatever review was queued
 * is long gone and never re-presented anything (a crashed review turn, a
 * dispatch this plugin never saw): that presentation was never reviewed, so
 * treating it as "release" would hand the user a plan auto-review never
 * touched. Treated as "review" instead, same as a thread with no arm at all.
 */
export function planGateAction(state: ThreadState, now: number): PlanGateAction {
  if (state.planReviewArmedAt === undefined) {
    return "review";
  }
  if (state.planReviewEntryId === undefined) {
    return planHoldExpired(state, now) ? "review" : "release";
  }
  return "hold";
}
