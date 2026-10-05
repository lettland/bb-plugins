import type { PreferenceStorage } from './schemas.ts';

export function safeStorageGet(
  storage: PreferenceStorage | null,
  key: string
): string | null {
  try {
    return storage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

export function safeStorageSet(
  storage: PreferenceStorage | null,
  key: string,
  value: string
): void {
  try {
    storage?.setItem(key, value);
  } catch {
    // Browser preferences are best-effort in sandboxed or quota-limited hosts.
  }
}

export function safeStorageRemove(
  storage: PreferenceStorage | null,
  key: string
): void {
  try {
    storage?.removeItem(key);
  } catch {
    // Browser preferences are best-effort in sandboxed or quota-limited hosts.
  }
}

export function resolveBrowserStorage(): PreferenceStorage | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function browserStorageSubscription(
  listener: (key: string | null) => void
): () => void {
  if (typeof window === 'undefined') return () => undefined;
  const handleStorage = (event: StorageEvent) => listener(event.key);
  window.addEventListener('storage', handleStorage);
  return () => window.removeEventListener('storage', handleStorage);
}

export const defaultBrowserStorage = resolveBrowserStorage();
