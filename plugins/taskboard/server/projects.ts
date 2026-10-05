import type {
  ProjectConfigView,
  ProjectSourceConfig,
  TrackerProject
} from '../contract.js';
import {
  githubReposForProject,
  githubStatusOutputSchema
} from '../sources/github.js';
import { DEFAULT_PROJECT_CONFIG, SOURCES } from './constants.js';
import type { TaskboardContext } from './context.js';
import { waitForMutations } from './mutations.js';
import { revisionSnapshot, type SourceRevisionSnapshot } from './revisions.js';
import { parseGithubRepoFromRemote } from './util.js';

async function liveProjects(tc: TaskboardContext) {
  return tc.bb.sdk.projects.list({ includePersonal: true });
}

export async function listProjects(
  tc: TaskboardContext
): Promise<TrackerProject[]> {
  const projects = await liveProjects(tc);
  return projects
    .map(project => ({ id: project.id, name: project.name }))
    .sort(
      (left, right) =>
        left.name.localeCompare(right.name) || left.id.localeCompare(right.id)
    );
}

export async function projectById(
  tc: TaskboardContext,
  projectId: string
): Promise<TrackerProject> {
  const projects = await listProjects(tc);
  const project = projects.find(entry => entry.id === projectId);
  if (!project) throw new Error('BB project was not found');
  return project;
}

export async function assertProjectExists(
  tc: TaskboardContext,
  projectId: string
): Promise<void> {
  await projectById(tc, projectId);
}

export function projectConfig(
  tc: TaskboardContext,
  projectId: string,
  ensure: boolean
): ProjectSourceConfig {
  return ensure
    ? tc.store.ensureProjectConfig(projectId, DEFAULT_PROJECT_CONFIG)
    : tc.store.projectConfig(projectId, DEFAULT_PROJECT_CONFIG);
}

async function fallbackGithubRepos(
  tc: TaskboardContext,
  projectId: string
): Promise<string[]> {
  const project = (await liveProjects(tc)).find(
    entry => entry.id === projectId
  );
  const repo = parseGithubRepoFromRemote(
    typeof project === 'object' &&
      project !== null &&
      'gitRemoteUrl' in project &&
      typeof project.gitRemoteUrl === 'string'
      ? project.gitRemoteUrl
      : null
  );
  return repo ? [repo] : [];
}

export async function buildProjectConfigView(
  tc: TaskboardContext,
  config: ProjectSourceConfig
): Promise<ProjectConfigView> {
  const [linearCredentialConfigured, jiraCredentialConfigured, githubRepos] =
    await Promise.all([
      tc.credentials.configured(config.projectId, 'linear'),
      tc.credentials.configured(config.projectId, 'jira'),
      tc.bb.sdk.plugins
        .callRpc({
          pluginId: 'github',
          method: 'status',
          input: null,
          outputSchema: githubStatusOutputSchema
        })
        .then(status => githubReposForProject(status, config.projectId))
        .catch(() => fallbackGithubRepos(tc, config.projectId))
    ]);
  return {
    ...config,
    githubRepos,
    linearCredentialConfigured,
    jiraCredentialConfigured
  };
}

export async function readConsistentProjectConfigView(
  tc: TaskboardContext,
  projectId: string,
  ensure = false
): Promise<{
  config: ProjectConfigView;
  revisions: SourceRevisionSnapshot;
}> {
  for (;;) {
    await waitForMutations(tc, projectId, SOURCES);
    const before = revisionSnapshot(tc, projectId);
    const config = await buildProjectConfigView(
      tc,
      projectConfig(tc, projectId, ensure)
    );
    const after = revisionSnapshot(tc, projectId);
    if (SOURCES.every(source => before[source] === after[source])) {
      return { config, revisions: after };
    }
  }
}

export async function readProjectConfigView(
  tc: TaskboardContext,
  projectId: string,
  ensure = false
): Promise<ProjectConfigView> {
  return (await readConsistentProjectConfigView(tc, projectId, ensure)).config;
}
