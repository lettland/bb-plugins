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
 * aborts and the plugin's own cancel text cannot reach the agent. A form that
 * detached from its turn (`experimental_detachOnAbort`) no longer depends on the
 * transport: its result reaches the agent as a bb message, so only this timeout
 * ends it.
 */
export const PLAN_APPROVAL_TIMEOUT_MS = 60 * 60 * 1000;

export const PLAN_APPROVAL_FEEDBACK_MAX = 2000;

/** Shown above the path when the plan text was cut to fit the payload budget. */
export const PLAN_TRUNCATED_NOTICE = "The plan is longer than the form can show; the rest is in the file below.";

/** Shown above the path when this host could not read the plan file (a plan on a remote host). */
export const PLAN_UNAVAILABLE_NOTICE = "The plan text isn't available on this host; open the file to read it.";

/**
 * What the form shows: the plan file, the plan text and whether its review
 * completed. `planText` and `planSha256` are null together when the plan file is
 * not readable on this host (a thread on a remote host): the form then shows
 * only the path, and nothing binds the approval to a text. `planSha256` hashes
 * the whole file, whether or not `truncated` cut the shown text.
 */
export const planApprovalPayloadSchema = z.object({
  planFilePath: z.string(),
  reviewed: z.boolean(),
  planText: z.string().nullable(),
  planSha256: z.string().nullable(),
  truncated: z.boolean(),
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
const planApprovalDescriptionPayloadSchema = z.object({ approved: z.boolean(), planChanged: z.boolean().optional() });

/** The title of a row for an approval that did not count because the plan file changed after the form opened. */
export const PLAN_CHANGED_TITLE = "Not counted: the plan changed after the form opened";

/**
 * The row for a submitted value. `planChanged` is set only for an approval
 * whose plan file no longer matches the text the form showed: it is recorded as
 * not approved, so the gate never credits it and counts it as a denial.
 */
export function planApprovalDescription(
  decision: PlanApprovalDecision,
  planChanged = false,
): {
  title: string;
  payload: { approved: boolean; planChanged?: true };
} {
  if (planChanged) {
    return { title: PLAN_CHANGED_TITLE, payload: { approved: false, planChanged: true } };
  }
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

/** Whether a resolved row's description payload records an approval that did not count because the plan changed. */
export function planApprovalChanged(payload: unknown): boolean {
  const parsed = planApprovalDescriptionPayloadSchema.safeParse(payload);
  return parsed.success && parsed.data.planChanged === true;
}
