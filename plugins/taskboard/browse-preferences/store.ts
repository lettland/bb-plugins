import {
  browsePreferencesV1Schema,
  type BrowsePreferenceScope,
  type BrowsePreferenceSeed,
  type BrowsePreferenceStore,
  type BrowsePreferenceStoreOptions,
  type BrowsePreferences
} from './schemas.ts';
import {
  browsePreferenceStorageKey,
  browsePreferencesEqual,
  browseScopeFromStorageKey,
  clearBrowseFilters,
  defaultBrowsePreferences,
  parseBrowseScope,
  parseStoredBrowsePreferences,
  reconcileBrowseProvider
} from './preferences.ts';
import { safeStorageGet, safeStorageRemove, safeStorageSet } from './storage.ts';

export interface CachedPreferences {
  preferences: BrowsePreferences;
  origin: 'default' | 'stored' | 'updated';
}

export function createBrowsePreferenceStore(
  options: BrowsePreferenceStoreOptions = {}
): BrowsePreferenceStore {
  const storage = options.storage ?? null;
  const cache = new Map<BrowsePreferenceScope, CachedPreferences>();
  const listeners = new Map<BrowsePreferenceScope, Set<() => void>>();
  let disposed = false;

  const notify = (scope: BrowsePreferenceScope) => {
    for (const listener of listeners.get(scope) ?? []) listener();
  };

  const read = (
    scope: BrowsePreferenceScope,
    seed: BrowsePreferenceSeed = {}
  ): CachedPreferences => {
    const parsedScope = parseBrowseScope(scope);
    const cached = cache.get(parsedScope);
    if (cached) return cached;
    const fallback = defaultBrowsePreferences(seed);
    const serialized = safeStorageGet(storage, browsePreferenceStorageKey(parsedScope));
    const stored = parseStoredBrowsePreferences(serialized);
    const entry: CachedPreferences = stored
      ? { preferences: stored, origin: 'stored' }
      : { preferences: fallback, origin: 'default' };
    cache.set(parsedScope, entry);
    return entry;
  };

  const set = (
    scope: BrowsePreferenceScope,
    preferences: BrowsePreferences
  ): BrowsePreferences => {
    const parsedScope = parseBrowseScope(scope);
    const next = browsePreferencesV1Schema.parse(preferences);
    const current = cache.get(parsedScope)?.preferences;
    if (current && browsePreferencesEqual(current, next)) return current;
    cache.set(parsedScope, { preferences: next, origin: 'updated' });
    safeStorageSet(
      storage,
      browsePreferenceStorageKey(parsedScope),
      JSON.stringify(next)
    );
    notify(parsedScope);
    return next;
  };

  const unsubscribeFromStorage = options.subscribeToStorage?.(key => {
    if (disposed) return;
    if (key === null) {
      const affectedScopes = new Set([
        ...cache.keys(),
        ...listeners.keys()
      ]);
      cache.clear();
      for (const scope of affectedScopes) notify(scope);
      return;
    }
    const scope = browseScopeFromStorageKey(key);
    if (!scope) return;
    cache.delete(scope);
    notify(scope);
  });

  return {
    get(scope, seed = {}) {
      return read(scope, seed).preferences;
    },
    seed(scope, seed) {
      const parsedScope = parseBrowseScope(scope);
      const current = read(parsedScope, seed);
      if (current.origin !== 'default') return current.preferences;
      const next = defaultBrowsePreferences(seed);
      if (browsePreferencesEqual(current.preferences, next)) {
        return current.preferences;
      }
      cache.set(parsedScope, { preferences: next, origin: 'default' });
      notify(parsedScope);
      return next;
    },
    set,
    update(scope, update, seed = {}) {
      return set(scope, update(read(scope, seed).preferences));
    },
    clearFilters(scope, seed = {}) {
      return set(scope, clearBrowseFilters(read(scope, seed).preferences));
    },
    reconcileProvider(scope, provider, seed = {}) {
      const current = read(scope, seed).preferences;
      const next = reconcileBrowseProvider(current, provider);
      return next === current ? current : set(scope, next);
    },
    reset(scope, seed = {}) {
      const parsedScope = parseBrowseScope(scope);
      const next = defaultBrowsePreferences(seed);
      cache.set(parsedScope, { preferences: next, origin: 'default' });
      safeStorageRemove(storage, browsePreferenceStorageKey(parsedScope));
      notify(parsedScope);
      return next;
    },
    subscribe(scope, listener) {
      const parsedScope = parseBrowseScope(scope);
      const scopedListeners = listeners.get(parsedScope) ?? new Set();
      scopedListeners.add(listener);
      listeners.set(parsedScope, scopedListeners);
      return () => {
        scopedListeners.delete(listener);
        if (scopedListeners.size === 0) listeners.delete(parsedScope);
      };
    },
    dispose() {
      disposed = true;
      unsubscribeFromStorage?.();
      listeners.clear();
      cache.clear();
    }
  };
}
