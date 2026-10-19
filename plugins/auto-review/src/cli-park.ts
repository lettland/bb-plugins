import { STALE_PARK_MS, type ThreadState } from "./state.js";

const STALE_PARK_MIN = STALE_PARK_MS / 60_000;

/** When a provider-parked turn was last parked: the clock the stale-park rule uses, which a lost release race refreshes, unlike `deferredSince`. Only for a park `parkBaseline` could use: with both snapshot trees. */
export function lastParkedAtOf(state: ThreadState): number | null {
  return state.phase === "deferred" &&
    state.heldBy === undefined &&
    state.lastIdle?.tree !== undefined &&
    state.turnStart?.tree !== undefined
    ? (state.lastIdle.startedAt ?? null)
    : null;
}

export function lastParkedLine(lastParkedAt: number | null): string {
  if (lastParkedAt === null) {
    return "";
  }
  const min = Math.floor((Date.now() - lastParkedAt) / 60_000);
  return min >= STALE_PARK_MIN
    ? `last parked: ${min} min ago (past ${STALE_PARK_MIN} min: may stand down when released)\n`
    : `last parked: ${min} min ago (may stand down if released ${STALE_PARK_MIN}+ min after)\n`;
}

/** What releases a turn parked behind another review, for `status`. */
export const PROVIDER_PARK_RELEASE_TEXT =
  `It fires when that review ends, but may stand down instead if ${STALE_PARK_MIN} or more minutes have passed since it was last parked or its work is already pushed.\n`;

/** The commits a parked stand-down skipped, for the `lastFire` line. */
export function skippedText(skippedCommits: readonly string[] | undefined): string {
  return skippedCommits?.length ? `, commit(s) ${skippedCommits.map((sha) => sha.slice(0, 7)).join(", ")} not reviewed` : "";
}
