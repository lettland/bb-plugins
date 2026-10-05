import type { BbPluginApi } from '@get-bb/plugin-sdk';
import { refreshOutputSchema } from './schemas.js';

interface ActiveGithubRefresh {
  mutationRevision: number;
  promise: Promise<void>;
}

const githubMutationRevisions = new WeakMap<BbPluginApi, number>();
const activeRefreshes = new WeakMap<BbPluginApi, ActiveGithubRefresh>();

export function markGithubCacheStale(bb: BbPluginApi): void {
  githubMutationRevisions.set(
    bb,
    (githubMutationRevisions.get(bb) ?? 0) + 1
  );
}

export function refreshGithubCache(bb: BbPluginApi): Promise<void> {
  const mutationRevision = githubMutationRevisions.get(bb) ?? 0;
  const active = activeRefreshes.get(bb);
  if (active && active.mutationRevision >= mutationRevision) {
    return active.promise;
  }
  const run = () =>
    bb.sdk.plugins
      .callRpc({
        pluginId: 'github',
        method: 'refresh',
        input: null,
        outputSchema: refreshOutputSchema
      })
      .then(() => undefined);
  const pending = active
    ? active.promise.then(run, run)
    : run();
  const promise = pending.finally(() => {
    if (activeRefreshes.get(bb)?.promise === promise) {
      activeRefreshes.delete(bb);
    }
  });
  activeRefreshes.set(bb, { mutationRevision, promise });
  return promise;
}
