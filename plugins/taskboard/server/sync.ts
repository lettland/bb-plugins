import { sourceName, type WorkSource, type WorkSourceStatus } from '../contract.js';
import type { WorkSourceAdapter } from '../sources/types.js';
import { adapters, assertSelectedSource, statuses } from './adapters.js';
import type { TaskboardContext } from './context.js';
import { projectConfig } from './projects.js';
import { currentRevision, syncKey } from './revisions.js';
import { errorMessage, scopedItem } from './util.js';

async function syncOne(
  tc: TaskboardContext,
  projectId: string,
  source: WorkSource,
  currentAdapters: Map<WorkSource, WorkSourceAdapter>,
  revision: number,
  forceRefresh: boolean
): Promise<void> {
  const adapter = currentAdapters.get(source);
  if (!adapter) throw new Error(`Missing ${source} adapter`);
  if (!adapter.configured()) {
    if (currentRevision(tc, projectId, source) === revision) {
      tc.store.setSourceError(
        projectId,
        source,
        adapter.configurationMessage() ??
          `${sourceName(source)} is not configured`
      );
    }
    return;
  }
  try {
    const items = (await adapter.list({ refresh: forceRefresh })).map(item =>
      scopedItem(projectId, item)
    );
    if (currentRevision(tc, projectId, source) !== revision) return;
    tc.store.replaceSource(projectId, source, items, new Date().toISOString());
  } catch (error) {
    const message = errorMessage(error);
    if (currentRevision(tc, projectId, source) !== revision) return;
    tc.store.setSourceError(projectId, source, message);
    tc.bb.log.warn(
      `${sourceName(source)} sync failed for ${projectId}: ${message}`
    );
  }
}

function syncSource(
  tc: TaskboardContext,
  projectId: string,
  source: WorkSource,
  currentAdapters: Map<WorkSource, WorkSourceAdapter>,
  revision: number,
  forceRefresh: boolean
): Promise<void> {
  const key = syncKey(projectId, source);
  if (currentRevision(tc, projectId, source) !== revision) {
    return Promise.resolve();
  }
  const active = tc.activeSyncs.get(key);
  if (
    active?.revision === revision &&
    (active.forceRefresh || !forceRefresh)
  ) {
    return active.promise;
  }
  const run = () =>
    syncOne(tc, projectId, source, currentAdapters, revision, forceRefresh);
  const pending =
    active?.revision === revision
      ? active.promise.then(() => {
          if (currentRevision(tc, projectId, source) !== revision) return;
          return run();
        })
      : run();
  const promise = pending.finally(() => {
    if (tc.activeSyncs.get(key)?.promise === promise) {
      tc.activeSyncs.delete(key);
    }
  });
  tc.activeSyncs.set(key, { revision, forceRefresh, promise });
  return promise;
}

export async function syncAll(
  tc: TaskboardContext,
  projectId: string,
  source: WorkSource | undefined,
  forceRefresh: boolean
): Promise<WorkSourceStatus[]> {
  let selected: WorkSource;
  let revision: number;
  let currentAdapters: Map<WorkSource, WorkSourceAdapter>;
  for (;;) {
    const config = projectConfig(tc, projectId, true);
    if (source) assertSelectedSource(tc, projectId, source, config);
    selected = config.source;
    revision = currentRevision(tc, projectId, selected);
    currentAdapters = await adapters(tc, projectId, true);
    if (currentAdapters.has(selected)) break;
    if (source) assertSelectedSource(tc, projectId, source);
  }
  await syncSource(
    tc,
    projectId,
    selected,
    currentAdapters,
    revision,
    forceRefresh
  );
  const nextStatuses = await statuses(tc, projectId);
  tc.bb.realtime.publish('taskboard:changed', {
    projectId,
    source: source ?? null
  });
  return nextStatuses;
}

export function scheduleSources(
  tc: TaskboardContext,
  projectId: string,
  sources: readonly WorkSource[]
): void {
  void Promise.all(
    sources.map(source => syncAll(tc, projectId, source, false))
  ).catch((error: unknown) => {
    tc.bb.log.warn(
      `Taskboard sync failed for ${projectId}: ${errorMessage(error)}`
    );
  });
}
