import {
  sourceName,
  type ProjectSourceConfig,
  type WorkSource
} from '../contract.js';
import { SOURCES } from './constants.js';
import type { TaskboardContext } from './context.js';

export type SourceRevisionSnapshot = Record<WorkSource, number>;

export interface ExpectedProjectMutationState {
  config: ProjectSourceConfig;
  revisions: SourceRevisionSnapshot;
}

export function syncKey(projectId: string, source: WorkSource): string {
  return `${projectId}:${source}`;
}

export function currentRevision(
  tc: TaskboardContext,
  projectId: string,
  source: WorkSource
): number {
  return tc.sourceRevisions.get(syncKey(projectId, source)) ?? 0;
}

export function currentConnectorRevision(
  tc: TaskboardContext,
  projectId: string,
  source: WorkSource
): number {
  return tc.connectorRevisions.get(syncKey(projectId, source)) ?? 0;
}

export function revisionSnapshot(
  tc: TaskboardContext,
  projectId: string
): SourceRevisionSnapshot {
  return {
    linear: currentRevision(tc, projectId, 'linear'),
    github: currentRevision(tc, projectId, 'github'),
    jira: currentRevision(tc, projectId, 'jira')
  };
}

export function sameRevisions(
  tc: TaskboardContext,
  projectId: string,
  expected: SourceRevisionSnapshot
): boolean {
  return SOURCES.every(
    source => currentRevision(tc, projectId, source) === expected[source]
  );
}

export function advanceSourceRevision(
  tc: TaskboardContext,
  projectId: string,
  source: WorkSource
): number {
  const next = currentRevision(tc, projectId, source) + 1;
  tc.sourceRevisions.set(syncKey(projectId, source), next);
  return next;
}

export function invalidateSource(
  tc: TaskboardContext,
  projectId: string,
  source: WorkSource
): void {
  advanceSourceRevision(tc, projectId, source);
  tc.connectorRevisions.set(
    syncKey(projectId, source),
    currentConnectorRevision(tc, projectId, source) + 1
  );
  tc.store.clearSource(projectId, source);
}

export function assertRevisionCurrent(
  tc: TaskboardContext,
  projectId: string,
  source: WorkSource,
  revision: number,
  change: string
): void {
  if (currentRevision(tc, projectId, source) !== revision) {
    throw new Error(`${sourceName(source)} settings changed ${change}`);
  }
}
