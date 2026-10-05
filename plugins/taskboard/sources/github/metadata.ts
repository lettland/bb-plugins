import type { z } from 'zod';
import type { ExternalWorkItemCreateMetadataInput } from '../types.js';
import { assertMappedRepository, type GithubScope } from './issues.js';
import { milestoneLabel, uniqueByIdentity } from './mapping.js';
import {
  paginatedGithubAssigneesSchema,
  paginatedGithubLabelsSchema,
  paginatedGithubMilestonesSchema
} from './schemas.js';

async function listPaginated<T>(
  { runGithubCli }: GithubScope,
  path: string,
  schema: z.ZodType<T[][]>,
  identity: (value: T) => string
): Promise<T[]> {
  const output = await runGithubCli(
    ['api', '--paginate', '--slurp', path],
    30_000
  );
  return uniqueByIdentity(schema.parse(JSON.parse(output)).flat(), identity);
}

export async function createMetadata(
  scope: GithubScope,
  input: ExternalWorkItemCreateMetadataInput
) {
  await assertMappedRepository(scope, input.destinationId);
  const repoPath = `repos/${input.destinationId}`;
  const [users, labels, milestones] = await Promise.all([
    listPaginated(
      scope,
      `${repoPath}/assignees?per_page=100`,
      paginatedGithubAssigneesSchema,
      user => user.login
    ),
    listPaginated(
      scope,
      `${repoPath}/labels?per_page=100`,
      paginatedGithubLabelsSchema,
      label => label.name
    ),
    listPaginated(
      scope,
      `${repoPath}/milestones?state=open&per_page=100`,
      paginatedGithubMilestonesSchema,
      milestone => String(milestone.number)
    ).catch(() => [])
  ]);
  return {
    statusOptions: [],
    assigneeOptions: users.map(user => ({
      id: user.login,
      label: `@${user.login}`
    })),
    priorityOptions: [],
    labelOptions: labels.map(label => ({
      id: label.name,
      label: label.name
    })),
    milestoneOptions: milestones.map(milestone => ({
      id: String(milestone.number),
      label: milestoneLabel(milestone)
    })),
    issueTypeOptions: [],
    defaultStatusId: null,
    defaultIssueTypeId: null,
    supportsDueDate: false
  };
}
