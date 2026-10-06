import type { PluginRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

const projectSettingSchema = z.object({
  id: z.string(),
  name: z.string(),
  autoApprovePlans: z.boolean(),
  /** Whether auto-review currently runs for the project; when false the switch has no effect. */
  reviewActive: z.boolean(),
});
export type ProjectSetting = z.infer<typeof projectSettingSchema>;

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
} satisfies PluginRpcContract;

export type AutoReviewRpcContract = typeof autoReviewRpcContract;
