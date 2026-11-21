import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { prepareCodeBaseline } from "./baseline-store.js";
import { reviewSize } from "./change-size.js";
import {
  recordFire,
  type EffectiveConfig,
  type FireExtra,
  type GateThreadLike,
  type ReviewContext,
} from "./context.js";
import { decide } from "./decide.js";
import { deferTurn, providerReviewInFlight } from "./deferral.js";
import { removeDeferral } from "./deferrals.js";
import {
  fetchWorkspace,
  tryCaptureSinceSeq,
  type AvailableWorkspace,
  type TurnScope,
} from "./detect.js";
import { parkedFire } from "./detect-park.js";
import { readFindings, recordUnreported } from "./findings-store.js";
import { openFindingsForPrompt } from "./findings.js";
import { refreshIdleSnapshot } from "./last-idle.js";
import { buildReviewPrompt, renderScope } from "./prompt.js";
import { withProviderLock } from "./provider-lock.js";
import { deliveredPatch } from "./review-outcome.js";
import { addReview, removeReview } from "./reviews.js";
import { resetToIdlePatch, writeState, type ThreadState } from "./state.js";
import { userTurnQueued, userTurnRunning } from "./user-turn.js";
import { lastIdleFloor } from "./last-idle.js";

const sendErrorSchema = z.object({
  status: z.number(),
  code: z.string(),
  body: z.object({ error: z.object({ details: z.object({
    reason: z.string().optional(),
    waitingOn: z.object({ kind: z.string() }).optional(),
  }) }) }),
});

type DispatchOutcome = { kind: "done" } | { kind: "carry"; busy: boolean } | { kind: "wait" };

function classifySendError(error: unknown): "active" | "queued" | "wait" | "failed" {
  const parsed = sendErrorSchema.safeParse(error);
  if (!parsed.success || parsed.data.status !== 409) return "failed";
  const { code, body: { error: { details } } } = parsed.data;
  if (code === "thread_user_work_pending" && (details.reason === "active" || details.reason === "queued")) return details.reason;
  if (code === "thread_not_writable" && details.reason === "already_active") return "active";
  if (code === "thread_send_not_ready" && details.waitingOn !== undefined) return "wait";
  return "failed";
}

/**
 * Whether a running plugin serves the `bb <command>` CLI command, or null when
 * the plugin list could not be read (logged with `onError`, which says what is
 * lost without the answer).
 */
async function pluginServesCommand(
  bb: BbPluginApi,
  command: string,
  onError: string,
): Promise<boolean | null> {
  try {
    const { plugins } = await bb.sdk.plugins.list();
    return plugins.some(
      (entry) => entry.enabled && entry.status === "running" && entry.cliCommand?.name === command,
    );
  } catch (error) {
    bb.log.warn(`${onError}: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

/**
 * Whether a running plugin serves `bb aislop`. The review only asks for the scan
 * then, so a missing or disabled aislop plugin never shows up as a failed step;
 * a failed lookup counts as absent and never blocks the review itself.
 */
export async function aislopScanAvailable(bb: BbPluginApi): Promise<boolean> {
  return (
    (await pluginServesCommand(
      bb,
      "aislop",
      "auto-review: could not list plugins, leaving the aislop scan out of this review",
    )) === true
  );
}

/**
 * Whether the devkit plugin is running (it registers the `bb devkit` command).
 * Unlike `aislopScanAvailable`, a failed lookup is its own answer, never
 * "absent": a plan review is only checked against `review-code` when devkit
 * is there, so guessing either way would redo or approve on a guess.
 */
export async function devkitRunning(bb: BbPluginApi): Promise<"running" | "absent" | "unknown"> {
  const serves = await pluginServesCommand(
    bb,
    "devkit",
    "auto-review: could not list plugins to tell whether devkit is running; the review-code check cannot run",
  );
  return serves === null ? "unknown" : serves ? "running" : "absent";
}

export interface DispatchInput {
  thread: GateThreadLike;
  state: ThreadState;
  environmentId: string;
  config: EffectiveConfig;
  decision: ReturnType<typeof decide>;
  base: string;
  isWorktree: boolean;
  scope: string[];
  turn: TurnScope;
  /** How many uncommitted changes nothing of the thread's family claimed, when there were any; recorded with the fire. */
  unclaimedCount?: number;
}

function turnStartHeadIf(condition: boolean, state: ThreadState): string | null {
  return condition ? (state.turnStart?.tree?.headSha ?? null) : null;
}

/**
 * The turn-start head to diff the turn's commits from, or null when the turn
 * made none. A pathless merge from a pull is already dropped from `commits`; a
 * commit whose paths could not be read still sets the range.
 */
export function committedSinceHead(turn: TurnScope, state: ThreadState): string | null {
  return turnStartHeadIf(turn.commits.length > 0, state);
}

/**
 * The turn-start head the secret scan runs from: set by any commit made during
 * the turn, this thread's or another's, or that arrived while it waited in the
 * review queue. A head that moved with no such commit
 * (a pull, a rebase, a branch switch) leaves it null; so does a turn whose only
 * commits arrived with the remote base, which scans nothing, as pulled commits
 * always did.
 */
export function commitScanHead(turn: TurnScope, state: ThreadState): string | null {
  return turnStartHeadIf(
    turn.commits.length > 0 || turn.foreignCommits.length > 0 || turn.parkedCommits.length > 0,
    state,
  );
}

/**
 * The cursor `lastCodeReviewSeq` records, taken before the send so the review's
 * own turn request lands after it. Empty when the cursor could not be read.
 */
async function codeReviewCursor(bb: BbPluginApi, threadId: string): Promise<{ lastCodeReviewSeq?: number }> {
  const lastCodeReviewSeq = await tryCaptureSinceSeq(
    bb,
    threadId,
    `the code review sent to ${threadId}; without it a later idle may review again before the user writes`,
  );
  return lastCodeReviewSeq === undefined ? {} : { lastCodeReviewSeq };
}

/**
 * The deltas of the review (see `prepareCodeBaseline`): every review stages
 * what the files in scope read, whatever its commit policy, so a later review
 * covers only what changed since. A review whose files have no baseline yet
 * gets the full one; every failure here means a full review, never a failed
 * dispatch. The workspace is the one `reviewSize` read at dispatch time.
 */
async function codeBaselineFor(
  bb: BbPluginApi,
  threadId: string,
  environmentId: string,
  rendered: ReturnType<typeof renderScope>,
  workspace: AvailableWorkspace | null,
) {
  return prepareCodeBaseline(bb, {
    threadId,
    environmentId,
    paths: rendered.listed,
    workspace,
    now: Date.now(),
  });
}

async function handleSendError(
  ctx: ReviewContext,
  input: { thread: GateThreadLike; state: ThreadState; extra: FireExtra; dispatchedAt: number; error: unknown },
): Promise<DispatchOutcome> {
  const { bb } = ctx;
  const { thread, state, extra, dispatchedAt, error } = input;
  const refusal = classifySendError(error);
  if (refusal !== "failed") {
    await writeState(bb, thread.id, {
      phase: state.phase,
      ...(state.lastCodeReviewSeq === undefined ? {} : { lastCodeReviewSeq: state.lastCodeReviewSeq }),
    }, ["dispatchedAt", "reviewSkillRequired", ...(state.lastCodeReviewSeq === undefined ? ["lastCodeReviewSeq"] : [])]);
    await removeReview(bb, thread.id);
    if (refusal === "wait") return { kind: "wait" };
    if (refusal === "active") {
      const current = await userTurnQueued(ctx, thread.id);
      if (current.busy && !current.userQueued && !(await userTurnRunning(ctx, thread.id, lastIdleFloor(state)))) {
        return { kind: "wait" };
      }
    }
    return { kind: "carry", busy: refusal === "active" };
  }
  bb.log.warn(
    `auto-review: failed to send the review turn for ${thread.id}: ${
      error instanceof Error ? error.message : String(error)
    }`,
  );
  const { set, remove } = resetToIdlePatch();
  // A review that never reached the agent does not count against the next one.
  await writeState(bb, thread.id, set, [...remove, "lastCodeReviewSeq"]);
  await removeReview(bb, thread.id);
  await recordUnreported(bb, thread.id, {
    reviewId: dispatchedAt,
    outcome: "unavailable",
    summary: "The review could not be sent to the agent.",
    incident: {
      kind: "send-failed",
      detail: error instanceof Error ? error.message : String(error),
    },
  });
  await recordFire(ctx, thread.projectId, thread.id, "stood-down", "send-failed", extra);
  await removeDeferral(bb, thread.id);
  return { kind: "done" };
}

async function sendReview(
  ctx: ReviewContext,
  thread: GateThreadLike,
  prompt: string,
  extra: FireExtra,
  reviewSkillRequired: boolean,
  state: ThreadState,
): Promise<DispatchOutcome> {
  const { bb } = ctx;
  const dispatchedAt = Date.now();
  const cursor = await codeReviewCursor(bb, thread.id);
  const skillLatch: { set: Partial<ThreadState>; remove: string[] } = reviewSkillRequired
    ? { set: { reviewSkillRequired: true }, remove: [] }
    : { set: {}, remove: ["reviewSkillRequired"] };
  await writeState(
    bb,
    thread.id,
    { phase: "awaiting-review", dispatchedAt, ...cursor, ...skillLatch.set },
    ["pendingEntryId", "deferredSince", "heldBy", ...skillLatch.remove],
  );
  await addReview(bb, { threadId: thread.id, providerId: thread.providerId });
  let result: Awaited<ReturnType<typeof bb.sdk.threads.send>>;
  try {
    const args: Parameters<typeof bb.sdk.threads.send>[0] & { experimental_requireIdleUserQueue: true } = {
      threadId: thread.id,
      mode: "start",
      experimental_requireIdleUserQueue: true,
      input: [{ type: "text", text: prompt, mentions: [] }],
    };
    result = await bb.sdk.threads.send(args);
  } catch (error) {
    return handleSendError(ctx, { thread, state, extra, dispatchedAt, error });
  }
  await removeDeferral(bb, thread.id);
  await writeState(bb, thread.id, {}, ["dispatchWaitSince"]);
  if (result.delivery === "queued") {
    await writeState(bb, thread.id, {
      phase: "pending-dispatch",
      pendingEntryId: result.queuedMessage.id,
    });
  } else {
    await writeState(bb, thread.id, await deliveredPatch(bb, thread.id));
  }
  await recordFire(ctx, thread.projectId, thread.id, "fired", "fired", extra);
  return { kind: "done" };
}

async function prepareReviewPrompt(
  ctx: ReviewContext,
  input: DispatchInput,
  workspace: AvailableWorkspace | null,
  changeSize: Awaited<ReturnType<typeof reviewSize>>,
): Promise<{ prompt: string; reviewSkillRequired: boolean }> {
  const { thread, state, environmentId, config, decision, scope, turn } = input;
  const prior = openFindingsForPrompt(await readFindings(ctx.bb, thread.id), Date.now());
  const rendered = renderScope(scope);
  const reviewSkillRequired =
    config.reviewMode === "devkit" ||
    (config.reviewMode === "auto" && (await devkitRunning(ctx.bb)) === "running");
  const prompt = buildReviewPrompt({
    decision,
    reviewMode: config.reviewMode,
    scope: rendered,
    codeBaseline: await codeBaselineFor(ctx.bb, thread.id, environmentId, rendered, workspace),
    changeSize,
    committedSince: committedSinceHead(turn, state),
    commitScanFrom: commitScanHead(turn, state),
    foreignCommits: turn.foreignCommits.map(({ sha }) => sha),
    upstreamCommits: turn.upstreamCommits,
    parkedCommits: turn.parkedCommits,
    ownCommits: turn.commits,
    aislopScan: await aislopScanAvailable(ctx.bb),
    priorFindings: prior.findings,
    priorFindingsOmitted: prior.omitted,
  });
  return { prompt, reviewSkillRequired };
}

export async function dispatchReview(
  ctx: ReviewContext,
  input: DispatchInput,
): Promise<DispatchOutcome> {
  const { thread, state, environmentId, decision, base, isWorktree, scope, turn, unclaimedCount } = input;
  const extra: FireExtra = {
    commit: decision.commit,
    merge: decision.merge,
    base,
    isWorktree,
    scopePaths: scope,
    ...(unclaimedCount === undefined ? {} : { unclaimedCount }),
  };
  // Sizing and its workspace read stay out of the provider lock, so neither
  // serialises other dispatches; the same workspace feeds the baseline.
  const workspace = await fetchWorkspace(ctx.bb, environmentId).catch(() => null);
  const changeSize = await reviewSize(ctx.bb, thread.id, scope, workspace, state.lastCodeReviewSeq ?? 0);
  const deferred = await withProviderLock(thread.providerId, async () => {
    if (await providerReviewInFlight(ctx, thread.providerId, thread.id)) {
      await deferTurn(ctx, thread, state, environmentId, {
        reason: "sibling-active",
        extra,
      });
      return { kind: "provider-deferred" as const };
    }

    const { prompt, reviewSkillRequired } = await prepareReviewPrompt(ctx, input, workspace, changeSize);
    // A re-park records no parked fields: it reviewed nothing, and the next evaluation decides again.
    const { busy, userQueued } = await userTurnQueued(ctx, thread.id);
    if (userQueued || (busy && await userTurnRunning(ctx, thread.id, lastIdleFloor(state)))) {
      return { kind: "carry" as const, busy };
    }
    if (busy) {
      return { kind: "wait" as const };
    }
    return sendReview(ctx, thread, prompt, { ...extra, ...parkedFire(turn) }, reviewSkillRequired, state);
  });
  // Hashing the tree stays out of the provider lock so it does not serialise other dispatches. It is read afresh, after the snapshot's start time, for `withoutParked`.
  if (deferred.kind === "provider-deferred") {
    await refreshIdleSnapshot(ctx.bb, thread, state);
    return { kind: "done" };
  }
  if (deferred.kind === "wait") {
    await deferTurn(ctx, thread, state, environmentId, {
      reason: "dispatch-not-ready",
      extra,
      dispatchWaitSince: state.dispatchWaitSince ?? Date.now(),
    });
    await refreshIdleSnapshot(ctx.bb, thread, state);
  }
  return deferred;
}
