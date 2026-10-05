import type { WorkStateCategory } from '../../contract.js';
import type { ExternalWorkItemDetail } from '../types.js';
import type { JiraIssue } from './schemas.js';

export function nextJiraPageStart(
  page: {
    startAt: number;
    maxResults: number;
    total: number;
    isLast?: boolean;
  },
  requestedStart: number,
  itemCount: number
): number | null {
  if (page.startAt !== requestedStart) {
    throw new Error('Jira returned an invalid pagination offset');
  }
  if (itemCount === 0 || page.isLast === true) return null;
  const nextStart = page.startAt + page.maxResults;
  if (nextStart >= page.total) return null;
  if (nextStart <= requestedStart) {
    throw new Error('Jira returned an invalid pagination offset');
  }
  return nextStart;
}

export function jiraDescription(value: string) {
  return {
    type: 'doc',
    version: 1,
    content: value.split(/\r?\n/u).map(line => ({
      type: 'paragraph',
      content: line ? [{ type: 'text', text: line }] : []
    }))
  };
}

export function adfText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === null || typeof value !== 'object') return '';
  const record = value as Record<string, unknown>;
  const own = typeof record.text === 'string' ? record.text : '';
  const children = Array.isArray(record.content)
    ? record.content.map(adfText).filter(Boolean)
    : [];
  const joined = [own, ...children]
    .filter(Boolean)
    .join(record.type === 'paragraph' || record.type === 'heading' ? '' : '\n');
  return record.type === 'paragraph' || record.type === 'heading'
    ? `${joined}\n`
    : joined;
}

export function stateCategory(key: string): WorkStateCategory {
  if (key === 'done') return 'done';
  if (key === 'indeterminate') return 'in_progress';
  return 'todo';
}

export function toItem(
  baseUrl: string,
  issue: JiraIssue
): ExternalWorkItemDetail {
  return {
    source: 'jira',
    locator: issue.key,
    key: issue.key,
    title: issue.fields.summary,
    description: adfText(issue.fields.description).trim(),
    url: `${baseUrl}/browse/${encodeURIComponent(issue.key)}`,
    status: issue.fields.status.name,
    stateCategory: stateCategory(issue.fields.status.statusCategory.key),
    priority: issue.fields.priority?.name ?? null,
    assignee: issue.fields.assignee?.displayName ?? null,
    project: issue.fields.project.name,
    labels: issue.fields.labels,
    updatedAt: issue.fields.updated,
    comments: (issue.fields.comment?.comments ?? []).map(comment => ({
      author: comment.author.displayName,
      body: adfText(comment.body).trim(),
      createdAt: comment.created
    }))
  };
}
