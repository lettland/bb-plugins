/**
 * Coordination between Triage's mount points. The board and the thread header
 * action are separate React roots in the host shell, so what one needs to tell
 * another travels through module state.
 */

/**
 * Every mounted surface hears the same `triage` signal on its own subscription.
 * The store collapses concurrent fetches but still pays for a second round trip
 * afterwards, so the first caller for an event claims the refresh and the rest
 * skip it. An unstamped payload always claims: a spare fetch beats a stale board.
 *
 * Matched on equality rather than order, because the stamp is the server's wall
 * clock: an NTP step backwards would wedge a "newer than" test forever, and the
 * only thing lost here is a second publish landing in the same millisecond —
 * which the claiming fetch reads whole anyway.
 */
let claimedAt: number | null = null;

export function claimTriageRefresh(payload: unknown): boolean {
  const at = (payload as { at?: unknown } | null | undefined)?.at;
  if (typeof at !== "number") return true;
  if (at === claimedAt) return false;
  claimedAt = at;
  return true;
}
