export const SYNC_WINDOW_MS = 5 * 60_000;

/**
 * Trailing-edge debounce for `--sync-ai-activity`. The first request runs at
 * once and opens a window; any request inside it schedules one more run at the
 * window's end, which opens the next window. A run due while another is in
 * flight queues exactly one follow-up.
 */
export function createSyncScheduler(run: () => Promise<void>) {
  let windowEnd = 0;
  let trailing: ReturnType<typeof setTimeout> | null = null;
  let inFlight = false;
  let followUp = false;
  let disposed = false;

  function start(): void {
    windowEnd = Date.now() + SYNC_WINDOW_MS;
    if (inFlight) {
      followUp = true;
      return;
    }
    inFlight = true;
    void run()
      .catch(() => undefined)
      .finally(() => {
        inFlight = false;
        if (followUp && !disposed) {
          followUp = false;
          start();
        }
      });
  }

  return {
    request(): void {
      if (disposed || trailing !== null) return;
      const now = Date.now();
      if (now >= windowEnd) {
        start();
        return;
      }
      trailing = setTimeout(() => {
        trailing = null;
        start();
      }, windowEnd - now);
    },
    dispose(): void {
      disposed = true;
      if (trailing !== null) clearTimeout(trailing);
      trailing = null;
    },
  };
}
