import { z } from "zod";

/**
 * The held plan-approval form, shared by `present-plan.ts` (opens it),
 * `detect-events.ts` (credits its approval) and `app.tsx` (renders it), so a
 * rename in one place cannot silently break crediting in another.
 */

/** This plugin's id: the `origin.pluginId` core stamps on the form's interaction. */
export const PLAN_APPROVAL_PLUGIN_ID = "auto-review";

/** The renderer id the form is opened with and `app.tsx` registers. */
export const PLAN_APPROVAL_RENDERER = "plan-approval";

export const PLAN_APPROVAL_TITLE = "Plan approval";

/**
 * How long the form waits for an answer. Under the fork daemon's 65-minute
 * ceiling on forwarded tool calls (`TOOL_CALL_TIMEOUT_MS` in bb core
 * `apps/host-daemon/src/server-client.fork.ts`): past it the held request
 * aborts and the plugin's own cancel text cannot reach the agent.
 */
export const PLAN_APPROVAL_TIMEOUT_MS = 60 * 60 * 1000;

export const PLAN_APPROVAL_FEEDBACK_MAX = 2000;

/** What the form shows: the plan file and whether its review completed. */
export const planApprovalPayloadSchema = z.object({
  planFilePath: z.string(),
  reviewed: z.boolean(),
});
export type PlanApprovalPayload = z.infer<typeof planApprovalPayloadSchema>;

/** What the form submits: strict, so any extra key is a malformed value. */
const planApprovalValueSchema = z.union([
  z.strictObject({ approved: z.literal(true) }),
  z.strictObject({ approved: z.literal(false), feedback: z.string().max(PLAN_APPROVAL_FEEDBACK_MAX).optional() }),
]);
/** A value that failed the schema: told apart from a change request so the answer is not passed off as feedback-less. */
export type PlanApprovalDecision = z.infer<typeof planApprovalValueSchema> | { approved: false; unreadable: true };

/**
 * The one reading of a submitted value. `describeSubmission` (the row the gate
 * credits) and the tool result both run it, so they cannot disagree. Anything
 * that is not exactly an approval or a change request is `unreadable`: not
 * approved, and reported as discarded, not as a change request.
 */
export function parsePlanApprovalValue(value: unknown): PlanApprovalDecision {
  const parsed = planApprovalValueSchema.safeParse(value);
  return parsed.success ? parsed.data : { approved: false, unreadable: true };
}

/** What the resolved row keeps. Never the feedback: it is free text from whoever answered. */
const planApprovalDescriptionPayloadSchema = z.object({ approved: z.boolean() });

export function planApprovalDescription(decision: PlanApprovalDecision): {
  title: string;
  payload: { approved: boolean };
} {
  return {
    title: decision.approved ? "Approved" : "unreadable" in decision ? "Answer not readable" : "Changes requested",
    payload: { approved: decision.approved },
  };
}

/** Whether a resolved row's description payload records an approval. */
export function planApprovalDescribed(payload: unknown): boolean {
  const parsed = planApprovalDescriptionPayloadSchema.safeParse(payload);
  return parsed.success && parsed.data.approved;
}
