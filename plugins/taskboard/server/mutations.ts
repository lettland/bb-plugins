import type { WorkSource } from '../contract.js';
import type { TaskboardContext } from './context.js';
import { syncKey } from './revisions.js';

export async function withConfigMutation<T>(
  tc: TaskboardContext,
  operation: () => Promise<T>
): Promise<T> {
  const state = tc.configMutations;
  for (;;) {
    const barrier = state.migrationBarrier;
    if (!barrier) {
      state.active += 1;
      break;
    }
    await barrier;
  }
  try {
    return await operation();
  } finally {
    state.active -= 1;
    if (state.active === 0) {
      for (const resolve of state.idleWaiters) resolve();
      state.idleWaiters.clear();
    }
  }
}

export async function withExclusiveMigration<T>(
  tc: TaskboardContext,
  operation: () => Promise<T>
): Promise<T> {
  const state = tc.configMutations;
  while (state.migrationBarrier) await state.migrationBarrier;
  state.migrationBarrier = new Promise<void>(resolve => {
    state.releaseMigrationBarrier = resolve;
  });
  if (state.active > 0) {
    await new Promise<void>(resolve => state.idleWaiters.add(resolve));
  }
  try {
    return await operation();
  } finally {
    const release = state.releaseMigrationBarrier;
    state.releaseMigrationBarrier = null;
    state.migrationBarrier = null;
    release?.();
  }
}

export function enqueueMutation<T>(
  tc: TaskboardContext,
  projectId: string,
  sources: readonly WorkSource[],
  operation: () => Promise<T>
): Promise<T> {
  const keys = [
    ...new Set(sources.map(source => syncKey(projectId, source)))
  ].sort();
  const previous = Promise.all(
    keys.map(key => tc.mutationTails.get(key) ?? Promise.resolve())
  );
  const result = previous.then(operation);
  const tail = result.then(
    () => undefined,
    () => undefined
  );
  for (const key of keys) tc.mutationTails.set(key, tail);
  void tail.finally(() => {
    for (const key of keys) {
      if (tc.mutationTails.get(key) === tail) tc.mutationTails.delete(key);
    }
  });
  return result;
}

export async function waitForMutations(
  tc: TaskboardContext,
  projectId: string,
  sources: readonly WorkSource[]
): Promise<void> {
  await Promise.all(
    sources.map(
      source =>
        tc.mutationTails.get(syncKey(projectId, source)) ?? Promise.resolve()
    )
  );
}
