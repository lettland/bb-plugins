/** A promise-chain lock per key: runs for one key execute one at a time, in call order. */
export function createKeyedLock(): <T>(key: string, run: () => Promise<T>) => Promise<T> {
  const locks = new Map<string, Promise<unknown>>();
  return (key, run) => {
    const previous = locks.get(key) ?? Promise.resolve();
    const next = previous.then(run, run);
    const settled = next.then(
      () => undefined,
      () => undefined,
    );
    locks.set(key, settled);
    void settled.then(() => {
      if (locks.get(key) === settled) {
        locks.delete(key);
      }
    });
    return next;
  };
}
