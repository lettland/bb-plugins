import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const SCOPES = ["branch", "changes", "staged", "all"] as const;

/** RPC between the server (resolves the target) and the host entry (runs git and aislop there). */
export const hostContract = defineRpcContract({
  scan: {
    input: z
      .object({
        directory: z.string().min(1),
        scope: z.enum(SCOPES),
        /** Explicit `--base`; skips root-branch resolution. */
        base: z.string().min(1).nullable(),
        /** The environment's root branch as bb knows it, when there is one. */
        rootBranch: z.string().min(1).nullable(),
        verbose: z.boolean(),
        json: z.boolean(),
        include: z.array(z.string()),
        exclude: z.array(z.string()),
        timeoutMs: z.number().int().positive(),
      })
      .strict(),
    output: z
      .object({
        exitCode: z.number().int(),
        stdout: z.string(),
        stderr: z.string(),
        /** The diff base handed to aislop, or null for the staged and full-repo scopes. */
        base: z.object({ ref: z.string(), sha: z.string() }).nullable(),
      })
      .strict(),
  },
});
