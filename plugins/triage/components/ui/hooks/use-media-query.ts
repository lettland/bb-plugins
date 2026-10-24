import { useSyncExternalStore } from "react";

// One MediaQueryList per query, shared across every caller. This avoids adding
// a browser listener for each row, tooltip, or overlay that subscribes.
type MediaQueryRef = {
  mql: MediaQueryList;
  subscribe: (notify: () => void) => () => void;
};

const mediaQueryCache = new Map<string, MediaQueryRef>();

function createMediaQueryRef(query: string): MediaQueryRef | null {
  // v8 ignore if -- @preserve createMediaQueryRef only runs from client subscriptions (use-media-query.ts:52 the subscribe path), where window always exists.
  if (typeof window === "undefined") return null;

  let ref = mediaQueryCache.get(query);
  if (ref) return ref;

  const mql = window.matchMedia(query);
  const listeners = new Set<() => void>();
  const onChange = () => {
    for (const listener of listeners) listener();
  };

  ref = {
    mql,
    subscribe(notify) {
      const wasEmpty = listeners.size === 0;
      listeners.add(notify);
      if (wasEmpty) {
        mql.addEventListener("change", onChange);
      }
      return () => {
        listeners.delete(notify);
        if (listeners.size === 0) {
          mql.removeEventListener("change", onChange);
          mediaQueryCache.delete(query);
        }
      };
    },
  };
  mediaQueryCache.set(query, ref);
  return ref;
}

function subscribeMediaQuery(
  query: string,
  notify: () => void,
): () => void {
  return (
    // v8 ignore start -- @preserve subscribe never runs during server rendering (use-media-query.ts:52 createMediaQueryRef(query)?.subscribe(notify), called only from useMediaQuery's useSyncExternalStore at use-media-query.ts:67), so the no-ref fallback is unreachable; the whole chain shares one v8 block, so the pair must cover it (ternary-style exception).
    createMediaQueryRef(query)?.subscribe(notify) ?? (() => {})
    // v8 ignore stop
  );
}

function getMediaQuerySnapshot(query: string): boolean {
  // v8 ignore if -- @preserve the client snapshot only runs in the browser via useSyncExternalStore (use-media-query.ts:67), where window always exists.
  if (typeof window === "undefined") return false;

  return (
    mediaQueryCache.get(query)?.mql.matches ?? window.matchMedia(query).matches
  );
}

export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (notify) => subscribeMediaQuery(query, notify),
    () => getMediaQuerySnapshot(query),
    () => false,
  );
}
