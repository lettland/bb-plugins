import type { BbPluginApi, PluginThreadEventPayloads } from "@get-bb/plugin-sdk";
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
 * Whether every `item/started` event since a plan deny is harmless: the
 * agent's own thinking, or the native `AskUserQuestion` item the held
 * question itself raised. Any other item/started is real work done in
 * between, so the question that follows it is not necessarily about the held
 * plan — the deny's reason no longer reaches the agent as "the next thing".
 *
 * An `agentMessage` item disqualifies: a text-only response ends the model's
 * turn, and Claude Code then injects the steered review into that same turn —
 * core records that steer as `provider/unhandled`, not a `userMessage` item,
 * so the agent's own text is the only observable sign that already happened,
 * and a question after it is not "the very next thing" any more.
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
    if (event.type !== "item/started") {
      return true;
    }
    const { item } = event.data;
    return (
      item.type === "reasoning" ||
      (item.type === "toolCall" && item.tool === "AskUserQuestion" && item.server === undefined)
    );
  });
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
 */
export async function reviewRanSince(
  bb: BbPluginApi,
  threadId: string,
  sinceSeq: number,
  gateTools: readonly string[],
  countSubagentCalls: boolean,
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
    const turnEnds = await bb.sdk.threads.events.list({
      threadId,
      afterSeq,
      types: ["turn/completed"],
      order: "asc",
      limit: "1",
    });
    return reviewReachedAgent(events, gateTools, countSubagentCalls, turnEnds.length > 0);
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
      `auto-review: could not read events to check review-code was loaded in ${threadId}; the plan review cannot be verified: ${
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
 * "hold" covers a re-presentation that beats the review turn: the deny carries
 * no reason, so the agent may re-present before core dispatches the queued
 * review. Releasing that plan would hand the user an unreviewed plan and land
 * the review in the middle of implementing it, so it is denied again and the
 * still-queued review follows.
 *
 * A presentation with no review queued (`planReviewEntryId` undefined) is
 * normally the reviewed plan coming back — released once. But an arm older
 * than the stale window (`planHoldExpired`) means whatever review was queued
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
