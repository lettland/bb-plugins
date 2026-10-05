import { CREATE_OUTCOME_UNCERTAIN_MARKER } from '../../contract.js';
import type {
  ExternalWorkItemCreateInput,
  ExternalWorkItemCreateResult
} from '../types.js';
import { markGithubCacheStale } from './cache.js';
import { assertMappedRepository, type GithubScope } from './issues.js';
import { createdGithubIssueSchema, type CreatedGithubIssue } from './schemas.js';

function parseMilestone(input: ExternalWorkItemCreateInput): number | null {
  const milestone =
    input.milestoneId === null ? null : Number(input.milestoneId);
  if (
    milestone !== null &&
    (!Number.isSafeInteger(milestone) || milestone < 1)
  ) {
    throw new Error('GitHub milestone is invalid');
  }
  return milestone;
}

function createIssueArgs(
  input: ExternalWorkItemCreateInput,
  milestone: number | null
): string[] {
  return [
    'api',
    '--method',
    'POST',
    `repos/${input.destinationId}/issues`,
    '--raw-field',
    `title=${input.title}`,
    '--raw-field',
    `body=${input.description}`,
    ...(input.assigneeId
      ? ['--raw-field', `assignees[]=${input.assigneeId}`]
      : []),
    ...input.labelIds.flatMap(label => ['--raw-field', `labels[]=${label}`]),
    ...(milestone !== null ? ['--field', `milestone=${milestone}`] : [])
  ];
}

async function postNewIssue(
  { bb, runGithubCli }: GithubScope,
  args: string[]
): Promise<CreatedGithubIssue> {
  // The write may commit even when the response is lost or malformed.
  // Advance before attempting it so reconciliation never reuses a refresh
  // that began before this possibly-committed mutation.
  markGithubCacheStale(bb);
  try {
    return createdGithubIssueSchema.parse(
      JSON.parse(await runGithubCli(args, 30_000))
    );
  } catch {
    throw new Error(
      `${CREATE_OUTCOME_UNCERTAIN_MARKER} GitHub may have created the issue, but Taskboard could not confirm the response. Refresh the board and check for it before trying again.`
    );
  }
}

function createResult(
  input: ExternalWorkItemCreateInput,
  created: CreatedGithubIssue,
  milestone: number | null
): ExternalWorkItemCreateResult {
  const createdAssignees = created.assignees.map(assignee => assignee.login);
  const createdLabels = created.labels.map(label =>
    typeof label === 'string' ? label : label.name
  );
  const returnedAssignees = new Set(createdAssignees);
  const returnedLabels = new Set(createdLabels);
  const confirmedId =
    (input.assigneeId && returnedAssignees.has(input.assigneeId)
      ? input.assigneeId
      : createdAssignees[0]) ?? null;
  const warnings: string[] = [];
  if (input.assigneeId && !returnedAssignees.has(input.assigneeId)) {
    warnings.push(
      `GitHub created the issue but could not assign @${input.assigneeId}.`
    );
  }
  const missingLabels = input.labelIds.filter(
    label => !returnedLabels.has(label)
  );
  if (missingLabels.length > 0) {
    warnings.push(
      `GitHub created the issue without ${missingLabels.join(', ')}.`
    );
  }
  if (milestone !== null && created.milestone?.number !== milestone) {
    warnings.push(
      'GitHub created the issue but could not attach the selected milestone.'
    );
  }
  return {
    item: {
      source: 'github',
      locator: `${input.destinationId}#${created.number}`,
      key: `${input.destinationId}#${created.number}`,
      title: input.title,
      description: input.description,
      url: created.html_url,
      status: 'OPEN',
      stateCategory: 'todo',
      priority: null,
      assignee: createdAssignees.join(', ') || null,
      project: input.destinationId,
      labels: createdLabels,
      updatedAt: new Date().toISOString(),
      comments: []
    },
    warnings,
    assigneeConfirmation: {
      confirmed: true,
      id: confirmedId
    }
  };
}

export async function createIssue(
  scope: GithubScope,
  input: ExternalWorkItemCreateInput
): Promise<ExternalWorkItemCreateResult> {
  await assertMappedRepository(scope, input.destinationId);
  if (input.dueDate !== null || input.priorityId !== null) {
    throw new Error(
      'GitHub issues use milestones instead of direct due dates or priorities'
    );
  }
  if (input.statusId !== null && input.statusId !== 'open') {
    throw new Error('GitHub issues are created open');
  }
  const milestone = parseMilestone(input);
  const created = await postNewIssue(
    scope,
    createIssueArgs(input, milestone)
  );
  return createResult(input, created, milestone);
}
