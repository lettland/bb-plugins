import { experimental_PluginRpcRefusal, type ExperimentalPluginRpcHandlerContext, type JsonValue } from "@get-bb/plugin-sdk";
import {
  describeReviewOverride,
  effectiveConfig,
  readProjectConfig,
  readProjectConfigStatus,
  setAutoApprovePlans,
  setProjectReview,
} from "./config.js";
import { recordFire, type ReviewContext } from "./context.js";
import { captureTree, tryCaptureSinceSeq } from "./detect.js";
import { readFindings } from "./findings-store.js";
import { summarizeReview } from "./findings.js";
import { passesThreadGate } from "./gate.js";
import { releaseDeferred } from "./release.js";
import { recordCancelledReview } from "./review-outcome.js";
import { removeReview } from "./reviews.js";
import { autoReviewRpcContract } from "./rpc-contract.js";
import {
  PLAN_GATE_KEYS,
  PRESENT_PLAN_KEYS,
  publishThreadReview,
  readState,
  resetToIdlePatch,
  REVIEW_IN_FLIGHT_PHASES,
  withThreadLock,
  type ThreadState,
} from "./state.js";
import { userTurnRunning } from "./user-turn.js";

async function listProjects(ctx: ReviewContext) {
  const projects = await ctx.bb.sdk.projects.list({ includePersonal: true });
  return projects
    .map((project) => ({ id: project.id, name: project.name }))
    .sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id));
}

async function eligibleThread(ctx: ReviewContext, threadId: string) {
  const thread = await ctx.bb.sdk.threads.get({ threadId });
  const { environmentId } = thread;
  if (environmentId === null || thread.deletedAt !== null || !passesThreadGate(thread)) {
    return null;
  }
  return { ...thread, environmentId };
}

type EligibleThread = NonNullable<Awaited<ReturnType<typeof eligibleThread>>>;

interface PreferencePatch {
  set: Record<string, JsonValue>;
  remove: readonly string[];
  removeDeferral: boolean;
  cancelQueuedEntryIds?: readonly string[];
  onQueueCancellation?: { entryId: string; set: Record<string, JsonValue>; remove: readonly string[] };
}

interface ThreadPreferenceRpcContext extends ExperimentalPluginRpcHandlerContext {
  // Optional on older hosts, which cannot authorize this write.
  experimental_threadPreferenceApproval?: { commit(patch: PreferencePatch): readonly string[] };
}

async function heldTurnCutoff(bb: ReviewContext["bb"], threadId: string, sinceSeq: number) {
  try {
    const [event] = await bb.sdk.threads.events.list({
      threadId, afterSeq: String(sinceSeq),
      types: ["turn/input/accepted", "turn/completed"], order: "desc", limit: "1",
    });
    if (event !== undefined) {
      // An accepted input belongs to the active turn. Its completion has a greater sequence.
      return { sinceSeq, clearAtSeq: event.type === "turn/completed" ? event.seq : event.seq + 1 };
    }
  } catch (error) {
    bb.log.warn(`auto-review: could not find the held turn in ${threadId}; waiting for an idle completion: ${String(error)}`);
  }
  return { sinceSeq };
}

async function resumedTurnState(
  ctx: ReviewContext,
  thread: EligibleThread,
  state: ThreadState,
): Promise<Partial<ThreadState>> {
  const { bb } = ctx;
  const reviewInFlight = state.phase === "awaiting-review";
  const since = state.lastCodeReviewSeq ?? state.reviewDeliveredSeq ?? 0;
  if (reviewInFlight && !(await userTurnRunning(ctx, thread.id, since))) {
    return {};
  }
  const startedAt = Date.now();
  const [sinceSeq, tree] = await Promise.all([
    tryCaptureSinceSeq(bb, thread.id, `re-enabling review in ${thread.id}; the current turn will not be reviewed`),
    captureTree(bb, thread.environmentId),
  ]);
  if (sinceSeq === undefined) {
    return reviewInFlight
      ? { skipHeldTurn: await heldTurnCutoff(bb, thread.id, state.handledTurnEndSeq ?? since) }
      : {};
  }
  const start = { sinceSeq, startedAt, ...(tree === undefined ? {} : { tree }) };
  // A held review still uses the original cursor to identify the turn at idle.
  return reviewInFlight ? { userTurnStart: start } : { turnStart: start };
}

async function preparePreferenceChange(
  ctx: ReviewContext,
  thread: EligibleThread,
  state: ThreadState,
  skipAutoReview: boolean,
) {
  const removeDeferral = state.phase === "deferred";
  const stoodDown = removeDeferral ||
    (state.phase === "idle" && state.turnStart !== undefined && state.turnDecided !== true);
  const { set, remove } = stoodDown ? resetToIdlePatch() : { set: {}, remove: [] };
  if (state.planReviewArmedAt !== undefined || state.presentPlanArmedAt !== undefined) {
    // An already-sent prompt may run, but its evidence cannot approve a later plan.
    remove.push(...PLAN_GATE_KEYS, ...PRESENT_PLAN_KEYS);
  }
  if (state.phase === "awaiting-review") {
    remove.push("userTurnStart", "userTurnAuthored", "skipHeldTurn");
  }
  if (!skipAutoReview && thread.status === "active" && state.phase !== "pending-dispatch") {
    if (!stoodDown && state.phase === "idle") remove.push("turnStart", "turnDecided", "lastIdle");
    Object.assign(set, await resumedTurnState(ctx, thread, state));
  }
  const patch: PreferencePatch = { set, remove: remove.filter((key) => !Object.hasOwn(set, key)), removeDeferral };
  if (skipAutoReview) {
    const pendingCode = state.phase === "pending-dispatch" ? state.pendingEntryId : undefined;
    patch.cancelQueuedEntryIds = [pendingCode, state.planReviewEntryId].filter((id) => id !== undefined);
    if (pendingCode !== undefined) {
      const reset = resetToIdlePatch();
      patch.onQueueCancellation = { entryId: pendingCode, set: reset.set, remove: [...reset.remove, "lastCodeReviewSeq"] };
    }
  }
  return { patch, stoodDown };
}

async function saveThreadReviewPreference(
  ctx: ReviewContext,
  { threadId, skipAutoReview }: { threadId: string; skipAutoReview: boolean },
  request: ThreadPreferenceRpcContext,
) {
  const { bb } = ctx;
  const approval = request.experimental_threadPreferenceApproval;
  if (approval === undefined) {
    throw new experimental_PluginRpcRefusal({ code: "forbidden", message: "Confirm this change in BB Desktop." });
  }
  const releaseProvider = await withThreadLock(threadId, async () => {
    const thread = await eligibleThread(ctx, threadId);
    if (thread === null) {
      throw new experimental_PluginRpcRefusal({ code: "forbidden", message: "Auto-review settings require an eligible top-level thread" });
    }
    if (skipAutoReview === ctx.threadOptOuts.has(threadId)) {
      approval.commit({ set: {}, remove: [], removeDeferral: false });
      return null;
    }
    const state = await readState(bb, threadId);
    const { patch, stoodDown } = await preparePreferenceChange(ctx, thread, state, skipAutoReview);
    const cancelled = approval.commit(patch);
    if (skipAutoReview) ctx.threadOptOuts.add(threadId);
    else ctx.threadOptOuts.delete(threadId);
    publishThreadReview(bb, threadId);
    const cancelledCode = patch.onQueueCancellation !== undefined && cancelled.includes(patch.onQueueCancellation.entryId);
    try {
      if (cancelledCode) {
        await removeReview(bb, threadId);
        await recordCancelledReview(bb, threadId, state);
      }
      if (stoodDown || cancelledCode) await recordFire(ctx, thread.projectId, threadId, "stood-down", "disabled");
    } catch (error) {
      bb.log.warn(`auto-review: could not record discarded work for ${threadId}: ${String(error)}`);
    }
    return cancelledCode ? thread.providerId : null;
  });
  if (releaseProvider !== null) await releaseDeferred(ctx, releaseProvider);
  return { skipAutoReview };
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
    setThreadReviewPreference(input, request) {
      return saveThreadReviewPreference(ctx, input, request);
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
