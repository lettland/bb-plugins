import { z } from "zod";

/**
 * The thread-state keys of a plan released to a chat approval, outside
 * `PRESENT_PLAN_KEYS` and the latch keys on purpose, so `bb auto-review reset`
 * keeps them. Unlike `presentPlanAutoApprovedSeq`, which survives a new arm, a
 * chat approval does not: both arms delete these (`PRESENT_PLAN_CHAT_KEYS`), so
 * a new plan needs a new approval.
 */
export const chatApprovalStateShape = {
  /** The timeline cursor when `PresentPlan` released a plan to a chat approval (no form, not auto-approved), which the missing-plan gate counts typed replies from. */
  presentPlanChatReleasedSeq: z.number().int().nonnegative().optional(),
  /** The seq of the typed reply already credited as approval, so a later read counts it without walking a timeline that may have truncated. */
  presentPlanChatApprovedSeq: z.number().int().nonnegative().optional(),
  /** TypeSafe's numeric `approves` value per candidate reply seq, so a reply is judged once (a null answer is never stored). */
  presentPlanChatVerdicts: z.record(z.string(), z.number()).optional(),
};

export const PRESENT_PLAN_CHAT_KEYS: readonly string[] = Object.keys(chatApprovalStateShape);
