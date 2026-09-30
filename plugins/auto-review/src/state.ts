import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

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
  /**
   * Set once an idle has decided the turn `turnStart` opened. Until then the
   * next `thread.active` keeps the cursor instead of starting a new window, so
   * a turn whose idle is handled after the next turn's start — or whose review
   * was folded into the user's queued next turn — is still covered.
   */
  turnDecided: z.literal(true).optional(),
  skip: z.literal(true).optional(),
  /**
   * Set when a plan's first presentation was held back for review; the next
   * presentation (the reviewed plan) is released to the user and clears it.
   * Deliberately not a latch key: an idle reset must not re-arm plan review
   * in the middle of the review turn.
   */
  planReviewArmedAt: z.number().optional(),
  /** The queued plan-review turn, until core dispatches it. */
  planReviewEntryId: z.string().optional(),
});
export type ThreadState = z.infer<typeof threadStateSchema>;

export const IDLE_STATE: ThreadState = { phase: "idle" };

const locks = new Map<string, Promise<unknown>>();

export function withThreadLock<T>(
  threadId: string,
  run: () => Promise<T>,
): Promise<T> {
  const previous = locks.get(threadId) ?? Promise.resolve();
  const next = previous.then(run, run);
  const settled = next.then(
    () => undefined,
    () => undefined,
  );
  locks.set(threadId, settled);
  void settled.then(() => {
    if (locks.get(threadId) === settled) {
      locks.delete(threadId);
    }
  });
  return next;
}

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
}

export const LATCH_KEYS: readonly string[] = [
  "turnStart",
  "pendingEntryId",
  "dispatchedAt",
  "deferredSince",
  "turnDecided",
];

/** Plan-gate keys, cleared together whenever the gate disarms. */
export const PLAN_GATE_KEYS: readonly string[] = [
  "planReviewArmedAt",
  "planReviewEntryId",
];

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
 * True once a plan review has been armed for longer than the stale window. A
 * review still queued that long is not going to be dispatched, and holding the
 * thread's plans behind it any longer would only keep denying them.
 */
export function planHoldExpired(state: ThreadState, now: number): boolean {
  return elapsedBeyond(state.planReviewArmedAt, now, STALE_WINDOW_MS);
}

export function isStale(state: ThreadState, now: number): boolean {
  return (
    state.phase !== "idle" &&
    elapsedBeyond(state.dispatchedAt, now, STALE_WINDOW_MS)
  );
}
