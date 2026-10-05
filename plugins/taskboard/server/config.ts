import {
  projectConfigMutationSchema,
  projectSourceConfigSchema,
  type ProjectConfigMutation,
  type ProjectConfigView,
  type ProjectSourceConfig,
  type SecretMutation,
  type WorkSource
} from '../contract.js';
import type { CredentialSource } from '../credentials.js';
import { DEFAULT_PROJECT_CONFIG, SOURCES } from './constants.js';
import type { TaskboardContext } from './context.js';
import { enqueueMutation, withConfigMutation } from './mutations.js';
import { assertProjectExists, buildProjectConfigView } from './projects.js';
import {
  invalidateSource,
  sameRevisions,
  type ExpectedProjectMutationState
} from './revisions.js';
import { scheduleSources } from './sync.js';

interface PersistPlan {
  input: ProjectConfigMutation;
  previous: ProjectSourceConfig;
  config: ProjectSourceConfig;
  previousLinearCredential: string | undefined;
  previousJiraCredential: string | undefined;
}

function changedSources(
  previous: ProjectSourceConfig,
  next: ProjectConfigMutation
): WorkSource[] {
  if (previous.source !== next.source) return [...SOURCES];
  const changed = new Set<WorkSource>();
  if (
    previous.linearTeamKey !== next.linearTeamKey ||
    next.linearCredential.operation !== 'keep'
  ) {
    changed.add('linear');
  }
  if (
    previous.jiraBaseUrl !== next.jiraBaseUrl ||
    previous.jiraEmail !== next.jiraEmail ||
    previous.jiraJql !== next.jiraJql ||
    next.jiraCredential.operation !== 'keep'
  ) {
    changed.add('jira');
  }
  return [...changed];
}

async function restoreCredential(
  tc: TaskboardContext,
  projectId: string,
  source: CredentialSource,
  previous: string | undefined
): Promise<void> {
  const mutation: SecretMutation = previous
    ? { operation: 'set', value: previous }
    : { operation: 'clear' };
  await tc.credentials.mutate(projectId, source, mutation);
}

function sameProjectConfig(
  left: ProjectSourceConfig,
  right: ProjectSourceConfig
): boolean {
  return (
    left.projectId === right.projectId &&
    left.source === right.source &&
    left.linearTeamKey === right.linearTeamKey &&
    left.jiraBaseUrl === right.jiraBaseUrl &&
    left.jiraEmail === right.jiraEmail &&
    left.jiraJql === right.jiraJql
  );
}

async function restoreCredentials(
  tc: TaskboardContext,
  plan: PersistPlan,
  restore: { linear: boolean; jira: boolean }
): Promise<boolean> {
  const { projectId } = plan.input;
  const results = await Promise.allSettled([
    restore.linear
      ? restoreCredential(tc, projectId, 'linear', plan.previousLinearCredential)
      : Promise.resolve(),
    restore.jira
      ? restoreCredential(tc, projectId, 'jira', plan.previousJiraCredential)
      : Promise.resolve()
  ]);
  return !results.some(result => result.status === 'rejected');
}

function assertExpectedProjectState(
  tc: TaskboardContext,
  projectId: string,
  previous: ProjectSourceConfig,
  expectedState: ExpectedProjectMutationState | undefined
): void {
  if (
    expectedState &&
    (!sameProjectConfig(previous, expectedState.config) ||
      !sameRevisions(tc, projectId, expectedState.revisions))
  ) {
    throw new Error(
      'Project connector state changed while the credential form was open; reopen it and confirm the current settings'
    );
  }
}

async function preflightKeptJiraToken(
  tc: TaskboardContext,
  input: ProjectConfigMutation,
  jiraIdentityChanged: boolean
): Promise<boolean> {
  if (!jiraIdentityChanged || input.jiraCredential.operation !== 'keep') {
    return false;
  }
  await assertProjectExists(tc, input.projectId);
  if (await tc.credentials.configured(input.projectId, 'jira')) {
    throw new Error(
      'Changing the Jira URL or email requires a replacement token or explicit token removal'
    );
  }
  return true;
}

async function buildPersistPlan(
  tc: TaskboardContext,
  input: ProjectConfigMutation,
  previous: ProjectSourceConfig
): Promise<PersistPlan> {
  const needsPreviousLinearCredential =
    input.linearCredential.operation !== 'keep';
  const needsPreviousJiraCredential =
    input.jiraCredential.operation !== 'keep';
  const [previousLinearCredential, previousJiraCredential] =
    await Promise.all([
      needsPreviousLinearCredential
        ? tc.credentials.read(input.projectId, 'linear')
        : Promise.resolve(undefined),
      needsPreviousJiraCredential
        ? tc.credentials.read(input.projectId, 'jira')
        : Promise.resolve(undefined)
    ]);
  const config = projectSourceConfigSchema.parse({
    projectId: input.projectId,
    source: input.source,
    linearTeamKey: input.linearTeamKey,
    jiraBaseUrl: input.jiraBaseUrl,
    jiraEmail: input.jiraEmail,
    jiraJql: input.jiraJql
  });
  return {
    input,
    previous,
    config,
    previousLinearCredential,
    previousJiraCredential
  };
}

async function clearOldJiraBinding(
  tc: TaskboardContext,
  plan: PersistPlan
): Promise<boolean> {
  const { input } = plan;
  let linearMutated = false;
  try {
    if (input.linearCredential.operation !== 'keep') {
      await tc.credentials.mutate(
        input.projectId,
        'linear',
        input.linearCredential
      );
      linearMutated = true;
    }
    // Remove the old destination binding before persisting the new one.
    // A failure from this point leaves Jira without a token, never with a
    // token paired to the wrong origin or account.
    await tc.credentials.mutate(input.projectId, 'jira', {
      operation: 'clear'
    });
  } catch (error) {
    if (linearMutated) {
      await restoreCredential(
        tc,
        input.projectId,
        'linear',
        plan.previousLinearCredential
      );
    }
    throw error;
  }
  return linearMutated;
}

async function saveConfigOrRestoreCredentials(
  tc: TaskboardContext,
  plan: PersistPlan,
  linearMutated: boolean
): Promise<ProjectSourceConfig> {
  try {
    return tc.store.saveProjectConfig(plan.config);
  } catch (error) {
    const restored = await restoreCredentials(tc, plan, {
      linear: linearMutated,
      jira: true
    });
    if (!restored) {
      throw new Error(
        'Connector save failed and the previous credential state could not be fully restored'
      );
    }
    throw error;
  }
}

async function rollbackFailedJiraSet(
  tc: TaskboardContext,
  plan: PersistPlan,
  linearMutated: boolean
): Promise<never> {
  let configRolledBack = false;
  try {
    tc.store.saveProjectConfig(plan.previous);
    configRolledBack = true;
  } catch {
    // The new destination stays tokenless when its config cannot
    // be rolled back; restoring the old token would misbind it.
  }
  const restored = await restoreCredentials(tc, plan, {
    linear: linearMutated,
    jira: configRolledBack
  });
  tc.bb.realtime.publish('taskboard:changed', {
    projectId: plan.input.projectId,
    source: null
  });
  if (!restored) {
    throw new Error(
      'Jira credential save failed and the previous credential state could not be fully restored'
    );
  }
  throw new Error(
    configRolledBack
      ? 'Jira credential could not be saved; the previous Jira bundle was restored'
      : 'Jira credential could not be saved; Jira was left unconfigured'
  );
}

async function applyJiraIdentityChange(
  tc: TaskboardContext,
  plan: PersistPlan
): Promise<ProjectSourceConfig> {
  const { input } = plan;
  const linearMutated = await clearOldJiraBinding(tc, plan);
  const savedConfig = await saveConfigOrRestoreCredentials(
    tc,
    plan,
    linearMutated
  );
  if (input.jiraCredential.operation === 'set') {
    try {
      await tc.credentials.mutate(
        input.projectId,
        'jira',
        input.jiraCredential
      );
    } catch {
      return rollbackFailedJiraSet(tc, plan, linearMutated);
    }
  }
  return savedConfig;
}

async function applyCredentialsAndConfig(
  tc: TaskboardContext,
  plan: PersistPlan
): Promise<ProjectSourceConfig> {
  const { input } = plan;
  let linearMutated = false;
  let jiraMutated = false;
  try {
    if (input.linearCredential.operation !== 'keep') {
      await tc.credentials.mutate(
        input.projectId,
        'linear',
        input.linearCredential
      );
      linearMutated = true;
    }
    if (input.jiraCredential.operation !== 'keep') {
      await tc.credentials.mutate(
        input.projectId,
        'jira',
        input.jiraCredential
      );
      jiraMutated = true;
    }
    return tc.store.saveProjectConfig(plan.config);
  } catch (error) {
    const restored = await restoreCredentials(tc, plan, {
      linear: linearMutated,
      jira: jiraMutated
    });
    if (!restored) {
      throw new Error(
        'Credential save failed and the previous credential state could not be fully restored'
      );
    }
    throw error;
  }
}

async function applyProjectConfig(
  tc: TaskboardContext,
  input: ProjectConfigMutation,
  expectedState: ExpectedProjectMutationState | undefined
): Promise<{ savedConfig: ProjectSourceConfig; affected: Set<WorkSource> }> {
  const previous = tc.store.projectConfig(
    input.projectId,
    DEFAULT_PROJECT_CONFIG
  );
  assertExpectedProjectState(tc, input.projectId, previous, expectedState);
  const affected = new Set(changedSources(previous, input));
  if (affected.size === 0) {
    await assertProjectExists(tc, input.projectId);
    return { savedConfig: previous, affected };
  }
  const jiraIdentityChanged =
    previous.jiraBaseUrl !== input.jiraBaseUrl ||
    previous.jiraEmail !== input.jiraEmail;
  const projectValidated = await preflightKeptJiraToken(
    tc,
    input,
    jiraIdentityChanged
  );
  // After the rejection-only keep-token preflight, invalidate before
  // any mutation I/O. Tails block new snapshots and the revision rejects
  // already-running ones.
  for (const source of affected) {
    invalidateSource(tc, input.projectId, source);
  }
  if (!projectValidated) await assertProjectExists(tc, input.projectId);
  const plan = await buildPersistPlan(tc, input, previous);
  const savedConfig = jiraIdentityChanged
    ? await applyJiraIdentityChange(tc, plan)
    : await applyCredentialsAndConfig(tc, plan);
  return { savedConfig, affected };
}

export async function persistProjectConfig(
  tc: TaskboardContext,
  rawInput: ProjectConfigMutation,
  expectedState?: ExpectedProjectMutationState
): Promise<ProjectConfigView> {
  const input = projectConfigMutationSchema.parse(rawInput);
  const { savedConfig, affected } = await withConfigMutation(tc, () =>
    // Register every source tail synchronously once the config gate is held.
    // New adapter snapshots wait here; an already-running snapshot is
    // rejected by the revision bump inside the queued operation.
    enqueueMutation(tc, input.projectId, SOURCES, () =>
      applyProjectConfig(tc, input, expectedState)
    )
  );

  tc.bb.realtime.publish('taskboard:changed', {
    projectId: savedConfig.projectId,
    source: null
  });
  if (affected.has(savedConfig.source)) {
    scheduleSources(tc, savedConfig.projectId, [savedConfig.source]);
  }
  return buildProjectConfigView(tc, savedConfig);
}
