import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { prepareCodeBaseline } from "./baseline-store.js";
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
import { fetchWorkspace, tryCaptureSinceSeq, type TurnScope } from "./detect.js";
import { parkedFire } from "./detect-park.js";
import { readFindings, recordUnreported } from "./findings-store.js";
import { openFindingsForPrompt } from "./findings.js";
import { refreshIdleSnapshot } from "./last-idle.js";
import { buildReviewPrompt, renderScope } from "./prompt.js";
import { withProviderLock } from "./provider-lock.js";
import { deliveredPatch } from "./review-outcome.js";
import { addReview, removeReview } from "./reviews.js";
import { resetToIdlePatch, writeState, type ThreadState } from "./state.js";

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
 * dispatch.
 */
async function codeBaselineFor(
  bb: BbPluginApi,
  threadId: string,
  environmentId: string,
  rendered: ReturnType<typeof renderScope>,
) {
  const workspace = await fetchWorkspace(bb, environmentId).catch(() => null);
  return prepareCodeBaseline(bb, {
    threadId,
    environmentId,
    paths: rendered.listed,
    workspace,
    now: Date.now(),
  });
}

async function sendReview(
  ctx: ReviewContext,
  thread: GateThreadLike,
  prompt: string,
  extra: FireExtra,
  reviewSkillRequired: boolean,
): Promise<void> {
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
  await removeDeferral(bb, thread.id);
  let result: Awaited<ReturnType<typeof bb.sdk.threads.send>>;
  try {
    result = await bb.sdk.threads.send({
      threadId: thread.id,
      mode: "auto",
      input: [{ type: "text", text: prompt, mentions: [] }],
    });
  } catch (error) {
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
    return;
  }
  if (result.delivery === "queued") {
    await writeState(bb, thread.id, {
      phase: "pending-dispatch",
      pendingEntryId: result.queuedMessage.id,
    });
  } else {
    await writeState(bb, thread.id, await deliveredPatch(bb, thread.id));
  }
  await recordFire(ctx, thread.projectId, thread.id, "fired", "fired", extra);
}

export async function dispatchReview(
  ctx: ReviewContext,
  input: DispatchInput,
): Promise<void> {
  const { thread, state, environmentId, config, decision, base, isWorktree, scope, turn, unclaimedCount } = input;
  const extra: FireExtra = {
    commit: decision.commit,
    merge: decision.merge,
    base,
    isWorktree,
    scopePaths: scope,
    ...(unclaimedCount === undefined ? {} : { unclaimedCount }),
  };
  const deferred = await withProviderLock(thread.providerId, async () => {
    if (await providerReviewInFlight(ctx, thread.providerId, thread.id)) {
      await deferTurn(ctx, thread, state, environmentId, {
        reason: "sibling-active",
        extra,
      });
      return true;
    }

    const prior = openFindingsForPrompt(await readFindings(ctx.bb, thread.id), Date.now());
    const rendered = renderScope(scope);
    // Whether this review's prompt requires devkit's `review-code` — the rule
    // `planSkillCheck` applies to plans, decided from the dispatch-time config
    // alone; absent and unknown devkit are lenient. Latched for `ReportReview`.
    const reviewSkillRequired =
      config.reviewMode === "devkit" ||
      (config.reviewMode === "auto" && (await devkitRunning(ctx.bb)) === "running");
    const prompt = buildReviewPrompt({
      decision,
      reviewMode: config.reviewMode,
      scope: rendered,
      codeBaseline: await codeBaselineFor(ctx.bb, thread.id, environmentId, rendered),
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
    // A re-park records no parked fields: it reviewed nothing, and the next evaluation decides again.
    await sendReview(ctx, thread, prompt, { ...extra, ...parkedFire(turn) }, reviewSkillRequired);
    return false;
  });
  // Hashing the tree stays out of the provider lock so it does not serialise other dispatches. It is read afresh, after the snapshot's start time, for `withoutParked`.
  if (deferred) {
    await refreshIdleSnapshot(ctx.bb, thread, state);
  }
}
