/** A window sends at most this often; the server throttle is the real guard. */
export const ACTIVITY_INTERVAL_MS = 120_000;

const ACTIVITY_EVENTS = ["keydown", "pointerdown", "wheel"] as const;

export interface ActivityRoute {
  projectId: string | null;
  threadId: string | null;
}

export interface ActivityTracker {
  /** The view changed: the next activity sends at once. */
  setRoute(route: ActivityRoute): void;
  dispose(): void;
}

/**
 * Watch for real interaction on `window` (capture phase, so keystrokes in an
 * embedded terminal count) and report it through `send`, only while the
 * document is focused and visible. Sends at once when the route changed and
 * otherwise at most every two minutes.
 */
export function trackActivity(
  send: (route: ActivityRoute) => void,
  initial: ActivityRoute,
  now: () => number = Date.now,
): ActivityTracker {
  let route = initial;
  let routeKey = JSON.stringify(route);
  let sentKey: string | null = null;
  let sentAt = 0;

  const onActivity = () => {
    if (!document.hasFocus() || document.visibilityState !== "visible") return;
    const at = now();
    if (sentKey === routeKey && at - sentAt < ACTIVITY_INTERVAL_MS) return;
    sentKey = routeKey;
    sentAt = at;
    send(route);
  };

  for (const type of ACTIVITY_EVENTS) window.addEventListener(type, onActivity, { capture: true, passive: true });

  return {
    setRoute(next) {
      route = next;
      routeKey = JSON.stringify(next);
    },
    dispose() {
      for (const type of ACTIVITY_EVENTS) window.removeEventListener(type, onActivity, { capture: true });
    },
  };
}
