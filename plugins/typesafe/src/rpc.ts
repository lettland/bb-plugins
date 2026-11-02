import type { BbPluginApi, PluginRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { TriageStore, TRIAGE_KINDS } from "./triage.js";

export const changeSizeRpcContract = {
  changeSize: {
    input: z.object({ threadId: z.string().min(1).max(128) }),
    output: z.object({
      verdict: z.enum(TRIAGE_KINDS).nullable(),
      messageSeq: z.number().nullable(),
    }),
  },
} satisfies PluginRpcContract;

/** Serves the stored verdict per thread; auto-review reads it over `bb.sdk.plugins.callRpc`. */
export function registerChangeSizeRpc(bb: BbPluginApi, store: TriageStore): void {
  bb.rpc.register(changeSizeRpcContract, {
    changeSize(input) {
      return store.changeSize(input.threadId) ?? { verdict: null, messageSeq: null };
    },
  });
}
