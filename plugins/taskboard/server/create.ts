import {
  createIssueMetadataSchema,
  sourceName,
  type CreateIssueContext,
  type CreateIssueInput,
  type CreateIssueMetadata,
  type WorkItem,
  type WorkSource
} from '../contract.js';
import {
  assertExpectedConnectorRevision,
  assertExpectedIssueSource,
  createSafeIssueMetadataFailure,
  reconcileIssueCreation
} from '../create-issue.js';
import {
  githubReposForProject,
  loadGithubStatus
} from '../sources/github.js';
import { jiraProjectKeysFromJql } from '../sources/jira-scope.js';
import {
  withoutComments,
  type ExternalWorkItemCreateResult,
  type ExternalWorkItemDetail,
  type WorkSourceAdapter
} from '../sources/types.js';
import { adapters, assertAdapterConfigured } from './adapters.js';
import { SOURCES } from './constants.js';
import type { TaskboardContext } from './context.js';
import { enqueueMutation, waitForMutations } from './mutations.js';
import {
  projectById,
  projectConfig,
  readProjectConfigView
} from './projects.js';
import {
  advanceSourceRevision,
  assertRevisionCurrent,
  currentConnectorRevision,
  currentRevision
} from './revisions.js';
import { syncAll } from './sync.js';
import { errorMessage, scopedItem } from './util.js';

interface CreatedWorkItem {
  item: WorkItem;
  warnings: string[];
  assigneeConfirmation: ExternalWorkItemCreateResult['assigneeConfirmation'];
}

export async function getCreateIssueContext(
  tc: TaskboardContext,
  projectId: string
): Promise<CreateIssueContext> {
  const [project, config, currentAdapters] = await Promise.all([
    projectById(tc, projectId),
    readProjectConfigView(tc, projectId, true),
    adapters(tc, projectId, true)
  ]);
  const adapter = currentAdapters.get(config.source);
  if (!adapter) throw new Error(`Missing ${config.source} adapter`);

  const destinationLabel =
    config.source === 'github'
      ? 'Repository'
      : config.source === 'linear'
        ? 'Team'
        : 'Project key';
  let githubMessage: string | null = null;
  let githubRepos = config.githubRepos;
  if (config.source === 'github') {
    try {
      const status = await loadGithubStatus(tc.bb);
      githubRepos = githubReposForProject(status, projectId);
      if (!status.ghOk) {
        githubMessage = status.ghError ?? 'GitHub is not authenticated.';
      }
    } catch {
      githubRepos = [];
      githubMessage =
        'Install and enable BB’s official GitHub plugin before creating GitHub issues.';
    }
  }
  const destinationIds =
    config.source === 'github'
      ? githubRepos
      : config.source === 'linear'
        ? config.linearTeamKey
          ? [config.linearTeamKey]
          : []
        : jiraProjectKeysFromJql(config.jiraJql);
  const destinations = destinationIds.map(id => ({ id, label: id }));
  const missingDestinationMessage =
    config.source === 'github' && destinations.length === 0
      ? 'Map at least one GitHub repository to this BB project.'
      : config.source === 'linear' && destinations.length === 0
        ? 'Choose a Linear team key for this BB project in Manage.'
        : null;
  const configurationMessage =
    githubMessage ??
    (adapter.configured() ? null : adapter.configurationMessage());

  return {
    projectId,
    projectName: project.name,
    source: config.source,
    available:
      configurationMessage === null && missingDestinationMessage === null,
    message: configurationMessage ?? missingDestinationMessage,
    destinationLabel,
    destinations,
    defaultDestinationId: destinations[0]?.id ?? null,
    allowsCustomDestination: config.source === 'jira',
    defaultIssueType: config.source === 'jira' ? 'Task' : null
  };
}

async function selectIssueTarget(
  tc: TaskboardContext,
  projectId: string,
  expectedSource: WorkSource
): Promise<{ source: WorkSource; connectorRevision: number }> {
  await waitForMutations(tc, projectId, SOURCES);
  const config = projectConfig(tc, projectId, true);
  const source = assertExpectedIssueSource(expectedSource, config.source);
  return {
    source,
    connectorRevision: currentConnectorRevision(tc, projectId, source)
  };
}

async function issueAdapter(
  tc: TaskboardContext,
  projectId: string,
  source: WorkSource
): Promise<WorkSourceAdapter> {
  const adapter = (await adapters(tc, projectId, true)).get(source);
  if (!adapter) throw new Error(`Missing ${source} adapter`);
  return adapter;
}

export async function getCreateIssueMetadata(
  tc: TaskboardContext,
  input: {
    projectId: string;
    expectedSource: WorkSource;
    destinationId: string;
    issueType: string | null;
  }
) {
  const { source, connectorRevision } = await selectIssueTarget(
    tc,
    input.projectId,
    input.expectedSource
  );
  const adapter = await issueAdapter(tc, input.projectId, source);
  assertExpectedConnectorRevision(
    connectorRevision,
    currentConnectorRevision(tc, input.projectId, source),
    source
  );
  assertAdapterConfigured(adapter, source);
  let metadata: CreateIssueMetadata;
  try {
    metadata = createIssueMetadataSchema.parse(
      await adapter.createMetadata({
        destinationId: input.destinationId,
        issueType: input.issueType
      })
    );
  } catch (error) {
    return createSafeIssueMetadataFailure(source, error);
  }
  assertExpectedConnectorRevision(
    connectorRevision,
    currentConnectorRevision(tc, input.projectId, source),
    source
  );
  return { ok: true as const, metadata, connectorRevision };
}

async function applyIssueCreation(
  tc: TaskboardContext,
  input: CreateIssueInput,
  source: WorkSource,
  adapter: WorkSourceAdapter,
  revision: number
): Promise<CreatedWorkItem> {
  assertRevisionCurrent(
    tc,
    input.projectId,
    source,
    revision,
    'before the issue was created; try again'
  );
  assertExpectedConnectorRevision(
    input.connectorRevision,
    currentConnectorRevision(tc, input.projectId, source),
    source
  );
  advanceSourceRevision(tc, input.projectId, source);
  let externalItem: ExternalWorkItemDetail;
  let warnings: string[];
  // Preserve the provider-native confirmation separately from display text.
  let assigneeConfirmation: ExternalWorkItemCreateResult['assigneeConfirmation'];
  try {
    const result = await adapter.create({
      title: input.title,
      description: input.description,
      destinationId: input.destinationId,
      issueType: input.issueType,
      statusId: input.statusId,
      assigneeId: input.assigneeId,
      priorityId: input.priorityId,
      labelIds: input.labelIds,
      dueDate: input.dueDate,
      milestoneId: input.milestoneId
    });
    externalItem = result.item;
    warnings = result.warnings;
    assigneeConfirmation = result.assigneeConfirmation;
  } catch (error) {
    throw new Error(
      `${sourceName(source)} could not create the issue. ${errorMessage(error)}`
    );
  }
  if (externalItem.source !== source || !externalItem.locator) {
    throw new Error(`${sourceName(source)} returned an invalid new issue`);
  }
  const item = scopedItem(input.projectId, withoutComments(externalItem));
  tc.store.upsert(item);
  tc.bb.realtime.publish('taskboard:changed', {
    projectId: input.projectId,
    source
  });
  return { item, warnings, assigneeConfirmation };
}

export async function createWorkItem(
  tc: TaskboardContext,
  input: CreateIssueInput
): Promise<CreatedWorkItem> {
  const { source, connectorRevision } = await selectIssueTarget(
    tc,
    input.projectId,
    input.expectedSource
  );
  assertExpectedConnectorRevision(
    input.connectorRevision,
    connectorRevision,
    source
  );
  const revision = currentRevision(tc, input.projectId, source);
  const adapter = await issueAdapter(tc, input.projectId, source);
  assertAdapterConfigured(adapter, source);

  const mutation = enqueueMutation(tc, input.projectId, [source], () =>
    applyIssueCreation(tc, input, source, adapter, revision)
  );
  void reconcileIssueCreation(mutation, forceRefresh =>
    syncAll(tc, input.projectId, source, forceRefresh)
  ).catch((error: unknown) => {
    tc.bb.log.warn(
      `${sourceName(source)} reconciliation failed for ${input.projectId}: ${errorMessage(error)}`
    );
  });
  return mutation;
}
