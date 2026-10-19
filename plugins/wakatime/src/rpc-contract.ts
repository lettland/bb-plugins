import type { PluginRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

/** Ids the host mints are short and use these characters only. */
export const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const idSchema = z.string().regex(ID_PATTERN);

export const ERROR_KINDS = ["missing-cli", "auth", "network", "config", "timeout", "other"] as const;
export type ErrorKind = (typeof ERROR_KINDS)[number];

/** Why the cli path was rejected, for a `missing-cli` error. */
export const PATH_PROBLEMS = ["not-absolute", "not-found", "not-a-file", "not-executable"] as const;
export type PathProblem = (typeof PATH_PROBLEMS)[number];

const statusSchema = z.object({
  /** The current `cliPath` setting with `~` expanded. */
  cliPath: z.string(),
  lastHeartbeatAt: z.number().nullable(),
  lastSyncAt: z.number().nullable(),
  /** The latest failure of either job; see `visibleError` for when it still matters. */
  lastError: z
    .object({
      kind: z.enum(ERROR_KINDS),
      job: z.enum(["heartbeat", "sync"]),
      exitCode: z.number().nullable(),
      at: z.number(),
      problem: z.enum(PATH_PROBLEMS).optional(),
    })
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
