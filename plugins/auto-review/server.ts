import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { registerAutoReviewCli } from "./src/cli.js";
import {
  defineAutoReviewSettings,
  effectiveConfig,
  globalDefaultsFrom,
  readProjectConfig,
  writeLastFire,
  type FireReason,
  type GlobalDefaults,
  type LastFire,
} from "./src/config.js";
import { decide } from "./src/decide.js";
import {
  addDeferral,
  readDeferrals,
  removeDeferral,
  type Deferral,
} from "./src/deferrals.js";
import {
  captureSinceSeq,
  captureTree,
  computeScope,
  dirtyOrAheadPaths,
  fetchWorkspace,
  isBranchCheckout,
  mainlineBase,
  stoppedByUser,
  turnChangedPaths,
} from "./src/detect.js";
import {
  isBusyStatus,
  passesThreadGate,
  reviewInFlight,
  selfIsWorktree,
  type GateThread,
} from "./src/gate.js";
import { planApprovalOf, planGateAction, type PlanApproval } from "./src/plan.js";
import {
  buildPlanReviewPrompt,
  buildReviewPrompt,
  renderScope,
} from "./src/prompt.js";
import { addReview, readReviews, removeReview } from "./src/reviews.js";
import {
  isStale,
  PLAN_GATE_KEYS,
  planHoldExpired,
  readState,
  REVIEW_IN_FLIGHT_PHASES,
  resetToIdlePatch,
  withThreadLock,
  writeState,
  type ThreadState,
} from "./src/state.js";

interface GateThreadLike extends GateThread {
  id: string;
  projectId: string;
  providerId: string;
}

const providerLocks = new Map<string, Promise<unknown>>();

function withProviderLock<T>(providerId: string, run: () => Promise<T>): Promise<T> {
  const previous = providerLocks.get(providerId) ?? Promise.resolve();
  const next = previous.then(run, run);
  const settled = next.then(
    () => undefined,
    () => undefined,
  );
  providerLocks.set(providerId, settled);
  void settled.then(() => {
    if (providerLocks.get(providerId) === settled) {
      providerLocks.delete(providerId);
    }
  });
  return next;
}

export default async function plugin(bb: BbPluginApi) {
  const settings = defineAutoReviewSettings(bb);
  let globals: GlobalDefaults = globalDefaultsFrom(await settings.get());
  settings.onChange((next) => {
    globals = globalDefaultsFrom(next);
  });

  async function recordFire(
    projectId: string,
    threadId: string,
    outcome: LastFire["outcome"],
    reason: FireReason,
    extra: Partial<Omit<LastFire, "at" | "outcome" | "reason">> = {},
  ): Promise<void> {
    const fire: LastFire = {
      at: Date.now(),
      outcome,
      reason,
      commit: extra.commit ?? false,
      merge: extra.merge ?? false,
      base: extra.base ?? null,
      isWorktree: extra.isWorktree ?? false,
      scopePaths: extra.scopePaths ?? [],
    };
    await writeLastFire(bb, projectId, threadId, fire);
  }

  async function queuedRowExists(
    threadId: string,
    entryId: string,
  ): Promise<boolean> {
    const rows = await bb.sdk.threads.queuedMessages.list({ threadId });
    return rows.some((row) => row.id === entryId);
  }

  /**
   * Park this turn instead of dropping it. The turn-start cursor is left in
   * place, so when the blocking review ends this review still covers the work
   * this turn authored — and `thread.active` carries that cursor forward if
   * the thread takes another turn in the meantime.
   */
  async function deferTurn(
    thread: GateThreadLike,
    state: ThreadState,
    environmentId: string,
    extra: Partial<Omit<LastFire, "at" | "outcome" | "reason">> = {},
  ): Promise<void> {
    // Index first, state second. The sweep enumerates the index and prunes an
    // entry whose thread is not actually deferred, so an interruption between
    // these two writes leaves a harmless orphan the next sweep cleans up. The
    // reverse order would leave a thread parked with no index entry — invisible
    // to the sweep, which is the one stranding case the sweep exists to fix.
    await addDeferral(bb, {
      threadId: thread.id,
      projectId: thread.projectId,
      environmentId,
      providerId: thread.providerId,
    });
    await writeState(bb, thread.id, {
      phase: "deferred",
      deferredSince: state.deferredSince ?? Date.now(),
    });
    await recordFire(
      thread.projectId,
      thread.id,
      "deferred",
      "sibling-active",
      extra,
    );
  }

  /**
   * Whether a thread other than `exceptThreadId` has an auto-review queued or
   * running on this provider, in any project. Index entries whose thread no
   * longer holds a review — or no longer exists — are pruned on the way.
   */
  async function providerReviewInFlight(
    providerId: string,
    exceptThreadId: string | null,
  ): Promise<boolean> {
    const now = Date.now();
    for (const entry of await readReviews(bb)) {
      if (entry.threadId === exceptThreadId || entry.providerId !== providerId) {
        continue;
      }
      let state: ThreadState;
      let status: string;
      try {
        [state, { status }] = await Promise.all([
          readState(bb, entry.threadId),
          bb.sdk.threads.get({ threadId: entry.threadId }),
        ]);
      } catch {
        await removeReview(bb, entry.threadId);
        continue;
      }
      if (!REVIEW_IN_FLIGHT_PHASES.includes(state.phase)) {
        await removeReview(bb, entry.threadId);
        continue;
      }
      if (reviewInFlight({ state, busy: isBusyStatus(status) }, now)) {
        return true;
      }
    }
    return false;
  }

  /** The provider a parked turn waits on; entries parked before it was indexed look it up. */
  async function deferralProviderId(entry: Deferral): Promise<string | null> {
    if (entry.providerId !== undefined) {
      return entry.providerId;
    }
    try {
      return (await bb.sdk.threads.get({ threadId: entry.threadId })).providerId;
    } catch {
      return null;
    }
  }

  /**
   * Resolve a thread id to a gated thread and evaluate it under its own lock.
   * Returns whether evaluation actually ran; `onUnusable` is called when the
   * thread is gone or no longer gated, so each caller can clean up its own way.
   */
  async function resolveAndEvaluate(
    threadId: string,
    onUnusable: (why: string) => Promise<void>,
  ): Promise<boolean> {
    let candidate: Awaited<ReturnType<typeof bb.sdk.threads.get>>;
    try {
      candidate = await bb.sdk.threads.get({ threadId });
    } catch (error) {
      await onUnusable(error instanceof Error ? error.message : String(error));
      return false;
    }
    if (!passesThreadGate(candidate)) {
      await onUnusable("thread no longer passes the auto-review thread gate");
      return false;
    }
    await withThreadLock(threadId, () =>
      evaluate({ ...candidate, id: threadId, projectId: candidate.projectId }),
    );
    return true;
  }

  /**
   * End the turn without a review. A turn that had been deferred is unparked
   * here too — otherwise a deferral that later turns out to have nothing to
   * review would latch the thread in `deferred` and freeze its cursor.
   */
  async function standDown(
    thread: GateThreadLike,
    state: ThreadState,
    reason: FireReason,
    extra: Partial<Omit<LastFire, "at" | "outcome" | "reason">> = {},
  ): Promise<void> {
    if (state.phase === "deferred") {
      const { set, remove } = resetToIdlePatch();
      await writeState(bb, thread.id, set, remove);
      await removeDeferral(bb, thread.id);
    }
    await recordFire(thread.projectId, thread.id, "stood-down", reason, extra);
  }

  /**
   * Whether the user's next turn is already lined up: a message they queued
   * during this turn, or a turn already started because core drained the queue
   * before this idle was handled. Scheduled and failed rows do not count.
   */
  async function userTurnQueued(threadId: string): Promise<boolean> {
    const now = Date.now();
    const [{ status }, rows] = await Promise.all([
      bb.sdk.threads.get({ threadId }),
      bb.sdk.threads.queuedMessages.list({ threadId }),
    ]);
    return (
      isBusyStatus(status) ||
      rows.some(
        (row) =>
          row.initiator === "user" &&
          row.origin !== "plugin" &&
          row.failureReason === null &&
          (row.sendAt === null || row.sendAt <= now),
      )
    );
  }

  /**
   * Fold this turn's review into the user's next turn instead of firing it
   * alongside their message. The cursor is kept, so the review that fires once
   * the thread goes idle with nothing of theirs waiting covers every turn since.
   */
  async function carryOver(thread: GateThreadLike, state: ThreadState): Promise<void> {
    await writeState(bb, thread.id, { phase: "idle", carryTurnStart: true }, [
      "deferredSince",
    ]);
    if (state.phase === "deferred") {
      await removeDeferral(bb, thread.id);
    }
    await recordFire(thread.projectId, thread.id, "deferred", "user-queued");
  }

  async function evaluate(thread: GateThreadLike): Promise<void> {
    const state = await readState(bb, thread.id);
    // Three drivers reach this: a thread's own idle, a sibling's idle releasing
    // a deferral, and the expiry sweep. Each decides to call evaluate before
    // taking this thread's lock, so two can decide on the same parked thread
    // and only one wins the lock. Re-check under the lock: a review that is
    // already queued or in flight means the loser has nothing to do. Silent and
    // idempotent — it records no fire, because nothing was decided here.
    if (REVIEW_IN_FLIGHT_PHASES.includes(state.phase)) {
      return;
    }
    if (state.carryTurnStart === true) {
      // The idle a carried review waited for; it is decided now, and carried
      // again below if the user has queued yet another message.
      await writeState(bb, thread.id, {}, ["carryTurnStart"]);
    }
    const project = await readProjectConfig(bb, thread.projectId);
    const config = effectiveConfig(globals, project, state.skip === true);

    if (!config.enabled) {
      await standDown(thread, state, "disabled");
      return;
    }
    if (config.skipped) {
      await standDown(thread, state, "skipped");
      return;
    }
    if (state.turnStart === undefined) {
      await standDown(thread, state, "no-turn-start");
      return;
    }
    // The user stopped this turn to take over; reviewing and committing
    // half-done work behind their back is the last thing they asked for.
    if (await stoppedByUser(bb, thread.id, state.turnStart.sinceSeq)) {
      await standDown(thread, state, "user-stopped");
      return;
    }
    if (await userTurnQueued(thread.id)) {
      await carryOver(thread, state);
      return;
    }
    const environmentId = thread.environmentId;
    if (environmentId === null) {
      return;
    }

    const workspace = await fetchWorkspace(bb, environmentId);
    if (workspace === null) {
      await standDown(thread, state, "status-unavailable");
      return;
    }
    if (!isBranchCheckout(workspace)) {
      await standDown(thread, state, "not-a-branch");
      return;
    }

    // Only another thread's review in flight parks this turn — two reviews
    // staging, committing and merging in one working tree at once is the one
    // thing to avoid. Threads that are merely running, including this thread's
    // own advisor or subagents, never do.
    if (await providerReviewInFlight(thread.providerId, thread.id)) {
      await deferTurn(thread, state, environmentId);
      return;
    }
    const threadEntries = await bb.sdk.threads.list({
      environmentId,
      includeHidden: true,
    });
    const isWorktree = selfIsWorktree(threadEntries, thread.id);

    const turn = await turnChangedPaths(bb, {
      threadId: thread.id,
      environmentId,
      turnStart: state.turnStart,
      workspace,
      threadEntries,
    });
    if (turn.paths.length === 0) {
      await standDown(thread, state, "no-authorship");
      return;
    }
    const scope = computeScope(
      turn.paths,
      dirtyOrAheadPaths(workspace, turn.committedPaths),
    );
    if (scope.length === 0) {
      await standDown(thread, state, "empty-scope");
      return;
    }

    const base = mainlineBase(workspace);
    const decision = decide({
      base,
      currentBranch: workspace.branch.currentBranch,
      isDedicatedWorktree: isWorktree,
      mergeEligibleMainlines: config.mergeEligibleMainlines,
    });

    await withProviderLock(thread.providerId, async () => {
      if (await providerReviewInFlight(thread.providerId, thread.id)) {
        await deferTurn(thread, state, environmentId, {
          commit: decision.commit,
          merge: decision.merge,
          base,
          isWorktree,
          scopePaths: scope,
        });
        return;
      }

      const prompt = buildReviewPrompt({
        decision,
        reviewMode: config.reviewMode,
        scope: renderScope(scope),
        committedSince:
          turn.commits.length > 0 ? (state.turnStart?.tree?.headSha ?? null) : null,
      });
      await writeState(
        bb,
        thread.id,
        { phase: "awaiting-review", dispatchedAt: Date.now() },
        ["pendingEntryId", "deferredSince"],
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
        await writeState(bb, thread.id, set, remove);
        await removeReview(bb, thread.id);
        await recordFire(thread.projectId, thread.id, "stood-down", "send-failed", {
          commit: decision.commit,
          merge: decision.merge,
          base,
          isWorktree,
          scopePaths: scope,
        });
        return;
      }
      if (result.delivery === "queued") {
        await writeState(bb, thread.id, {
          phase: "pending-dispatch",
          pendingEntryId: result.queuedMessage.id,
        });
      }
      await recordFire(thread.projectId, thread.id, "fired", "fired", {
        commit: decision.commit,
        merge: decision.merge,
        base,
        isWorktree,
        scopePaths: scope,
      });
    });
  }

  /**
   * A review on this provider may just have ended, so let one turn parked on
   * the provider through — from any project. One review per call: the released
   * turn latches its own review immediately, and that review's end drives the
   * next release. A parked turn that turns out to start no review (nothing left
   * to review, or unusable) does not end the call, or the turns behind it would
   * wait for the sweep.
   */
  async function releaseDeferred(providerId: string): Promise<void> {
    if (await providerReviewInFlight(providerId, null)) {
      return;
    }
    for (const entry of await readDeferrals(bb)) {
      if ((await deferralProviderId(entry)) !== providerId) {
        continue;
      }
      if ((await readState(bb, entry.threadId)).phase !== "deferred") {
        await removeDeferral(bb, entry.threadId);
        continue;
      }
      await resolveAndEvaluate(entry.threadId, async (why) => {
        bb.log.warn(
          `auto-review: could not release deferred thread ${entry.threadId}: ${why}`,
        );
      });
      if (await providerReviewInFlight(providerId, null)) {
        return;
      }
    }
  }

  async function handleIdle(thread: GateThreadLike): Promise<void> {
    const state = await readState(bb, thread.id);
    if (state.phase === "awaiting-review") {
      const { set, remove } = resetToIdlePatch();
      await writeState(bb, thread.id, set, remove);
      await removeReview(bb, thread.id);
      return;
    }
    if (state.phase === "pending-dispatch") {
      if (isStale(state, Date.now())) {
        if (
          state.pendingEntryId !== undefined &&
          (await queuedRowExists(thread.id, state.pendingEntryId))
        ) {
          await writeState(bb, thread.id, { dispatchedAt: Date.now() });
          return;
        }
        await writeState(bb, thread.id, { phase: "awaiting-review" }, [
          "pendingEntryId",
        ]);
      }
      return;
    }
    await evaluate(thread);
  }

  /**
   * Hold a plan's first presentation for review. The review turn is queued
   * BEFORE the approval is denied: a thread awaiting an interaction cannot take
   * a prompt, so the turn waits on the approval and core steers it in the
   * moment the deny settles — the agent reads the reason alongside the deny
   * instead of guessing why its plan was "rejected".
   */
  async function gatePlan(
    thread: GateThreadLike,
    approval: PlanApproval,
  ): Promise<void> {
    const state = await readState(bb, thread.id);
    const project = await readProjectConfig(bb, thread.projectId);
    const config = effectiveConfig(globals, project, state.skip === true);
    if (!config.enabled || config.skipped) {
      return;
    }

    const action = planGateAction(state, approval.plan);
    if (action === "commit-plan") {
      await recordFire(thread.projectId, thread.id, "stood-down", "commit-plan");
      return;
    }
    if (action === "release") {
      await writeState(bb, thread.id, {}, [...PLAN_GATE_KEYS]);
      await recordFire(thread.projectId, thread.id, "stood-down", "plan-reviewed");
      return;
    }
    if (action === "hold") {
      await holdOrReleasePlan(thread, state, approval);
      return;
    }

    await writeState(bb, thread.id, { planReviewArmedAt: Date.now() });
    let queuedMessageId: string | null = null;
    try {
      const result = await bb.sdk.threads.send({
        threadId: thread.id,
        mode: "auto",
        input: [
          {
            type: "text",
            text: buildPlanReviewPrompt({
              reviewMode: config.reviewMode,
              planFilePath: approval.planFilePath,
            }),
            mentions: [],
          },
        ],
      });
      if (result.delivery === "queued") {
        queuedMessageId = result.queuedMessage.id;
        await writeState(bb, thread.id, { planReviewEntryId: queuedMessageId });
      }
    } catch (error) {
      // Nothing was queued, so leave the plan with the user untouched.
      bb.log.warn(
        `auto-review: failed to queue the plan review for ${thread.id}; leaving the plan for the user: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      await writeState(bb, thread.id, {}, [...PLAN_GATE_KEYS]);
      await recordFire(thread.projectId, thread.id, "stood-down", "send-failed");
      return;
    }
    if (await denyPlan(thread, approval, queuedMessageId)) {
      await recordFire(thread.projectId, thread.id, "fired", "plan-review");
    }
  }

  /**
   * A plan re-presented while its review is recorded as queued. Hold it only
   * while the review really is still in the queue and has not been there past
   * the stale window: the recorded id is cleared only by `message.dispatched`
   * or `message.cancelled`, so trusting it alone would turn one missed event
   * into a bare deny of every plan the thread presents from then on.
   */
  async function holdOrReleasePlan(
    thread: GateThreadLike,
    state: ThreadState,
    approval: PlanApproval,
  ): Promise<void> {
    const entryId = state.planReviewEntryId ?? null;
    const queued =
      entryId !== null && (await queuedRowExists(thread.id, entryId));
    const expired = planHoldExpired(state, Date.now());
    if (queued && !expired) {
      // The review is still queued behind this approval; denying lets it in.
      await denyPlan(thread, approval, entryId);
      return;
    }
    if (queued && entryId !== null) {
      // Withdraw it, or it would land in the middle of implementing the plan
      // this release hands to the user.
      await withdrawQueuedReview(thread.id, entryId);
    }
    // Not queued any more means the review was dispatched and this is the
    // reviewed plan, whose dispatch event never reached us.
    await writeState(bb, thread.id, {}, [...PLAN_GATE_KEYS]);
    await recordFire(
      thread.projectId,
      thread.id,
      "stood-down",
      queued ? "plan-hold-expired" : "plan-reviewed",
    );
  }

  async function withdrawQueuedReview(
    threadId: string,
    queuedMessageId: string,
  ): Promise<void> {
    await bb.sdk.threads.queuedMessages
      .delete({ threadId, queuedMessageId })
      .catch((deleteError: unknown) => {
        bb.log.warn(
          `auto-review: could not withdraw the queued plan review ${queuedMessageId} in ${threadId}: ${
            deleteError instanceof Error ? deleteError.message : String(deleteError)
          }`,
        );
      });
  }

  /**
   * Deny a held plan. If the deny fails the plan is still with the user (or
   * they already answered it), so pull the queued review back out — otherwise
   * it would land after an approval and send the agent back to planning in the
   * middle of implementing — and disarm. A review that was delivered straight
   * into the turn (no queued row) cannot be withdrawn; that is only logged.
   */
  async function denyPlan(
    thread: GateThreadLike,
    approval: PlanApproval,
    queuedMessageId: string | null,
  ): Promise<boolean> {
    try {
      await bb.sdk.threads.interactions.resolve({
        threadId: thread.id,
        interactionId: approval.interactionId,
        resolution: { decision: "deny" },
      });
      return true;
    } catch (error) {
      bb.log.warn(
        `auto-review: could not hold the plan for review in ${thread.id}; leaving it for the user: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      if (queuedMessageId !== null) {
        await withdrawQueuedReview(thread.id, queuedMessageId);
      }
      await writeState(bb, thread.id, {}, [...PLAN_GATE_KEYS]);
      await recordFire(thread.projectId, thread.id, "stood-down", "send-failed");
      return false;
    }
  }

  bb.events.on("interaction.pending", async ({ thread, interaction }) => {
    const approval = planApprovalOf(interaction);
    if (approval === null || !passesThreadGate(thread)) {
      return;
    }
    await withThreadLock(thread.id, () => gatePlan(thread, approval));
  });

  bb.events.on("thread.active", async ({ thread }) => {
    if (!passesThreadGate(thread)) {
      return;
    }
    await withThreadLock(thread.id, async () => {
      const state = await readState(bb, thread.id);
      if (
        (state.phase === "deferred" || state.carryTurnStart === true) &&
        state.turnStart !== undefined
      ) {
        // A deferred or carried turn is still owed a review. Keep its (earlier)
        // cursor so the eventual review covers that turn's work as well as this
        // one's, instead of starting the authorship window over and losing it.
        return;
      }
      const startedAt = Date.now();
      // The tree as this turn found it, so edits no timeline row records
      // (shell commands, scripts, commits) are still attributed at idle.
      // Taken alongside the cursor: the agent is already running, and an edit
      // that lands before the snapshot would be absorbed into it.
      const [sinceSeq, tree] = await Promise.all([
        captureSinceSeq(bb, thread.id),
        thread.environmentId === null
          ? Promise.resolve(undefined)
          : captureTree(bb, thread.environmentId),
      ]);
      await writeState(bb, thread.id, {
        turnStart: { sinceSeq, startedAt, ...(tree === undefined ? {} : { tree }) },
      });
    });
  });

  bb.events.on("thread.idle", async ({ thread }) => {
    if (!passesThreadGate(thread)) {
      return;
    }
    await withThreadLock(thread.id, () => handleIdle(thread));
    // Outside the thread lock, and outside evaluate's provider lock, so
    // releasing another turn cannot deadlock against the work we just did.
    await releaseDeferred(thread.providerId);
  });

  bb.events.on("message.dispatched", async ({ entry }) => {
    await withThreadLock(entry.threadId, async () => {
      const state = await readState(bb, entry.threadId);
      if (state.planReviewEntryId === entry.id) {
        // The review is in the agent's hands; its next presentation is the
        // reviewed plan.
        await writeState(bb, entry.threadId, {}, ["planReviewEntryId"]);
        return;
      }
      if (
        state.phase === "pending-dispatch" &&
        state.pendingEntryId === entry.id
      ) {
        await writeState(bb, entry.threadId, { phase: "awaiting-review" }, [
          "pendingEntryId",
        ]);
      }
    });
  });

  bb.events.on("message.cancelled", async ({ entry }) => {
    const cancelledReview = await withThreadLock(entry.threadId, async () => {
      const state = await readState(bb, entry.threadId);
      if (state.planReviewEntryId === entry.id) {
        // The review never ran, so the next plan still owes one.
        await writeState(bb, entry.threadId, {}, [...PLAN_GATE_KEYS]);
        return false;
      }
      if (
        state.phase === "pending-dispatch" &&
        state.pendingEntryId === entry.id
      ) {
        const { set, remove } = resetToIdlePatch();
        await writeState(bb, entry.threadId, set, remove);
        await removeReview(bb, entry.threadId);
        return true;
      }
      return false;
    });
    if (cancelledReview) {
      const { providerId } = await bb.sdk.threads.get({ threadId: entry.threadId });
      await releaseDeferred(providerId);
    }
  });

  const unlatch = (threadId: string) =>
    withThreadLock(threadId, async () => {
      const state = await readState(bb, threadId);
      if (state.phase !== "idle") {
        const { set, remove } = resetToIdlePatch();
        await writeState(bb, threadId, set, remove);
      }
      await removeDeferral(bb, threadId);
      await removeReview(bb, threadId);
    });

  /**
   * The backstop for a release no event delivered. The review that parked a
   * turn normally releases it from its own idle, but that idle can be missed —
   * a restart, or a blocker that was deleted or left a stale latch behind.
   * Each pass retries every parked turn whose provider no longer has a review
   * in flight.
   */
  async function sweepDeferrals(): Promise<void> {
    for (const entry of await readDeferrals(bb)) {
      const state = await readState(bb, entry.threadId);
      if (state.phase !== "deferred") {
        await removeDeferral(bb, entry.threadId);
        continue;
      }
      // Same veto `releaseDeferred` applies, and it is what keeps this loop to
      // one release per provider: `evaluate` indexes its review before it
      // sends, so a second entry on the same provider sees the first thread's
      // review in flight and waits for the next pass. A provider that cannot
      // be resolved means the thread is gone, which `resolveAndEvaluate`
      // reports as unusable.
      const providerId = await deferralProviderId(entry);
      if (
        providerId !== null &&
        (await providerReviewInFlight(providerId, entry.threadId))
      ) {
        continue;
      }
      await resolveAndEvaluate(entry.threadId, async (why) => {
        // Unpark as well as de-index. Dropping the index entry alone would
        // leave the thread latched in `deferred` and invisible to every later
        // sweep — the stranding this sweep exists to prevent.
        bb.log.warn(
          `auto-review: dropping the deferred turn for ${entry.threadId}: ${why}`,
        );
        const { set, remove } = resetToIdlePatch();
        await writeState(bb, entry.threadId, set, remove);
        await removeDeferral(bb, entry.threadId);
      });
    }
  }

  bb.background.schedule("sweep-deferrals", "*/5 * * * *", sweepDeferrals);

  // A failed, archived or deleted thread may have been the review a turn was
  // parked behind, and it will not go idle to release it.
  bb.events.on("thread.failed", async ({ thread }) => {
    await unlatch(thread.id);
    await releaseDeferred(thread.providerId);
  });
  bb.events.on("thread.archived", async ({ thread }) => {
    await unlatch(thread.id);
    await releaseDeferred(thread.providerId);
  });
  bb.events.on("thread.deleted", async ({ thread }) => {
    await unlatch(thread.id);
    await releaseDeferred(thread.providerId);
  });

  registerAutoReviewCli(bb, settings, () => globals);
}
