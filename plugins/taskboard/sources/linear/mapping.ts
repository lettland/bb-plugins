import type { WorkStateCategory } from '../../contract.js';
import type { ExternalWorkItemDetail } from '../types.js';
import type { LinearIssue } from './schemas.js';

export function stateCategory(type: string): WorkStateCategory {
  if (type === 'started') return 'in_progress';
  if (type === 'completed') return 'done';
  if (type === 'canceled') return 'canceled';
  if (type === 'backlog') return 'backlog';
  return 'todo';
}

export function toItem(value: LinearIssue): ExternalWorkItemDetail {
  return {
    source: 'linear',
    locator: value.id,
    key: value.identifier,
    title: value.title,
    description: value.description ?? '',
    url: value.url,
    status: value.state.name,
    stateCategory: stateCategory(value.state.type),
    priority: value.priorityLabel || null,
    assignee: value.assignee?.name ?? null,
    project: value.project?.name ?? value.team.name,
    labels: value.labels.nodes.map(label => label.name),
    updatedAt: value.updatedAt,
    comments: (value.comments?.nodes ?? []).map(comment => ({
      author: comment.user?.name ?? 'Unknown',
      body: comment.body,
      createdAt: comment.createdAt
    }))
  };
}
