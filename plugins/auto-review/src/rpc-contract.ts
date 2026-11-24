import type { PluginRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { THREAD_OPT_OUT_PREFIX } from "./context.js";
import { DEFERRAL_KEY_PREFIX } from "./deferrals.js";
import { REVIEW_OUTCOMES } from "./findings-schema.js";

const reviewOverrideSchema = z.enum(["default", "on", "off"]);

const projectSettingSchema = z.object({
  id: z.string(),
  name: z.string(),
  autoApprovePlans: z.boolean(),
  /** The project's own on/off override of the global switch; `default` follows the global switch. */
  reviewOverride: reviewOverrideSchema,
  /** The stored record for the project fails the schema, so the settings page cannot rewrite it. */
  malformed: z.boolean(),
  /** Whether auto-review currently runs for the project; when false the switch has no effect. */
  reviewActive: z.boolean(),
});
export type ProjectSetting = z.infer<typeof projectSettingSchema>;

const threadReviewSchema = z.object({
  /** `pending` while a review is in flight, else the last review's outcome, else `none`. */
  status: z.enum(["pending", "none", ...REVIEW_OUTCOMES]),
  /** When the last review ended; null while one is pending or none has run. */
  at: z.number().nullable(),
  openCount: z.number(),
  reRaisedCount: z.number(),
  /** Open findings the next review's prompt cannot list because of its cap. */
  omittedFromPrompt: z.number(),
  lastIncident: z.object({ at: z.number(), kind: z.string(), detail: z.string() }).nullable(),
});
export type ThreadReview = z.infer<typeof threadReviewSchema>;

const threadIdSchema = z.object({ threadId: z.string().min(1).max(128) });
const threadReviewPreferenceSchema = z.object({ skipAutoReview: z.boolean() });

const setThreadReviewPreference = {
  input: threadIdSchema.extend(threadReviewPreferenceSchema.shape),
  output: threadReviewPreferenceSchema,
  experimental_threadPreferenceApproval: {
    title: "Change auto-review for this thread",
    checkingDetail: "BB will discard reviews that have not been sent. Reviews already sent can finish.",
    clearingDetail: "This thread will follow the project or global setting. If auto-review is enabled, it can review edits made after this change in the current turn.",
    preferenceKeyPrefix: THREAD_OPT_OUT_PREFIX,
    deferralKeyPrefix: DEFERRAL_KEY_PREFIX,
  },
};

export const autoReviewRpcContract = {
  listProjectSettings: {
    input: z.null(),
    output: z.object({
      projects: z.array(projectSettingSchema),
      /** The global switch, which a `default` override follows. */
      globalEnabled: z.boolean(),
    }),
  },
  setProjectReview: {
    input: z.object({
      projectId: z.string().min(1),
      review: reviewOverrideSchema,
    }),
    output: z.object({
      projectId: z.string(),
      reviewOverride: reviewOverrideSchema,
      reviewActive: z.boolean(),
    }),
  },
  setAutoApprovePlans: {
    input: z.object({
      projectId: z.string().min(1),
      autoApprovePlans: z.boolean(),
    }),
    output: z.object({
      projectId: z.string(),
      autoApprovePlans: z.boolean(),
    }),
  },
  threadReview: {
    input: threadIdSchema,
    output: threadReviewSchema,
  },
  getThreadReviewPreference: {
    input: threadIdSchema,
    output: threadReviewPreferenceSchema.nullable(),
  },
  setThreadReviewPreference,
} satisfies PluginRpcContract;

export type AutoReviewRpcContract = typeof autoReviewRpcContract;
