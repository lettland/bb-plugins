import type { LastFire } from "./config.js";
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

/** What releases a turn parked behind another review, for `status`; the stand-down rules only when this park can use them (`canStandDown`). */
export function providerParkReleaseText(canStandDown: boolean): string {
  return canStandDown
    ? `It fires when that review ends, but may stand down instead if ${STALE_PARK_MIN} or more minutes have passed since it was last parked or its work is already pushed.\n`
    : "It fires automatically as soon as that review ends.\n";
}

/** What a parked stand-down left to act on, for the `lastFire` line: the commits it skipped, and a merge it skipped. */
export function skippedText(lastFire: LastFire): string {
  const { skippedCommits, reason, merge } = lastFire;
  return (
    (skippedCommits?.length ? `, commit(s) ${skippedCommits.map((sha) => sha.slice(0, 7)).join(", ")} not reviewed` : "") +
    (reason === "stale-park" && merge ? ", merge skipped" : "")
  );
}
