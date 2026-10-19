import type { PluginRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

/** Ids the host mints are short and use these characters only. */
export const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const idSchema = z.string().regex(ID_PATTERN);

export const ERROR_KINDS = ["missing-cli", "auth", "network", "timeout", "other"] as const;
export type ErrorKind = (typeof ERROR_KINDS)[number];

const statusSchema = z.object({
  /** The expanded path the plugin last tried to run; null before the first use. */
  cliPath: z.string().nullable(),
  lastSuccessAt: z.number().nullable(),
  lastError: z
    .object({ kind: z.enum(ERROR_KINDS), exitCode: z.number().nullable(), at: z.number() })
    .nullable(),
  /** `excludeProjects` entries that match no project, as typed in the setting. */
  unmatchedExcludes: z.array(z.string()),
});
export type WakatimeStatus = z.infer<typeof statusSchema>;

export const wakatimeRpcContract = {
  heartbeat: {
    input: z.object({ projectId: idSchema.optional(), threadId: idSchema.optional() }),
    output: z.object({ sent: z.boolean() }),
  },
  status: {
    input: z.null(),
    output: statusSchema,
  },
} satisfies PluginRpcContract;

export type WakatimeRpcContract = typeof wakatimeRpcContract;
