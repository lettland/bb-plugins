import type { BbPluginApi, PluginThreadEventPayloads } from "@get-bb/plugin-sdk";
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
