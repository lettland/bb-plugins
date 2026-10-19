/** A window sends at most this often; the server throttle is the real guard. */
export const ACTIVITY_INTERVAL_MS = 120_000;

/** Activity this recent before a route change belongs to the new view. */
export const NAVIGATION_GRACE_MS = 2000;

const ACTIVITY_EVENTS = ["keydown", "pointerdown", "wheel"] as const;

export interface ActivityRoute {
  projectId: string | null;
  threadId: string | null;
}

export interface ActivityTracker {
  /** The view changed: the next activity sends at once, and so does activity within the last 2 s. */
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
  let activeAt: number | null = null;

  const qualifies = () => document.hasFocus() && document.visibilityState === "visible";

  const report = (at: number) => {
    if (sentKey === routeKey && at - sentAt < ACTIVITY_INTERVAL_MS) return;
    sentKey = routeKey;
    sentAt = at;
    send(route);
  };

  const onActivity = () => {
    if (!qualifies()) return;
    activeAt = now();
    report(activeAt);
  };

  for (const type of ACTIVITY_EVENTS) window.addEventListener(type, onActivity, { capture: true, passive: true });

  return {
    setRoute(next) {
      const nextKey = JSON.stringify(next);
      const changed = nextKey !== routeKey;
      route = next;
      routeKey = nextKey;
      // A click that navigates is seen before the route changes: credit the new view.
      const at = now();
      if (changed && activeAt !== null && at - activeAt <= NAVIGATION_GRACE_MS && qualifies()) report(at);
    },
    dispose() {
      for (const type of ACTIVITY_EVENTS) window.removeEventListener(type, onActivity, { capture: true });
    },
  };
}
