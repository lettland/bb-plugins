import { sourceName } from '../contract.js';
import type { CredentialSource } from '../credentials.js';
import { CREDENTIAL_SOURCES, DEFAULT_PROJECT_CONFIG } from './constants.js';
import type { TaskboardContext } from './context.js';
import { enqueueMutation, withExclusiveMigration } from './mutations.js';
import { listProjects } from './projects.js';
import { invalidateSource } from './revisions.js';

async function migrateAmbiguousLegacyCredential(
  tc: TaskboardContext,
  source: CredentialSource,
  selectedProjectIds: string[],
  unavailableProjectIds: string[]
): Promise<void> {
  if (selectedProjectIds.length > 1) {
    for (const projectId of unavailableProjectIds) {
      invalidateSource(tc, projectId, source);
    }
    await Promise.all(
      unavailableProjectIds.map(projectId =>
        enqueueMutation(tc, projectId, [source], async () => undefined)
      )
    );
  }
  const result = await tc.credentials.migrateLegacy(
    source,
    selectedProjectIds
  );
  if (result.outcome === 'ambiguous-projects') {
    tc.bb.log.warn(
      `${sourceName(source)} legacy credential needs manual project assignment`
    );
  }
}

async function migrateSelectedLegacyCredential(
  tc: TaskboardContext,
  source: CredentialSource,
  projectId: string,
  unavailableProjectIds: string[]
): Promise<void> {
  if (source === 'jira') {
    const config = tc.store.projectConfig(projectId, DEFAULT_PROJECT_CONFIG);
    if (!config.jiraBaseUrl || !config.jiraEmail) {
      invalidateSource(tc, projectId, source);
      await enqueueMutation(tc, projectId, [source], async () => undefined);
      const result = await tc.credentials.migrateLegacy(source, []);
      if (result.outcome === 'no-eligible-project') {
        tc.bb.log.warn(
          'Jira legacy credential was preserved because the enabled project needs a Jira URL and email; assign the full credential bundle in Manage'
        );
      }
      return;
    }
  }
  if (unavailableProjectIds.includes(projectId)) {
    invalidateSource(tc, projectId, source);
  }
  await enqueueMutation(tc, projectId, [source], async () => {
    const result = await tc.credentials.migrateLegacy(source, [projectId]);
    if (
      result.outcome === 'migrated' ||
      result.outcome === 'already-migrated'
    ) {
      tc.bb.realtime.publish('taskboard:changed', {
        projectId,
        source
      });
    } else if (result.outcome === 'destination-conflict') {
      tc.bb.log.warn(
        `${sourceName(source)} legacy credential conflicts with the configured project credential`
      );
    }
  });
}

async function migrateLegacyCredential(
  tc: TaskboardContext,
  source: CredentialSource,
  liveProjectIds: ReadonlySet<string>
): Promise<void> {
  const selectedProjectIds = tc.store
    .selectedProjectIds(source)
    .filter(projectId => liveProjectIds.has(projectId));
  const connectorStates = await Promise.all(
    selectedProjectIds.map(async projectId => ({
      projectId,
      credentialConfigured: await tc.credentials.configured(projectId, source),
      scopeConfigured: (() => {
        const config = tc.store.projectConfig(
          projectId,
          DEFAULT_PROJECT_CONFIG
        );
        return source === 'linear'
          ? Boolean(config.linearTeamKey)
          : Boolean(config.jiraBaseUrl && config.jiraEmail);
      })()
    }))
  );
  const unavailableProjectIds = connectorStates
    .filter(entry => !entry.credentialConfigured || !entry.scopeConfigured)
    .map(entry => entry.projectId);

  if (selectedProjectIds.length !== 1) {
    await migrateAmbiguousLegacyCredential(
      tc,
      source,
      selectedProjectIds,
      unavailableProjectIds
    );
    return;
  }
  await migrateSelectedLegacyCredential(
    tc,
    source,
    selectedProjectIds[0]!,
    unavailableProjectIds
  );
}

export async function migrateLegacyCredentials(
  tc: TaskboardContext
): Promise<void> {
  await withExclusiveMigration(tc, async () => {
    const liveProjectIds = new Set(
      (await listProjects(tc)).map(project => project.id)
    );
    for (const source of CREDENTIAL_SOURCES) {
      await migrateLegacyCredential(tc, source, liveProjectIds);
    }
  });
}
