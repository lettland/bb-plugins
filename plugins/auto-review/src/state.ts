import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { createKeyedLock } from "./keyed-lock.js";

export const AUTO_REVIEW_PHASES = [
  "idle",
  "deferred",
  "pending-dispatch",
  "awaiting-review",
] as const;
export type AutoReviewPhase = (typeof AUTO_REVIEW_PHASES)[number];

/** Phases where a review turn is already queued or in flight for a thread. */
export const REVIEW_IN_FLIGHT_PHASES: readonly AutoReviewPhase[] = [
  "pending-dispatch",
  "awaiting-review",
];

export const STALE_WINDOW_MS = 30 * 60 * 1_000;

/**
 * How long a released provider park may have waited, measured from its last
 * park snapshot, before the review is dropped as `stale-park`. Separate from
 * `STALE_WINDOW_MS` on purpose: that one bounds a review already dispatched,
 * this one bounds a turn still waiting for its turn in the queue.
 */
export const STALE_PARK_MS = 30 * 60 * 1_000;

/** How long a review waiting on its children or their wake-ups may hold the latch before it ends anyway. */
export const REVIEW_CONTINUATION_CAP_MS = 2 * 60 * 60 * 1_000;

/**
 * The working tree as the turn found it: a fingerprint per uncommitted path and
 * the commits already ahead of the base. Diffed against the tree at idle, it
 * catches edits no timeline row records — shell redirects, `sed -i`, scripts,
 * generators, `git mv`, commits made from the shell.
 */
export const treeSnapshotSchema = z.object({
  headSha: z.string().nullable(),
  files: z.record(z.string(), z.string()),
  commits: z.array(z.string()),
  /** Recent mainline commits, used to recognize unchanged replays after a rebase. */
  recentCommits: z.array(z.object({
    sha: z.string(),
    authorName: z.string(),
    authoredAt: z.number(),
    subject: z.string(),
  })).optional(),
});
export type TreeSnapshot = z.infer<typeof treeSnapshotSchema>;

export const turnStartSchema = z.object({
  sinceSeq: z.number().int().nonnegative(),
  /** Wall-clock start, bounding which sibling edits count as concurrent. */
  startedAt: z.number().optional(),
  /** Absent when the tree could not be read at turn start; the timeline alone then decides. */
  tree: treeSnapshotSchema.optional(),
});
export type TurnStart = z.infer<typeof turnStartSchema>;

export const threadStateSchema = z.object({
  phase: z.enum(AUTO_REVIEW_PHASES).default("idle"),
  turnStart: turnStartSchema.optional(),
  pendingEntryId: z.string().optional(),
  dispatchedAt: z.number().optional(),
  deferredSince: z.number().optional(),
  /** Spawned children holding this turn parked; absent means a provider review instead. */
  heldBy: z.array(z.string()).optional(),
  /**
   * Set once an idle has decided the turn `turnStart` opened. Until then the
   * next `thread.active` keeps the cursor instead of starting a new window, so
   * a turn whose idle is handled after the next turn's start — or whose review
   * was folded into the user's queued next turn — is still covered.
   */
  turnDecided: z.literal(true).optional(),
  /**
   * The cursor, time and tree at the last idle that kept the turn cursor
   * without firing a review. A later idle that changed nothing since it stands
   * down instead of reviewing the carried work.
   */
  lastIdle: turnStartSchema.optional(),
  /**
   * When the review prompt actually reached the agent (immediate delivery, the
   * queued row's dispatch, or the idle-time promotion of a dispatched row). It
   * is the review's id: a `ReportReview` call is accepted only against it, and
   * the findings store keys a review's report by it. A latch key, so every
   * reset clears it together with the phase it belongs to.
   */
  reviewDeliveredAt: z.number().optional(),
  /** The timeline cursor at that moment; a stop after it ended the review. */
  reviewDeliveredSeq: z.number().int().nonnegative().optional(),
  /**
   * The cursor of the first turn the user ran while the review's children
   * worked; the follow-up review of the user's own work starts there.
   */
  userTurnStart: turnStartSchema.optional(),
  /** A user turn during the hold changed files. Once set, it stays set until the hold ends. */
  userTurnAuthored: z.literal(true).optional(),
  /**
   * The timeline cursor at the idle of the latest user turn during the hold. A
   * stop at or before it happened inside that turn, stopped only that turn's
   * work, and does not end the review.
   */
  userStopFloorSeq: z.number().int().nonnegative().optional(),
  /**
   * The `turn/completed` seq of the latest turn a hold idle classified. A hold
   * idle classifies every turn that completed after it, oldest first, so when
   * core drained several turns before an idle was handled each is still read,
   * and an idle with none left is a surplus one.
   */
  handledTurnEndSeq: z.number().int().nonnegative().optional(),
  /**
   * The `turn/completed` seq of the review's own turn, recognized by the
   * code-review opening its request carried. Set once by `noteUserTurn`, from
   * the first turn it read that mark on, and never moved, it marks the turn
   * whose plan approvals are judged against the review's delivery: one the
   * review turn requested after the review was delivered never counts as the
   * user's, whatever the review reports later, and one requested anywhere else
   * in the hold — a turn before or after the review's, or in the review turn
   * before the delivery — counts. A latch key, so every reset clears it
   * together with the phase it belongs to and it never leaks into the next
   * review's hold.
   */
  reviewTurnEndSeq: z.number().int().nonnegative().optional(),
  /**
   * The timeline cursor when the last code review was sent. No further code
   * review fires until the user sends a turn of their own after it. Durable:
   * not a latch key, so an idle reset keeps it; only `bb auto-review reset` clears it.
   */
  lastCodeReviewSeq: z.number().int().nonnegative().optional(),
  /**
   * Latched at dispatch time with whether the code-review prompt required
   * devkit's `review-code` (devkit mode, or auto mode with devkit running).
   * `ReportReview` reads it at report time and never recomputes it there: the
   * devkit plugin may come and go between the send and the report. A latch
   * key, so every reset clears it together with the phase it belongs to.
   */
  reviewSkillRequired: z.literal(true).optional(),
  /**
   * Set when a plan's first presentation was held back for review; the next
   * presentation (the reviewed plan) is released to the user and clears it.
   * Deliberately not a latch key: an idle reset must not re-arm plan review
   * in the middle of the review turn.
   */
  planReviewArmedAt: z.number().optional(),
  /** The queued plan-review turn, until core dispatches it. */
  planReviewEntryId: z.string().optional(),
  /**
   * Set right after a plan deny settles, with the timeline cursor at that
   * moment. A `user_question` the agent raises as its immediate reaction to
   * the deny reads as "what should change" — even with the deny carrying
   * auto-review's own hold text, the agent may not wait for the steered
   * review — so this one-shot answers it instead of leaving the user to
   * explain why they rejected a plan they never saw.
   */
  planDenied: z.object({ at: z.number(), sinceSeq: z.number().int().nonnegative() }).optional(),
  /**
   * The timeline cursor at the moment the plan review actually reached the
   * agent (dispatched from the queue, or sent straight into the turn).
   * Auto-approve counts the agent's tool work after it as proof the review
   * ran.
   */
  planReviewDeliveredSeq: z.number().int().nonnegative().optional(),
  /**
   * The timeline cursor captured before the plan review was sent, which is
   * where the check that the agent loaded `review-code` starts reading.
   * `planReviewDeliveredSeq` deliberately lands late and would hide a load the
   * review's own prompt triggered.
   */
  planReviewArmedSeq: z.number().int().nonnegative().optional(),
  /** Set once the plan was sent back for a full review after `review-code` was never loaded; a second miss releases it. */
  planReviewRedone: z.literal(true).optional(),
  /**
   * The plan review's size tier, computed by `lightPlan` from the plan's text
   * when the gate armed (and recomputed by a redo from its own plan). Release
   * and hold expiry read it for the round tally and never recompute it from
   * the re-presented plan: review fixes routinely shrink a plan across the
   * 40-line boundary, which would flip the reviewer budget in both directions.
   */
  planReviewLight: z.boolean().optional(),
  /** The last plan the gate left with the user, for `gatePlan`'s same-turn re-presentation check. */
  planReleased: z
    .object({ interactionId: z.string(), planHash: z.string(), releasedSeq: z.number().int().nonnegative() })
    .optional(),
  /**
   * Set when the provider-agnostic `PresentPlan` tool armed a plan review for
   * this thread; the next `PresentPlan` call on a fresh arm FOR THE SAME PATH
   * releases it and clears this key. Mirrors `planReviewArmedAt`'s
   * loop-safety: the review edits the plan, so a content key would re-block
   * the revised one. Entirely separate from the native gate's own keys below:
   * `PresentPlan` is offered only to providers whose plan approvals never
   * reach that gate (see `configure` in server.ts), so the two never cover
   * the same plan.
   */
  presentPlanArmedAt: z.number().optional(),
  /** The path armed above; a call with a different path never releases it. */
  presentPlanArmedPath: z.string().optional(),
  /** The timeline cursor when `PresentPlan` armed; auto-approve looks for review work after it. */
  presentPlanArmedSeq: z.number().int().nonnegative().optional(),
  /** `planReviewRedone` for `PresentPlan`: the one redo this arm has used. */
  presentPlanRedone: z.literal(true).optional(),
  /** `planReviewLight` for the `PresentPlan` arm: computed from the plan file at arm time, read back at release. */
  presentPlanLight: z.boolean().optional(),
  /**
   * The interaction ids of the plan approvals auto-review resolved itself
   * (auto-approved, or re-approved on an earlier approval), most recent last,
   * capped at the last 10. A hold idle reads it to set those approvals aside
   * when a turn's plan approvals are judged, so an approval the plugin gave
   * never counts as a turn of the user's — the lifecycle event that records
   * the resolution carries no resolver. Written just before the resolve, so
   * the event can never be read before the id is recorded; deliberately not a
   * latch key, since the write and the resolve it vouches for need not land
   * inside one hold.
   */
  autoResolvedPlanIds: z.array(z.string()).optional(),
});
export type ThreadState = z.infer<typeof threadStateSchema>;

export const IDLE_STATE: ThreadState = { phase: "idle" };

export const withThreadLock = createKeyedLock();

export async function readState(
  bb: BbPluginApi,
  threadId: string,
): Promise<ThreadState> {
  const raw = await bb.sdk.threads.getPluginMetadata({ threadId });
  const parsed = threadStateSchema.safeParse(raw);
  if (parsed.success) {
    return parsed.data;
  }
  if (raw !== null && typeof raw === "object" && Object.keys(raw).length > 0) {
    bb.log.warn(
      `auto-review: discarding unparseable thread state for ${threadId}; resetting the loop-guard to idle`,
    );
  }
  return { ...IDLE_STATE };
}

type MetadataSet = NonNullable<
  Parameters<BbPluginApi["sdk"]["threads"]["updatePluginMetadata"]>[0]["set"]
>;

export async function writeState(
  bb: BbPluginApi,
  threadId: string,
  set: Partial<ThreadState>,
  remove?: string[],
): Promise<void> {
  await bb.sdk.threads.updatePluginMetadata({
    threadId,
    set: set as MetadataSet,
    ...(remove === undefined ? {} : { remove }),
  });
  if (set.phase !== undefined) {
    publishThreadReview(bb, threadId);
  }
}

/** The realtime channel the thread-header badge listens on for one thread. */
export function threadReviewChannel(threadId: string): string {
  return `auto-review:thread:${threadId}`;
}

/**
 * Tells the badge to refetch. Best effort: a failed publish is logged, never
 * thrown, so no state or findings write can fail on it.
 */
export function publishThreadReview(bb: BbPluginApi, threadId: string): void {
  try {
    bb.realtime.publish(threadReviewChannel(threadId), {});
  } catch (error) {
    bb.log.warn(
      `auto-review: could not publish the review update for ${threadId}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

export const LATCH_KEYS: readonly string[] = [
  "turnStart",
  "pendingEntryId",
  "dispatchedAt",
  "deferredSince",
  "turnDecided",
  "lastIdle",
  "heldBy",
  "reviewDeliveredAt",
  "reviewDeliveredSeq",
  "userTurnStart",
  "userTurnAuthored",
  "userStopFloorSeq",
  "handledTurnEndSeq",
  "reviewTurnEndSeq",
  "reviewSkillRequired",
];

/** Native plan-gate keys, cleared together whenever that gate disarms. */
export const PLAN_GATE_KEYS: readonly string[] = [
  "planReviewArmedAt",
  "planReviewEntryId",
  "planDenied",
  "planReviewDeliveredSeq",
  "planReviewArmedSeq",
  "planReviewRedone",
  "planReviewLight",
];

/** `PresentPlan`'s own keys, cleared by `bb auto-review reset` alongside `PLAN_GATE_KEYS`. */
export const PRESENT_PLAN_KEYS: readonly string[] = [
  "presentPlanArmedAt",
  "presentPlanArmedPath",
  "presentPlanArmedSeq",
  "presentPlanRedone",
  "presentPlanLight",
];

/** How long a `user_question` can still count as the agent's reaction to a plan deny. */
export const PLAN_DENY_ANSWER_WINDOW_MS = 120_000;

export function resetToIdlePatch(): {
  set: Partial<ThreadState>;
  remove: string[];
} {
  return { set: { phase: "idle" }, remove: [...LATCH_KEYS] };
}

function elapsedBeyond(
  since: number | undefined,
  now: number,
  window: number,
): boolean {
  return since !== undefined && now - since > window;
}

/**
 * The active plan hold, whatever gate armed it: the arm timestamp and the
 * window it is up against. The native gate bounds a review still queued (or
 * one whose delivery was never seen) by the stale window and a delivered one
 * by the continuation cap; a `PresentPlan` arm always gets the cap, since its
 * review rides the first call's tool result. `planHoldExpired` and the `status`
 * arm-age line read this, so the two cannot disagree about when a hold ends.
 */
export function planHoldWindow(
  state: ThreadState,
): { armedAt: number; windowMs: number } | null {
  if (state.presentPlanArmedAt !== undefined) {
    return { armedAt: state.presentPlanArmedAt, windowMs: REVIEW_CONTINUATION_CAP_MS };
  }
  if (state.planReviewArmedAt === undefined) {
    return null;
  }
  const delivered =
    state.planReviewEntryId === undefined &&
    state.planReviewDeliveredSeq !== undefined;
  return {
    armedAt: state.planReviewArmedAt,
    windowMs: delivered ? REVIEW_CONTINUATION_CAP_MS : STALE_WINDOW_MS,
  };
}

/**
 * True once a plan review has been armed for longer than its window. A review
 * still queued that long is not going to be dispatched, and holding the
 * thread's plans behind it any longer would only keep denying them. A review
 * that was delivered legitimately runs across many turns while its reviewers
 * work, so it gets the same bound as a code review: the continuation cap. The
 * stale window also covers a delivery this plugin never saw or could not
 * record — with no delivery cursor there is nothing saying the review left.
 */
export function planHoldExpired(state: ThreadState, now: number): boolean {
  const hold = planHoldWindow(state);
  return hold !== null && elapsedBeyond(hold.armedAt, now, hold.windowMs);
}

/**
 * True only inside the short window right after a plan deny, while a
 * `user_question` the agent raises is still plausibly its reaction to that
 * deny rather than something unrelated. Written out instead of as
 * `!elapsedBeyond(...)`, which would also answer a question raised before an
 * already-stale `planDenied` is cleared, or one with a clock-skewed future `at`.
 */
export function planDenyFresh(state: ThreadState, now: number): boolean {
  const { planDenied } = state;
  return (
    planDenied !== undefined &&
    now >= planDenied.at &&
    now - planDenied.at <= PLAN_DENY_ANSWER_WINDOW_MS
  );
}

export function isStale(state: ThreadState, now: number): boolean {
  return (
    state.phase !== "idle" &&
    elapsedBeyond(state.dispatchedAt, now, STALE_WINDOW_MS)
  );
}

/**
 * True while a `PresentPlan` arm is still within its window, whatever the
 * path. The suppression caller in `evaluate` uses it path-free on purpose: an
 * arm for any plan path holds the thread. `presentPlanArmed` narrows it to the
 * armed path for the release test, so a cap change moves both.
 */
export function presentPlanHoldActive(state: ThreadState, now: number): boolean {
  return (
    state.presentPlanArmedAt !== undefined &&
    !elapsedBeyond(state.presentPlanArmedAt, now, REVIEW_CONTINUATION_CAP_MS)
  );
}

/**
 * True while a `PresentPlan` arm is still within its window AND for the exact
 * plan path this call presents — a call for a different path is a different
 * plan to review, not a release of whatever was armed before. The review is
 * delivered as the first call's tool result, so the arm is bounded by the
 * continuation cap a delivered review gets, not the stale window.
 */
export function presentPlanArmed(
  state: ThreadState,
  planFilePath: string,
  now: number,
): boolean {
  return (
    state.presentPlanArmedPath === planFilePath &&
    presentPlanHoldActive(state, now)
  );
}
