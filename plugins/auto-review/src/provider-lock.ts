
const providerLocks = new Map<string, Promise<unknown>>();

export function withProviderLock<T>(providerId: string, run: () => Promise<T>): Promise<T> {
  const previous = providerLocks.get(providerId) ?? Promise.resolve();
  const next = previous.then(run, run);
  const settled = next.then(
    () => undefined,
    () => undefined,
  );
  providerLocks.set(providerId, settled);
  void settled.then(() => {
    if (providerLocks.get(providerId) === settled) {
      providerLocks.delete(providerId);
    }
  });
  return next;
}
