import type { ExternalWorkItemDetail } from '../types.js';
import type { GithubItem, GithubMilestone } from './schemas.js';

export function milestoneLabel(milestone: GithubMilestone) {
  const dueDate = milestone.due_on?.slice(0, 10);
  return dueDate ? `${milestone.title} · ${dueDate}` : milestone.title;
}

export function uniqueByIdentity<T>(
  values: readonly T[],
  identity: (value: T) => string
): T[] {
  const seen = new Set<string>();
  return values.filter(value => {
    const key = identity(value).toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function toItem(
  value: GithubItem,
  comments: ExternalWorkItemDetail['comments'] = []
): ExternalWorkItemDetail {
  const open = value.state.toLowerCase() === 'open';
  return {
    source: 'github',
    locator: `${value.repo}#${value.number}`,
    key: `${value.repo}#${value.number}`,
    title: value.title,
    description: value.body,
    url: value.url,
    status: value.state,
    stateCategory: open ? 'todo' : 'done',
    priority: null,
    assignee: value.assignees.join(', ') || null,
    project: value.repo,
    labels: value.labels,
    updatedAt: value.updatedAt,
    comments
  };
}

export function parseLocator(locator: string): {
  repo: string;
  number: number;
} {
  const match = /^(?<repo>[^#]+)#(?<number>[1-9]\d*)$/u.exec(locator);
  if (!match?.groups)
    throw new Error(`Invalid GitHub issue locator: ${locator}`);
  return { repo: match.groups.repo!, number: Number(match.groups.number) };
}
