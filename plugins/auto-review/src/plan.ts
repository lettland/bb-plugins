import type { BbPluginApi, PluginThreadEventPayloads } from "@get-bb/plugin-sdk";
import type { ThreadState } from "./state.js";

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

/**
 * devkit's commit workflow leads the plan it presents with this marker on a line
 * of its own: a commit plan is bookkeeping, not code, so it skips plan review.
 * The k0d3 spelling is still honoured for plans written by the older plugin.
 */
const COMMIT_PLAN_SENTINEL = /^[ \t]*<!--[ \t]*(?:devkit|k0d3):commit-plan[ \t]*-->[ \t]*\r?$/mu;

export function isCommitPlan(plan: string): boolean {
  return COMMIT_PLAN_SENTINEL.test(plan);
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
 * agent's own thinking or talking, or the `AskUserQuestion` item the held
 * question itself raised. Any other item/started is real tool work done in
 * between, so the question that follows it is not necessarily about the held
 * plan — the deny's reason no longer reaches the agent as "the next thing".
 */
export function isImmediateReactionToDeny(events: readonly ThreadEventRow[]): boolean {
  return events.every((event) => {
    if (event.type !== "item/started") {
      return true;
    }
    const { item } = event.data;
    return (
      item.type === "reasoning" ||
      item.type === "agentMessage" ||
      (item.type === "toolCall" && item.tool === "AskUserQuestion")
    );
  });
}

export type PlanGateAction = "review" | "hold" | "release" | "commit-plan";

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
 */
export function planGateAction(state: ThreadState, plan: string): PlanGateAction {
  if (isCommitPlan(plan)) {
    return "commit-plan";
  }
  if (state.planReviewArmedAt === undefined) {
    return "review";
  }
  return state.planReviewEntryId === undefined ? "release" : "hold";
}
