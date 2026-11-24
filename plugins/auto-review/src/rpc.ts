import {
  describeReviewOverride,
  effectiveConfig,
  readProjectConfig,
  readProjectConfigStatus,
  setAutoApprovePlans,
  setProjectReview,
} from "./config.js";
import { setThreadOptOut, type GateThreadLike, type ReviewContext } from "./context.js";
import { readFindings } from "./findings-store.js";
import { summarizeReview } from "./findings.js";
import { passesThreadGate } from "./gate.js";
import { autoReviewRpcContract } from "./rpc-contract.js";
import { publishThreadReview, readState, REVIEW_IN_FLIGHT_PHASES, withThreadLock } from "./state.js";
import { standDown } from "./turn-end.js";

async function listProjects(ctx: ReviewContext) {
  const projects = await ctx.bb.sdk.projects.list({ includePersonal: true });
  return projects
    .map((project) => ({ id: project.id, name: project.name }))
    .sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id));
}

async function eligibleThread(ctx: ReviewContext, threadId: string): Promise<GateThreadLike | null> {
  const thread = await ctx.bb.sdk.threads.get({ threadId });
  if (thread.deletedAt !== null || !passesThreadGate(thread)) {
    return null;
  }
  return thread;
}

async function clearParkedReview(ctx: ReviewContext, thread: GateThreadLike): Promise<void> {
  const state = await readState(ctx.bb, thread.id);
  if (state.phase === "deferred") {
    await standDown(ctx, thread, state, "disabled");
  }
}

function saveThreadReviewPreference(ctx: ReviewContext, threadId: string, skipAutoReview: boolean) {
  const { bb } = ctx;
  return withThreadLock(threadId, async () => {
    const thread = await eligibleThread(ctx, threadId);
    if (thread === null) {
      throw new Error("Auto-review settings require an eligible top-level thread");
    }
    if (skipAutoReview === ctx.threadOptOuts.has(threadId)) {
      return { skipAutoReview };
    }
    if (skipAutoReview) {
      await setThreadOptOut(ctx, threadId, true);
      // The preference is saved. If cleanup fails, evaluation still sees
      // it and the re-enable path retries before a parked review can run.
      await clearParkedReview(ctx, thread).catch((error: unknown) => {
        bb.log.warn(`auto-review: could not clear the parked review for ${threadId}: ${String(error)}`);
      });
    } else {
      await clearParkedReview(ctx, thread);
      await setThreadOptOut(ctx, threadId, false);
    }
    publishThreadReview(bb, threadId);
    return { skipAutoReview };
  });
}

/** These RPC methods support the plugin UI. */
export function registerAutoReviewRpc(ctx: ReviewContext): void {
  const { bb } = ctx;
  bb.rpc.register(autoReviewRpcContract, {
    async listProjectSettings() {
      const projects = await listProjects(ctx);
      const rows = await Promise.all(
        projects.map(async (project) => {
          const { config, malformed } = await readProjectConfigStatus(bb, project.id);
          return {
            ...project,
            autoApprovePlans: config.autoApprovePlans ?? false,
            reviewOverride: describeReviewOverride(config),
            malformed,
            reviewActive: effectiveConfig(ctx.globals, config).enabled,
          };
        }),
      );
      return { projects: rows, globalEnabled: ctx.globals.enabled };
    },
    async threadReview(input) {
      const [store, state] = await Promise.all([
        readFindings(bb, input.threadId),
        readState(bb, input.threadId),
      ]);
      return summarizeReview(store, REVIEW_IN_FLIGHT_PHASES.includes(state.phase));
    },
    async getThreadReviewPreference({ threadId }) {
      const thread = await eligibleThread(ctx, threadId);
      return thread === null ? null : { skipAutoReview: ctx.threadOptOuts.has(threadId) };
    },
    setThreadReviewPreference({ threadId, skipAutoReview }) {
      return saveThreadReviewPreference(ctx, threadId, skipAutoReview);
    },
    async setAutoApprovePlans(input) {
      const projects = await listProjects(ctx);
      if (!projects.some((project) => project.id === input.projectId)) {
        throw new Error("BB project was not found");
      }
      await setAutoApprovePlans(bb, input.projectId, input.autoApprovePlans, "rpc");
      const stored = await readProjectConfig(bb, input.projectId);
      return {
        projectId: input.projectId,
        autoApprovePlans: stored.autoApprovePlans ??
          // v8 ignore start -- @preserve the setter above (rpc.ts:45) always stores a boolean and the read-back (rpc.ts:46) never misses the key, so the fallback cannot run.
          false,
        // v8 ignore stop
      };
    },
    async setProjectReview(input) {
      const projects = await listProjects(ctx);
      if (!projects.some((project) => project.id === input.projectId)) {
        throw new Error("BB project was not found");
      }
      const stored = await setProjectReview(bb, input.projectId, input.review, "rpc");
      return {
        projectId: input.projectId,
        reviewOverride: describeReviewOverride(stored),
        reviewActive: effectiveConfig(ctx.globals, stored).enabled,
      };
    },
  });
}
