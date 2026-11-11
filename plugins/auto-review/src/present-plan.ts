import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import type {
  PluginAgentConfiguration,
  PluginAgentConfigurationContext,
  PluginAgentToolContext,
  PluginAgentToolResult,
} from "@get-bb/plugin-sdk";
import { z } from "zod";
import { PRESENT_PLAN_CHAT_KEYS } from "./chat-approval-state.js";
import { clearPlanBaseline, planScope, settlePlanBaseline, stagePlanPending } from "./baseline-store.js";
import { effectiveConfig, readProjectConfig } from "./config.js";
import { buildPlanApprovalPayload, planSha256Of } from "./plan-approval-payload.js";
import { readPlanFileForForm } from "./plan-file.js";
import { recordFire, type EffectiveConfig, type ReviewContext } from "./context.js";
import { tryCaptureSinceSeq } from "./detect.js";
import { isNativePlanGateProvider } from "./gate.js";
import {
  lightPlan,
  planReleaseReason,
  planReviewerTally,
  planReviewTallyExtras,
  planSkillCheck,
  reviewRanSince,
  warnPlanUnreviewed,
} from "./plan.js";
import {
  buildPresentPlanReviewPrompt,
  PLAN_FIRST_INSTRUCTIONS,
  PLAN_FIRST_INSTRUCTIONS_PRESENT_PLAN,
  PLAN_FIRST_INSTRUCTIONS_PRESENT_PLAN_FORM,
  PRESENT_PLAN_APPROVED_MESSAGE,
  PRESENT_PLAN_INCOMPLETE_MESSAGE,
  PRESENT_PLAN_INVALID_PATH_MESSAGE,
  PRESENT_PLAN_OFF_MESSAGE,
  presentPlanRedoMessage,
  PRESENT_PLAN_REVIEWED_MESSAGE,
  SCOPE_PATH_ALLOW,
} from "./prompt.js";
import {
  askPlanApproval,
  needsForm,
  nextFormOpenedAt,
  planFormCheckFailedResult,
  planFormMarkerFresh,
  planFormOpen,
  planFormOpenResult,
  planFormPending,
  type NeedsForm,
} from "./present-plan-form.js";
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
 * run in one. With the approval form on (`formMode`), the two outcomes that
 * wait for the user return a `NeedsForm` instead of their text, and record the
 * form as open; with a form already open the release is refused, still armed.
 * The form's payload carries the plan as it is at this release (read once, see
 * `readPlanFileForForm`); a plan path outside the thread's workspace and its
 * plan directory is refused with the invalid-path result, still armed.
 */
async function releasePlan(
  review: ReviewContext,
  ctx: PluginAgentToolContext,
  state: ThreadState,
  config: EffectiveConfig,
  planFilePath: string,
  formMode: boolean,
): Promise<PluginAgentToolResult | NeedsForm> {
  const { bb } = review;
  const check = await planSkillCheck(bb, ctx.threadId, config.reviewMode, state.presentPlanArmedSeq);
  if (check === "missing" && state.presentPlanRedone !== true) {
    const redoSeq = await captureArmedSeq(review, ctx.threadId);
    // The redo reviews the whole plan: its baseline goes, and the plan as it stands is staged afresh.
    const content = await readPlanFile(planFilePath);
    // A redo is never sized lighter than its arm: an armed standard stays
    // standard even when review fixes shrink the file across the light line;
    // anything else recomputes from the file as it stands. Either way the tier
    // is stored, so the redo's prompt and its release tally agree.
    const light = state.presentPlanLight === false ? false : lightPlan(content);
    await writeState(
      bb,
      ctx.threadId,
      {
        presentPlanArmedAt: Date.now(),
        presentPlanRedone: true,
        presentPlanLight: light,
        ...(redoSeq === undefined ? {} : { presentPlanArmedSeq: redoSeq }),
      },
      redoSeq === undefined ? ["presentPlanArmedSeq", ...PRESENT_PLAN_CHAT_KEYS] : [...PRESENT_PLAN_CHAT_KEYS],
    );
    await recordFire(review, ctx.projectId, ctx.threadId, "fired", "plan-review-redo");
    await clearPlanBaseline(bb, ctx.threadId, planFilePath);
    await stagePlanPending(bb, ctx.threadId, planFilePath, content, Date.now());
    return presentPlanRedoMessage(config.reviewMode, light);
  }
  // The release moment is exactly when the reviewers are done, so the tally
  // counts them here, from the tier the arm stored.
  const tallyExtras = planReviewTallyExtras(
    await planReviewerTally(bb, ctx.threadId, state.presentPlanArmedAt, state.presentPlanLight === true),
  );
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
  const autoApproved = reviewRan && config.autoApprovePlans;
  const opensForm = formMode && !autoApproved;
  const now = Date.now();
  const openedAt = nextFormOpenedAt(state, now);
  // A release that would open a form while another is open is refused before
  // anything is cleared, so the plan stays armed for the same call to release later.
  // A fresh marker counts as open without asking the host: its form may still
  // be registering. An older marker with no pending form behind it (a restart
  // skipped the `finally` that clears it) is stale: the write below replaces it.
  if (opensForm && planFormOpen(state, now)) {
    const found = planFormMarkerFresh(state, now) ? "pending" : await planFormPending(bb, ctx.threadId);
    if (found === "pending") {
      return planFormOpenResult();
    }
    if (found === "failed") {
      return planFormCheckFailedResult();
    }
    bb.log.info(`auto-review: the plan approval form's open marker in ${ctx.threadId} has no pending form behind it, so it is stale and replaced`);
  }
  // The form shows the plan as it stands now, after the review's fixes: read once, from the resolved
  // path, never from the baseline staged at arm time. A path outside the allowed roots is refused
  // here, before anything is cleared, so the plan stays armed.
  const planRead = opensForm ? await readPlanFileForForm(bb, ctx.threadId, planFilePath) : null;
  if (planRead?.kind === "outside") {
    return { content: [{ type: "text", text: PRESENT_PLAN_INVALID_PATH_MESSAGE }], isError: true };
  }
  // One patch: a failed write cannot leave the plan disarmed without its marker.
  await writeState(bb, ctx.threadId, opensForm ? { presentPlanFormOpenAt: openedAt } : {}, [...PRESENT_PLAN_KEYS]);
  await settlePlanBaseline(bb, ctx.threadId, planFilePath, reviewWorked);
  if (autoApproved) {
    await clearPlanBaseline(bb, ctx.threadId, planFilePath);
    await recordFire(review, ctx.projectId, ctx.threadId, "fired", "plan-approved", tallyExtras);
    bb.log.info(
      `auto-review: auto-approved the reviewed plan ${basename(planFilePath)} in thread ${ctx.threadId}`,
    );
    // An auto-approval leaves no interaction behind: the cursor is what the
    // missing-plan gate reads to credit it. Without one the gate fails closed.
    const approvedSeq = await tryCaptureSinceSeq(
      bb,
      ctx.threadId,
      `the auto-approved plan in ${ctx.threadId}; the missing-plan check will not count it as approved`,
    );
    if (approvedSeq !== undefined) {
      await writeState(bb, ctx.threadId, { presentPlanAutoApprovedSeq: approvedSeq });
    }
    return PRESENT_PLAN_APPROVED_MESSAGE;
  }
  if (check !== "loaded") {
    warnPlanUnreviewed(bb, ctx.threadId, basename(planFilePath), check);
  }
  await recordFire(review, ctx.projectId, ctx.threadId, "stood-down", planReleaseReason(check), tallyExtras);
  const text = check === "missing" ? PRESENT_PLAN_INCOMPLETE_MESSAGE : PRESENT_PLAN_REVIEWED_MESSAGE;
  if (!formMode) {
    // The text tells the agent to wait for approval in chat; the cursor is what the missing-plan gate counts typed replies from.
    const releasedSeq = await tryCaptureSinceSeq(
      bb,
      ctx.threadId,
      `the plan released to chat in ${ctx.threadId}; the missing-plan check will not count a typed approval`,
    );
    if (releasedSeq !== undefined) {
      await writeState(bb, ctx.threadId, { presentPlanChatReleasedSeq: releasedSeq });
    }
    return text;
  }
  return {
    form: buildPlanApprovalPayload({
      planFilePath,
      reviewed: check !== "missing",
      bytes: planRead?.kind === "read" ? planRead.bytes : null,
    }),
    bound: planRead?.kind === "read" ? { path: planRead.path, sha256: planSha256Of(planRead.bytes) } : null,
    openedAt,
  };
}

/** `PresentPlan`'s `execute`: the first call for a plan arms its review, the second releases it. */
async function presentPlan(
  review: ReviewContext,
  planFilePath: string,
  ctx: PluginAgentToolContext,
): Promise<PluginAgentToolResult> {
  const { bb } = review;
  const outcome = await withThreadLock<PluginAgentToolResult | NeedsForm>(ctx.threadId, async () => {
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
      // The mode the thread's instructions were written with; the live setting only before one is stored.
      return releasePlan(review, ctx, state, config, planFilePath, state.presentPlanFormMode ?? config.planApprovalForm);
    }
    const armedSeq = await captureArmedSeq(review, ctx.threadId);
    // The tier comes from the file as armed; release reads the stored key,
    // never the re-read file, whose review fixes routinely shrink it across
    // the light boundary.
    const content = await readPlanFile(planFilePath);
    const light = lightPlan(content);
    await writeState(
      bb,
      ctx.threadId,
      {
        presentPlanArmedAt: now,
        presentPlanArmedPath: planFilePath,
        presentPlanLight: light,
        ...(armedSeq === undefined ? {} : { presentPlanArmedSeq: armedSeq }),
      },
      // A redo flag left by an expired arm must not skip this plan's redo; an earlier plan's chat approval must not carry over.
      armedSeq === undefined
        ? ["presentPlanRedone", "presentPlanArmedSeq", ...PRESENT_PLAN_CHAT_KEYS]
        : ["presentPlanRedone", ...PRESENT_PLAN_CHAT_KEYS],
    );
    await recordFire(review, ctx.projectId, ctx.threadId, "fired", "plan-review");
    const prompt = buildPresentPlanReviewPrompt({
      reviewMode: config.reviewMode,
      planFilePath,
      light,
      baseline: await planScope(bb, ctx.threadId, planFilePath, content, now),
    });
    await stagePlanPending(bb, ctx.threadId, planFilePath, content, now);
    return prompt;
  });
  return needsForm(outcome) ? askPlanApproval(review, ctx, outcome) : outcome;
}

// Only threads the plan gate can serve get a plan-first tool and
// instruction: a child or plugin-spawned thread would stop for an approval
// nobody reviews or may be watching. The same top-level threads get
// `ReportReview`, with or without the global switch (see below). The
// callback must be synchronous, so the plan-first part follows the global
// switch only (the plan approval form's instruction variant follows its global
// setting the same way, resolved once per thread and stored in its metadata, so
// a toggle applies to threads started after it): a project or thread that turned
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
    : presentPlanConfiguration(review, context);
}

/**
 * Decided once per thread and stored: bb configures a thread every turn, but a
 * provider keeps only the instructions it started with (Codex: `thread/start`;
 * ACP: the session's first prompt). The first configure stores the live
 * setting, later ones read it back, and `PresentPlan` follows the stored mode.
 * The agent can write this metadata, but a forged value only switches between
 * two modes that both fail closed for gate credit. The write is fire-and-forget
 * because the callback is synchronous; a failed one is logged, and the next configure
 * stores the setting as it is then (off the thread-start mode only after a toggle).
 */
function presentPlanConfiguration(review: ReviewContext, context: PluginAgentConfigurationContext): PluginAgentConfiguration {
  const { bb } = review;
  const stored = context.pluginMetadata.presentPlanFormMode;
  const form = typeof stored === "boolean" ? stored : review.globals.planApprovalForm;
  if (typeof stored !== "boolean") {
    void writeState(bb, context.thread.id, { presentPlanFormMode: form }).catch((error: unknown) => {
      bb.log.warn(`auto-review: could not store the plan approval form mode for ${context.thread.id}: ${error instanceof Error ? error.message : String(error)}`);
    });
  }
  return {
    tools: [PRESENT_PLAN_TOOL_NAME, REPORT_REVIEW_TOOL_NAME],
    skills: ["auto-review"],
    instructions: form ? PLAN_FIRST_INSTRUCTIONS_PRESENT_PLAN_FORM : PLAN_FIRST_INSTRUCTIONS_PRESENT_PLAN,
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
