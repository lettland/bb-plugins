/**
 * Coordination between Triage's mount points. The board, the title-bar header
 * and the sidebar list are separate React roots in the host shell, so what one
 * needs to tell another travels through module state.
 */
import { useEffect, useRef } from "react";

/**
 * A card the sidebar asked the board to show in its detail dialog. Opening the
 * board is a route change, so the board mounts a beat after the click — the
 * request waits here until it does, and goes straight through when the board is
 * already up.
 */
let pendingDetail: number | null = null;
const detailListeners = new Set<(taskNumber: number) => void>();

export function requestOpenTaskDetail(taskNumber: number): void {
  if (detailListeners.size === 0) {
    pendingDetail = taskNumber;
    return;
  }
  for (const listener of detailListeners) listener(taskNumber);
}

export function usePendingOpenTaskDetail(handler: (taskNumber: number) => void): void {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    const listener = (taskNumber: number) => ref.current(taskNumber);
    detailListeners.add(listener);
    if (pendingDetail !== null) {
      const taskNumber = pendingDetail;
      pendingDetail = null;
      listener(taskNumber);
    }
    return () => {
      detailListeners.delete(listener);
    };
  }, []);
}

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
