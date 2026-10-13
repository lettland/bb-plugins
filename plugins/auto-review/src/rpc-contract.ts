import type { PluginRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { REVIEW_OUTCOMES } from "./findings-schema.js";

const projectSettingSchema = z.object({
  id: z.string(),
  name: z.string(),
  autoApprovePlans: z.boolean(),
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

export const autoReviewRpcContract = {
  listProjectSettings: {
    input: z.null(),
    output: z.object({ projects: z.array(projectSettingSchema) }),
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
    input: z.object({ threadId: z.string().min(1).max(128) }),
    output: threadReviewSchema,
  },
} satisfies PluginRpcContract;

export type AutoReviewRpcContract = typeof autoReviewRpcContract;
