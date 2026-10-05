import type { PluginAgentToolResult } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { effectiveConfig, readProjectConfig } from "./config.js";
import { recordFire, type ReviewContext } from "./context.js";
import { PLAN_GATE_PROVIDER_ID } from "./gate.js";
import {
  buildPresentPlanReviewPrompt,
  PLAN_FIRST_INSTRUCTIONS,
  PLAN_FIRST_INSTRUCTIONS_PRESENT_PLAN,
  PRESENT_PLAN_INVALID_PATH_MESSAGE,
  PRESENT_PLAN_OFF_MESSAGE,
  PRESENT_PLAN_REVIEWED_MESSAGE,
  SCOPE_PATH_ALLOW,
} from "./prompt.js";
import {
  presentPlanArmed,
  readState,
  withThreadLock,
  writeState,
} from "./state.js";

/** The provider-agnostic plan-review tool every served thread gets (see `configure` below). */
const PRESENT_PLAN_TOOL_NAME = "PresentPlan";

export function registerPlanTools(review: ReviewContext): void {
  const { bb } = review;
  // Only threads the plan gate can serve get a plan-first tool and
  // instruction: a child or plugin-spawned thread would stop for an approval
  // nobody reviews or may be watching. The callback must be synchronous, so it
  // follows the global switch only: a project or thread that turned
  // auto-review off still gets one of these, and its plan then goes to the
  // user unreviewed (or, on `PresentPlan`, is told review is off here — see
  // its `execute` below).
  //
  // Claude Code is the only provider whose plan approvals reach the NATIVE
  // gate (`gatePlan`): its ExitPlanMode routes to a real `interaction.pending`
  // with `subject.kind: "plan"`, even in the `full` permission mode, which is
  // what lets that gate hold and re-present a plan by denying its own
  // approval. The ACP bridge, by contrast, auto-approves every permission
  // request in `full` mode (`handlePermissionRequest`), and in its other modes
  // raises only a generic approval, never one with that subject kind — the
  // SDK has no capability flag for this, so there is nothing to branch on but
  // the provider id. On every other provider the native gate never sees a
  // plan, so instead those threads get the `PresentPlan` tool: a
  // provider-agnostic review path the agent drives itself (write the plan to
  // a file, call `PresentPlan`, apply its findings, call it again to
  // release). Claude Code never gets this tool — it already has a review path
  // through the native gate, and offering both would let one plan be reviewed
  // twice or let a `PresentPlan` cycle (which the native gate cannot see)
  // stand in for a native review it never actually ran.
  bb.agents.configure((context) => {
    const served =
      review.globals.enabled &&
      context.thread.parentThreadId === null &&
      context.origin.pluginId === null;
    if (!served) {
      return { tools: [], skills: ["auto-review"] };
    }
    return context.provider.id === PLAN_GATE_PROVIDER_ID
      ? { tools: [], skills: ["auto-review"], instructions: PLAN_FIRST_INSTRUCTIONS }
      : {
          tools: [PRESENT_PLAN_TOOL_NAME],
          skills: ["auto-review"],
          instructions: PLAN_FIRST_INSTRUCTIONS_PRESENT_PLAN,
        };
  });

  bb.agents.registerTool({
    name: PRESENT_PLAN_TOOL_NAME,
    description:
      "Present a plan you wrote to a file for auto-review's calibrated review before it reaches the user. Call again with the same planFilePath after applying the review's findings to release it.",
    presentation: {
      label: { pending: "Presenting plan", completed: "Presented plan" },
    },
    parameters: z.object({ planFilePath: z.string() }),
    async execute(input, ctx): Promise<PluginAgentToolResult> {
      return withThreadLock(ctx.threadId, async () => {
        const state = await readState(bb, ctx.threadId);
        const project = await readProjectConfig(bb, ctx.projectId);
        const config = effectiveConfig(review.globals, project);
        if (!config.enabled) {
          return PRESENT_PLAN_OFF_MESSAGE;
        }
        if (!SCOPE_PATH_ALLOW.test(input.planFilePath)) {
          return {
            content: [{ type: "text", text: PRESENT_PLAN_INVALID_PATH_MESSAGE }],
            isError: true,
          };
        }
        const now = Date.now();
        if (presentPlanArmed(state, input.planFilePath, now)) {
          await writeState(bb, ctx.threadId, {}, [
            "presentPlanArmedAt",
            "presentPlanArmedPath",
          ]);
          await recordFire(review, ctx.projectId, ctx.threadId, "stood-down", "plan-reviewed");
          return PRESENT_PLAN_REVIEWED_MESSAGE;
        }
        await writeState(bb, ctx.threadId, {
          presentPlanArmedAt: now,
          presentPlanArmedPath: input.planFilePath,
        });
        await recordFire(review, ctx.projectId, ctx.threadId, "fired", "plan-review");
        return buildPresentPlanReviewPrompt({
          reviewMode: config.reviewMode,
          planFilePath: input.planFilePath,
        });
      });
    },
  });
}
