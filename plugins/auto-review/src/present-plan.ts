import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import type {
  PluginAgentConfiguration,
  PluginAgentConfigurationContext,
  PluginAgentToolContext,
  PluginAgentToolResult,
} from "@get-bb/plugin-sdk";
import { z } from "zod";
import { clearPlanBaseline, planScope, settlePlanBaseline, stagePlanPending } from "./baseline-store.js";
import { effectiveConfig, readProjectConfig } from "./config.js";
import { recordFire, type EffectiveConfig, type ReviewContext } from "./context.js";
import { tryCaptureSinceSeq } from "./detect.js";
import { isNativePlanGateProvider } from "./gate.js";
import { planReleaseReason, planSkillCheck, reviewRanSince, warnPlanUnreviewed } from "./plan.js";
import {
  buildPresentPlanReviewPrompt,
  PLAN_FIRST_INSTRUCTIONS,
  PLAN_FIRST_INSTRUCTIONS_PRESENT_PLAN,
  PRESENT_PLAN_APPROVED_MESSAGE,
  PRESENT_PLAN_INCOMPLETE_MESSAGE,
  PRESENT_PLAN_INVALID_PATH_MESSAGE,
  PRESENT_PLAN_OFF_MESSAGE,
  presentPlanRedoMessage,
  PRESENT_PLAN_REVIEWED_MESSAGE,
  SCOPE_PATH_ALLOW,
} from "./prompt.js";
import { REPORT_REVIEW_TOOL_NAME, registerReportTool } from "./report-tool.js";
import {
  presentPlanArmed,
  PRESENT_PLAN_KEYS,
  readState,
  withThreadLock,
  writeState,
  type ThreadState,
} from "./state.js";

/** The provider-agnostic plan-review tool every served thread gets (see `configure` below). */
const PRESENT_PLAN_TOOL_NAME = "PresentPlan";

/**
 * `PresentPlan`'s own tool plus the plan gate's: completing these is not work
 * on the review. `ReportReview` is included because a call to it, even a
 * rejected one, is bookkeeping rather than review work (core records a bridged
 * tool under its bare name, with `server` set).
 */
const PRESENT_PLAN_GATE_TOOLS = [
  PRESENT_PLAN_TOOL_NAME,
  REPORT_REVIEW_TOOL_NAME,
  "ExitPlanMode",
  "EnterPlanMode",
  "AskUserQuestion",
];

/** The plan file's text, or null when it cannot be read (the plan then has no baseline). */
async function readPlanFile(planFilePath: string): Promise<string | null> {
  try {
    return await readFile(planFilePath, "utf8");
  } catch {
    return null;
  }
}

/** The cursor auto-approve counts the review's tool work from; undefined means the plan is never auto-approved. */
function captureArmedSeq(review: ReviewContext, threadId: string): Promise<number | undefined> {
  return tryCaptureSinceSeq(
    review.bb,
    threadId,
    `the plan review in ${threadId}; the plan will not be auto-approved`,
  );
}

/**
 * The second call for an armed plan. A plan whose review never loaded
 * `review-code` (`planSkillCheck`) is sent back once instead, staying armed
 * with a fresh clock and cursor; it is decided from `state` before the keys
 * are cleared, which would erase `presentPlanRedone`. Otherwise it is released:
 * approved only when the skill was loaded and a tool call completed in between,
 * which cannot show a deliberate skip. A subagent's call counts: the review may
 * run in one.
 */
async function releasePlan(
  review: ReviewContext,
  ctx: PluginAgentToolContext,
  state: ThreadState,
  config: EffectiveConfig,
  planFilePath: string,
): Promise<PluginAgentToolResult> {
  const { bb } = review;
  const check = await planSkillCheck(bb, ctx.threadId, config.reviewMode, state.presentPlanArmedSeq);
  if (check === "missing" && state.presentPlanRedone !== true) {
    const redoSeq = await captureArmedSeq(review, ctx.threadId);
    await writeState(
      bb,
      ctx.threadId,
      {
        presentPlanArmedAt: Date.now(),
        presentPlanRedone: true,
        ...(redoSeq === undefined ? {} : { presentPlanArmedSeq: redoSeq }),
      },
      redoSeq === undefined ? ["presentPlanArmedSeq"] : undefined,
    );
    await recordFire(review, ctx.projectId, ctx.threadId, "fired", "plan-review-redo");
    // The redo reviews the whole plan: its baseline goes, and the plan as it stands is staged afresh.
    await clearPlanBaseline(bb, ctx.threadId, planFilePath);
    await stagePlanPending(bb, ctx.threadId, planFilePath, await readPlanFile(planFilePath), Date.now());
    return presentPlanRedoMessage(config.reviewMode);
  }
  await writeState(bb, ctx.threadId, {}, [...PRESENT_PLAN_KEYS]);
  // The baseline accepts a review that spans turns: child-thread reviewers end
  // the turn and bb wakes the agent later. Auto-approve still needs the
  // same-turn proof.
  const reviewWorked =
    check === "loaded" &&
    state.presentPlanArmedSeq !== undefined &&
    (await reviewRanSince(bb, ctx.threadId, state.presentPlanArmedSeq, PRESENT_PLAN_GATE_TOOLS, true, true));
  const reviewRan =
    reviewWorked &&
    state.presentPlanArmedSeq !== undefined &&
    (await reviewRanSince(bb, ctx.threadId, state.presentPlanArmedSeq, PRESENT_PLAN_GATE_TOOLS, true, false));
  await settlePlanBaseline(bb, ctx.threadId, planFilePath, reviewWorked);
  if (reviewRan && config.autoApprovePlans) {
    await clearPlanBaseline(bb, ctx.threadId, planFilePath);
    await recordFire(review, ctx.projectId, ctx.threadId, "fired", "plan-approved");
    bb.log.info(
      `auto-review: auto-approved the reviewed plan ${basename(planFilePath)} in thread ${ctx.threadId}`,
    );
    return PRESENT_PLAN_APPROVED_MESSAGE;
  }
  if (check !== "loaded") {
    warnPlanUnreviewed(bb, ctx.threadId, basename(planFilePath), check);
  }
  await recordFire(review, ctx.projectId, ctx.threadId, "stood-down", planReleaseReason(check));
  return check === "missing" ? PRESENT_PLAN_INCOMPLETE_MESSAGE : PRESENT_PLAN_REVIEWED_MESSAGE;
}

/** `PresentPlan`'s `execute`: the first call for a plan arms its review, the second releases it. */
async function presentPlan(
  review: ReviewContext,
  planFilePath: string,
  ctx: PluginAgentToolContext,
): Promise<PluginAgentToolResult> {
  const { bb } = review;
  return withThreadLock(ctx.threadId, async () => {
    const state = await readState(bb, ctx.threadId);
    const project = await readProjectConfig(bb, ctx.projectId);
    const config = effectiveConfig(review.globals, project);
    if (!config.enabled) {
      return PRESENT_PLAN_OFF_MESSAGE;
    }
    if (!SCOPE_PATH_ALLOW.test(planFilePath)) {
      return {
        content: [{ type: "text", text: PRESENT_PLAN_INVALID_PATH_MESSAGE }],
        isError: true,
      };
    }
    const now = Date.now();
    if (presentPlanArmed(state, planFilePath, now)) {
      return releasePlan(review, ctx, state, config, planFilePath);
    }
    const armedSeq = await captureArmedSeq(review, ctx.threadId);
    await writeState(
      bb,
      ctx.threadId,
      {
        presentPlanArmedAt: now,
        presentPlanArmedPath: planFilePath,
        ...(armedSeq === undefined ? {} : { presentPlanArmedSeq: armedSeq }),
      },
      // A redo flag left by an expired arm must not skip this plan's redo.
      armedSeq === undefined ? ["presentPlanRedone", "presentPlanArmedSeq"] : ["presentPlanRedone"],
    );
    await recordFire(review, ctx.projectId, ctx.threadId, "fired", "plan-review");
    const content = await readPlanFile(planFilePath);
    const prompt = buildPresentPlanReviewPrompt({
      reviewMode: config.reviewMode,
      planFilePath,
      baseline: await planScope(bb, ctx.threadId, planFilePath, content, now),
    });
    await stagePlanPending(bb, ctx.threadId, planFilePath, content, now);
    return prompt;
  });
}

// Only threads the plan gate can serve get a plan-first tool and
// instruction: a child or plugin-spawned thread would stop for an approval
// nobody reviews or may be watching. The same top-level threads get
// `ReportReview`, with or without the global switch (see below). The
// callback must be synchronous, so the plan-first part follows the global
// switch only: a project or thread that turned
// auto-review off still gets one of these, and its plan then goes to the
// user unreviewed (or, on `PresentPlan`, is told review is off here — see
// `presentPlan` above).
//
// The claude-code family (`claude-code` and its `claude-code-<slug>` profile
// providers, which share one bridge) is the only set of providers whose plan
// approvals reach the NATIVE gate (`gatePlan`): its ExitPlanMode routes to a real `interaction.pending`
// with `subject.kind: "plan"`, even in the `full` permission mode, which is
// what lets that gate hold and re-present a plan by denying its own
// approval. The ACP bridge, by contrast, auto-approves every permission
// request in `full` mode (`handlePermissionRequest`), and in its other modes
// raises only a generic approval, never one with that subject kind — the
// SDK has no capability flag for this, so there is nothing to branch on but
// the provider id (`isNativePlanGateProvider`). On every other provider the native gate never sees a
// plan, so instead those threads get the `PresentPlan` tool: a
// provider-agnostic review path the agent drives itself (write the plan to
// a file, call `PresentPlan`, apply its findings, call it again to
// release). A claude-code-family provider never gets this tool — it already has a review path
// through the native gate, and offering both would let one plan be reviewed
// twice or let a `PresentPlan` cycle (which the native gate cannot see)
// stand in for a native review it never actually ran.
function agentConfiguration(
  review: ReviewContext,
  context: PluginAgentConfigurationContext,
): PluginAgentConfiguration {
  const topLevel =
    context.thread.parentThreadId === null && context.origin.pluginId === null;
  if (!topLevel) {
    return { tools: [], skills: ["auto-review"] };
  }
  // ReportReview ignores the global switch: a project can enable review
  // while the global one is off, and the tool does nothing outside a review.
  if (!review.globals.enabled) {
    return { tools: [REPORT_REVIEW_TOOL_NAME], skills: ["auto-review"] };
  }
  return isNativePlanGateProvider(context.provider.id)
    ? {
        tools: [REPORT_REVIEW_TOOL_NAME],
        skills: ["auto-review"],
        instructions: PLAN_FIRST_INSTRUCTIONS,
      }
    : {
        tools: [PRESENT_PLAN_TOOL_NAME, REPORT_REVIEW_TOOL_NAME],
        skills: ["auto-review"],
        instructions: PLAN_FIRST_INSTRUCTIONS_PRESENT_PLAN,
      };
}

export function registerPlanTools(review: ReviewContext): void {
  const { bb } = review;
  bb.agents.configure((context) => agentConfiguration(review, context));

  registerReportTool(review);

  bb.agents.registerTool({
    name: PRESENT_PLAN_TOOL_NAME,
    description:
      "Present a plan you wrote to a file for auto-review's calibrated review before it reaches the user. Call again with the same planFilePath after applying the review's findings to release it.",
    presentation: {
      label: { pending: "Presenting plan", completed: "Presented plan" },
    },
    parameters: z.object({ planFilePath: z.string() }),
    async execute(input, ctx): Promise<PluginAgentToolResult> {
      return presentPlan(review, input.planFilePath, ctx);
    },
  });
}
