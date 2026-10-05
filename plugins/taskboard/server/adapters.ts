import type { WorkSource, WorkSourceStatus } from '../contract.js';
import { sourceName } from '../contract.js';
import { createGithubAdapter } from '../sources/github.js';
import { createJiraAdapter } from '../sources/jira.js';
import { createLinearAdapter } from '../sources/linear.js';
import type { WorkSourceAdapter } from '../sources/types.js';
import { SOURCES } from './constants.js';
import type { TaskboardContext } from './context.js';
import { waitForMutations } from './mutations.js';
import { projectConfig } from './projects.js';
import { revisionSnapshot } from './revisions.js';

export async function adapters(
  tc: TaskboardContext,
  projectId: string,
  ensureConfig = false
): Promise<Map<WorkSource, WorkSourceAdapter>> {
  for (;;) {
    await waitForMutations(tc, projectId, SOURCES);
    const before = revisionSnapshot(tc, projectId);
    const config = projectConfig(tc, projectId, ensureConfig);
    const credential =
      config.source === 'linear' || config.source === 'jira'
        ? await tc.credentials.read(projectId, config.source)
        : undefined;
    const after = revisionSnapshot(tc, projectId);
    if (!SOURCES.every(source => before[source] === after[source])) continue;
    const adapter =
      config.source === 'linear'
        ? createLinearAdapter({
            enabled: true,
            apiKey: credential,
            teamKey: config.linearTeamKey
          })
        : config.source === 'jira'
          ? createJiraAdapter({
              enabled: true,
              baseUrl: config.jiraBaseUrl,
              email: config.jiraEmail,
              apiToken: credential,
              jql: config.jiraJql
            })
          : createGithubAdapter(tc.bb, true, projectId);
    return new Map([[config.source, adapter]]);
  }
}

export async function statuses(
  tc: TaskboardContext,
  projectId: string,
  currentAdapters?: Map<WorkSource, WorkSourceAdapter>
): Promise<WorkSourceStatus[]> {
  const availableAdapters = currentAdapters ?? (await adapters(tc, projectId));
  const [entry] = availableAdapters.entries();
  if (!entry) throw new Error('Missing selected source adapter');
  const [source, adapter] = entry;
  const sync = tc.store.syncState(projectId, source);
  const configured = adapter.configured();
  return [
    {
      source,
      configured,
      available:
        configured && sync.error === null && sync.lastSyncedAt !== null,
      message: configured ? sync.error : adapter.configurationMessage(),
      lastSyncedAt: sync.lastSyncedAt,
      itemCount: sync.itemCount
    }
  ];
}

export function assertSelectedSource(
  tc: TaskboardContext,
  projectId: string,
  source: WorkSource,
  config = projectConfig(tc, projectId, false)
): void {
  if (config.source !== source) {
    throw new Error(
      `${sourceName(source)} is not the selected tracker for this BB project`
    );
  }
}

export async function assertSelectedSourceAfterMutations(
  tc: TaskboardContext,
  projectId: string,
  source: WorkSource
): Promise<void> {
  await waitForMutations(tc, projectId, SOURCES);
  assertSelectedSource(tc, projectId, source);
}

export function assertAdapterConfigured(
  adapter: WorkSourceAdapter,
  source: WorkSource
): void {
  if (!adapter.configured()) {
    throw new Error(
      adapter.configurationMessage() ??
        `${sourceName(source)} is not configured`
    );
  }
}
