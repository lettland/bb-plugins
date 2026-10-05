import { z } from 'zod';
import { createMetadataQuery } from './queries.js';
import { requestLinear } from './request.js';
import {
  createMetadataTeamSchema,
  type LinearCreateOption,
  type LinearState
} from './schemas.js';

interface PagedConnection<T> {
  nodes: T[];
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
}

interface PagedCollection<T> {
  kind: string;
  loading: boolean;
  after: string | undefined;
  seenCursors: Set<string>;
  byId: Map<string, T>;
}

function pagedCollection<T>(kind: string): PagedCollection<T> {
  return {
    kind,
    loading: true,
    after: undefined,
    seenCursors: new Set<string>(),
    byId: new Map<string, T>()
  };
}

function collectPage<T extends { id: string }>(
  collection: PagedCollection<T>,
  connection: PagedConnection<T>
): void {
  if (!collection.loading) return;
  for (const node of connection.nodes) collection.byId.set(node.id, node);
  if (!connection.pageInfo.hasNextPage) {
    collection.loading = false;
    return;
  }
  const cursor = connection.pageInfo.endCursor;
  if (!cursor || collection.seenCursors.has(cursor)) {
    throw new Error(
      `Linear returned an invalid ${collection.kind} pagination cursor`
    );
  }
  collection.seenCursors.add(cursor);
  collection.after = cursor;
}

export async function createMetadata(apiKey: string, teamKey: string) {
  const states = pagedCollection<LinearState>('states');
  const members = pagedCollection<LinearCreateOption>('members');
  const labels = pagedCollection<LinearCreateOption>('labels');
  let expectedTeamId: string | undefined;

  while (states.loading || members.loading || labels.loading) {
    const data = await requestLinear(apiKey, createMetadataQuery, {
      teamKey,
      ...(states.after ? { statesAfter: states.after } : {}),
      ...(members.after ? { membersAfter: members.after } : {}),
      ...(labels.after ? { labelsAfter: labels.after } : {})
    });
    const teams = z
      .object({
        teams: z
          .object({ nodes: z.array(createMetadataTeamSchema) })
          .strict()
      })
      .strict()
      .parse(data).teams.nodes;
    const team = teams.find(
      candidate => candidate.key.toLowerCase() === teamKey.toLowerCase()
    );
    if (!team) throw new Error(`Linear team ${teamKey} was not found`);
    if (expectedTeamId && team.id !== expectedTeamId) {
      throw new Error('Linear returned inconsistent creation metadata');
    }
    expectedTeamId = team.id;

    collectPage(states, team.states);
    collectPage(members, team.members);
    collectPage(labels, team.labels);
  }

  return {
    statusOptions: [...states.byId.values()].map(state => ({
      id: state.id,
      label: state.name
    })),
    assigneeOptions: [...members.byId.values()].map(member => ({
      id: member.id,
      label: member.name
    })),
    priorityOptions: [
      { id: '1', label: 'Urgent' },
      { id: '2', label: 'High' },
      { id: '3', label: 'Medium' },
      { id: '4', label: 'Low' },
      { id: '0', label: 'No priority' }
    ],
    labelOptions: [...labels.byId.values()].map(label => ({
      id: label.id,
      label: label.name
    })),
    milestoneOptions: [],
    issueTypeOptions: [],
    defaultStatusId: null,
    defaultIssueTypeId: null,
    supportsDueDate: true
  };
}
