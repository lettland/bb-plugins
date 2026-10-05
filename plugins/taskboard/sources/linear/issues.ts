import { z } from 'zod';
import { CREATE_OUTCOME_UNCERTAIN_MARKER } from '../../contract.js';
import type {
  ExternalWorkItemCreateInput,
  ExternalWorkItemCreateResult,
  ExternalWorkItemDetail,
  ExternalWorkStatusOption
} from '../types.js';
import { stateCategory, toItem } from './mapping.js';
import {
  createIssueMutation,
  issueQuery,
  issueStatusOptionsQuery,
  teamForCreateQuery,
  teamIssuesQuery,
  updateIssueStatusMutation
} from './queries.js';
import { requestLinear } from './request.js';
import {
  issueConnectionSchema,
  issueSchema,
  stateSchema,
  type LinearIssue
} from './schemas.js';

export interface LinearScope {
  apiKey: string;
  teamKey: string;
}

export function isOutsideTeam(scope: LinearScope, teamKey: string): boolean {
  return teamKey.toLowerCase() !== scope.teamKey.toLowerCase();
}

export async function loadIssue(
  scope: LinearScope,
  locator: string
): Promise<ExternalWorkItemDetail> {
  const data = await requestLinear(scope.apiKey, issueQuery, { id: locator });
  const issue = z.object({ issue: issueSchema }).strict().parse(data).issue;
  if (issue.id !== locator) {
    throw new Error(`Linear returned the wrong issue for ${locator}`);
  }
  if (isOutsideTeam(scope, issue.team.key)) {
    throw new Error(`Linear issue ${locator} is outside the configured scope`);
  }
  return toItem(issue);
}

export async function statusOptions(
  scope: LinearScope,
  locator: string
): Promise<ExternalWorkStatusOption[]> {
  const data = await requestLinear(scope.apiKey, issueStatusOptionsQuery, {
    id: locator
  });
  const result = z
    .object({
      issue: z
        .object({
          id: z.string().min(1),
          state: stateSchema,
          team: z
            .object({
              key: z.string(),
              states: z.object({ nodes: z.array(stateSchema) }).strict()
            })
            .strict()
        })
        .strict()
    })
    .strict()
    .parse(data).issue;
  if (result.id !== locator) {
    throw new Error(`Linear returned the wrong issue for ${locator}`);
  }
  if (isOutsideTeam(scope, result.team.key)) {
    throw new Error(`Linear issue ${locator} is outside the configured scope`);
  }
  return [
    ...new Map(
      result.team.states.nodes.map(state => [state.id, state])
    ).values()
  ].map(state => ({
    id: state.id,
    name: state.name,
    stateCategory: stateCategory(state.type),
    current: state.id === result.state.id
  }));
}

export async function listIssues(scope: LinearScope): Promise<LinearIssue[]> {
  const issues: LinearIssue[] = [];
  const seenCursors = new Set<string>();
  let after: string | undefined;
  for (;;) {
    const data = await requestLinear(scope.apiKey, teamIssuesQuery, {
      teamKey: scope.teamKey,
      ...(after ? { after } : {})
    });
    const connection = z
      .object({ issues: issueConnectionSchema })
      .strict()
      .parse(data).issues;
    if (connection.nodes.some(issue => isOutsideTeam(scope, issue.team.key))) {
      throw new Error('Linear returned an issue outside the configured team');
    }
    issues.push(...connection.nodes);
    if (!connection.pageInfo.hasNextPage) break;
    const cursor = connection.pageInfo.endCursor;
    if (!cursor || seenCursors.has(cursor)) {
      throw new Error('Linear returned an invalid pagination cursor');
    }
    seenCursors.add(cursor);
    after = cursor;
  }
  return issues;
}

export async function updateStatus(
  scope: LinearScope,
  locator: string,
  statusId: string
): Promise<ExternalWorkItemDetail> {
  const available = await statusOptions(scope, locator);
  const target = available.find(option => option.id === statusId);
  if (!target) {
    throw new Error('Linear status is not available for this issue');
  }
  if (target.current) return loadIssue(scope, locator);
  const data = await requestLinear(scope.apiKey, updateIssueStatusMutation, {
    id: locator,
    stateId: statusId
  });
  const update = z
    .object({
      issueUpdate: z
        .object({ success: z.boolean(), issue: issueSchema })
        .strict()
    })
    .strict()
    .parse(data).issueUpdate;
  if (!update.success) throw new Error('Linear rejected the status update');
  if (
    update.issue.id !== locator ||
    update.issue.state.id !== statusId ||
    isOutsideTeam(scope, update.issue.team.key)
  ) {
    throw new Error('Linear returned an invalid status update result');
  }
  return toItem(update.issue);
}

async function findCreateTeam(scope: LinearScope) {
  const teamData = await requestLinear(scope.apiKey, teamForCreateQuery, {
    teamKey: scope.teamKey
  });
  const teams = z
    .object({
      teams: z
        .object({
          nodes: z.array(
            z
              .object({
                id: z.string().min(1),
                key: z.string().min(1),
                name: z.string()
              })
              .strict()
          )
        })
        .strict()
    })
    .strict()
    .parse(teamData).teams.nodes;
  const team = teams.find(
    candidate => !isOutsideTeam(scope, candidate.key)
  );
  if (!team) throw new Error(`Linear team ${scope.teamKey} was not found`);
  return team;
}

async function submitNewIssue(
  scope: LinearScope,
  teamId: string,
  priority: number | null,
  input: ExternalWorkItemCreateInput
): Promise<unknown> {
  try {
    return await requestLinear(scope.apiKey, createIssueMutation, {
      input: {
        teamId,
        title: input.title,
        description: input.description,
        ...(input.statusId ? { stateId: input.statusId } : {}),
        ...(input.assigneeId ? { assigneeId: input.assigneeId } : {}),
        ...(priority !== null ? { priority } : {}),
        ...(input.labelIds.length > 0 ? { labelIds: input.labelIds } : {}),
        ...(input.dueDate ? { dueDate: input.dueDate } : {})
      }
    });
  } catch {
    throw new Error(
      `${CREATE_OUTCOME_UNCERTAIN_MARKER} Linear may have created the issue, but Taskboard could not confirm the response. Refresh the board and check for it before trying again.`
    );
  }
}

function confirmCreatedIssue(
  scope: LinearScope,
  data: unknown
): ExternalWorkItemCreateResult {
  const acknowledgement = z
    .object({
      issueCreate: z
        .object({
          success: z.boolean(),
          issue: z.unknown().nullable().optional()
        })
        .passthrough()
    })
    .passthrough()
    .safeParse(data);
  if (
    acknowledgement.success &&
    acknowledgement.data.issueCreate.success === false &&
    acknowledgement.data.issueCreate.issue == null
  ) {
    throw new Error('Linear rejected the new issue');
  }
  try {
    const created = z
      .object({
        issueCreate: z
          .object({ success: z.literal(true), issue: issueSchema })
          .strict()
      })
      .strict()
      .parse(data).issueCreate;
    if (isOutsideTeam(scope, created.issue.team.key)) {
      throw new Error('Linear created the issue outside the configured team');
    }
    return {
      item: toItem(created.issue),
      warnings: [],
      assigneeConfirmation: {
        confirmed: true,
        id: created.issue.assignee?.id ?? null
      }
    };
  } catch {
    throw new Error(
      `${CREATE_OUTCOME_UNCERTAIN_MARKER} Linear may have created the issue, but Taskboard could not confirm its details. Refresh the board and check for it before trying again.`
    );
  }
}

export async function createIssue(
  scope: LinearScope,
  input: ExternalWorkItemCreateInput
): Promise<ExternalWorkItemCreateResult> {
  if (isOutsideTeam(scope, input.destinationId)) {
    throw new Error(
      `Linear team ${input.destinationId} is outside the configured scope`
    );
  }
  const team = await findCreateTeam(scope);
  const priority = input.priorityId === null ? null : Number(input.priorityId);
  if (
    priority !== null &&
    (!Number.isInteger(priority) || priority < 0 || priority > 4)
  ) {
    throw new Error('Linear priority is invalid');
  }
  if (input.milestoneId !== null) {
    throw new Error('Linear issues use a due date instead of a milestone');
  }
  const data = await submitNewIssue(scope, team.id, priority, input);
  return confirmCreatedIssue(scope, data);
}
