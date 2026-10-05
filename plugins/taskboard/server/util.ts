import { bbProjectIdSchema, workSourceSchema } from '../contract.js';
import type {
  WorkItem,
  WorkItemDetail,
  WorkSource,
  WorkSourceStatus
} from '../contract.js';
import type {
  ExternalWorkItem,
  ExternalWorkItemDetail
} from '../sources/types.js';

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function scopedItem(
  projectId: string,
  item: ExternalWorkItem
): WorkItem {
  return { bbProjectId: projectId, ...item };
}

export function scopedItemDetail(
  projectId: string,
  item: ExternalWorkItemDetail
): WorkItemDetail {
  return { bbProjectId: projectId, ...item };
}

export function mentionId(item: WorkItem): string {
  return `${item.bbProjectId}:${item.source}:${item.locator}`;
}

export function parseMentionId(value: string): {
  projectId: string;
  source: WorkSource;
  locator: string;
} {
  const firstSeparator = value.indexOf(':');
  const secondSeparator = value.indexOf(':', firstSeparator + 1);
  const projectId = value.slice(0, firstSeparator);
  const source = value.slice(firstSeparator + 1, secondSeparator);
  const locator = value.slice(secondSeparator + 1);
  const parsedProjectId = bbProjectIdSchema.safeParse(projectId);
  const parsedSource = workSourceSchema.safeParse(source);
  if (
    !parsedProjectId.success ||
    !parsedSource.success ||
    !locator ||
    firstSeparator < 0 ||
    secondSeparator < 0
  ) {
    throw new Error('Invalid Taskboard mention');
  }
  return {
    projectId: parsedProjectId.data,
    source: parsedSource.data,
    locator
  };
}

export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise(resolve => {
    const timeout = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timeout);
        resolve();
      },
      { once: true }
    );
  });
}

export function refreshedItemCount(
  statuses: WorkSourceStatus[],
  source: WorkSource | undefined
): number {
  return statuses
    .filter(entry => source === undefined || entry.source === source)
    .reduce((total, entry) => total + entry.itemCount, 0);
}

export function parseGithubRepoFromRemote(
  value: string | null | undefined
): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const sshMatch =
    /^git@github\.com:(?<repo>[^/\s]+\/[^/\s]+?)(?:\.git)?$/iu.exec(trimmed);
  if (sshMatch?.groups?.repo) return sshMatch.groups.repo;
  try {
    const url = new URL(trimmed);
    if (url.hostname !== 'github.com') return null;
    const path = url.pathname
      .replace(/^\/+|\/+$/gu, '')
      .replace(/\.git$/iu, '');
    return /^[^/\s]+\/[^/\s]+$/u.test(path) ? path : null;
  } catch {
    return null;
  }
}
