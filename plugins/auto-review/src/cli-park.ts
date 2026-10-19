import { STALE_PARK_MS, type ThreadState } from "./state.js";

/** When a provider-parked turn was last parked: the clock the stale-park rule uses, which a lost release race refreshes, unlike `deferredSince`. */
export function lastParkedAtOf(state: ThreadState): number | null {
  return state.phase === "deferred" && state.heldBy === undefined ? (state.lastIdle?.startedAt ?? null) : null;
}

export function lastParkedLine(lastParkedAt: number | null): string {
  return lastParkedAt === null
    ? ""
    : `last parked: ${Math.floor((Date.now() - lastParkedAt) / 60_000)} min ago (stands down at ${STALE_PARK_MS / 60_000})\n`;
}
