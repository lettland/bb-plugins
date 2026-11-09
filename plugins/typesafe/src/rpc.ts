import type { BbPluginApi, PluginRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { decide, redact, type Question } from "./client.js";
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

/** Within the 30 s default deadline the host gives a `callRpc` caller. */
export const PLAN_APPROVAL_TIMEOUT_MS = 10_000;
export const PLAN_APPROVAL_TEXT_MAX_CHARS = 4000;
/**
 * The most text the RPC accepts at all; longer is rejected at the boundary, and what is accepted is redacted, then cut to 4000.
 * `redact` is quadratic on one long run of word characters (about 90 ms at 8000, 5.7 s at 65536), so the cap bounds it.
 */
export const PLAN_APPROVAL_INPUT_MAX_CHARS = 8000;

export const PLAN_APPROVAL_QUESTION: Question = {
  type: "noul",
  instructions:
    "Does this message approve the plan the agent just presented, so the agent may implement it? Read typos and short forms as the word the user meant (for example \"approvee\" means approve, \"ok\" means yes). A question, a requested change, a refusal or an unrelated message is not approval.",
};

export const planApprovalRpcContract = {
  planApproval: {
    input: z.object({ projectId: z.string().min(1).max(128), text: z.string().max(PLAN_APPROVAL_INPUT_MAX_CHARS) }),
    output: z.object({ approves: z.number().nullable() }),
  },
} satisfies PluginRpcContract;

export interface PlanApprovalOptions {
  getApiKey: () => string | null;
  getModel: () => string;
  /** Whether the project is in `skipProjects`; a project that cannot be resolved counts as skipped. */
  isProjectSkipped: (projectId: string) => Promise<boolean>;
  log: (line: string) => void;
}

/** Redacted, then truncated — a reply longer than the cap is cut, never rejected. */
export function planApprovalState(text: string): string {
  return redact(text).slice(0, PLAN_APPROVAL_TEXT_MAX_CHARS);
}

/**
 * Judges whether a typed reply approves the plan; auto-review reads the
 * probability over `bb.sdk.plugins.callRpc`. `approves` is null whenever
 * TypeSafe gave no answer: no key, an HTTP error, a timeout, a bad answer, or a
 * skipped project (then nothing is sent).
 */
export function registerPlanApprovalRpc(bb: BbPluginApi, opts: PlanApprovalOptions): void {
  bb.rpc.register(planApprovalRpcContract, {
    async planApproval(input) {
      if (await opts.isProjectSkipped(input.projectId)) return { approves: null };
      const outcome = await decide(
        {
          state: planApprovalState(input.text),
          questions: { approves: PLAN_APPROVAL_QUESTION },
          model: opts.getModel(),
          apiKey: opts.getApiKey(),
          timeoutMs: PLAN_APPROVAL_TIMEOUT_MS,
        },
        { log: opts.log },
      );
      if (outcome.kind !== "ok") return { approves: null };
      const answer = outcome.value.answers.approves;
      return { approves: answer?.type === "noul" ? answer.noul : null };
    },
  });
}
