import type { BbPluginApi } from '@get-bb/plugin-sdk';
import type {
  ExternalWorkItemDetail,
  ExternalWorkStatusOption
} from '../types.js';
import { parseLocator, toItem } from './mapping.js';
import { detailOutputSchema } from './schemas.js';
import { githubReposForProject, loadGithubStatus } from './status.js';

export interface GithubScope {
  bb: BbPluginApi;
  projectId: string;
  runGithubCli: (args: string[], timeoutMs?: number) => Promise<string>;
}

export async function scopedIssue(
  { bb, projectId }: GithubScope,
  locator: string
): Promise<ExternalWorkItemDetail> {
  const { repo, number } = parseLocator(locator);
  const status = await loadGithubStatus(bb);
  if (!status.ghOk) {
    throw new Error(status.ghError ?? 'GitHub is not authenticated');
  }
  if (!githubReposForProject(status, projectId).includes(repo)) {
    throw new Error(
      `GitHub repository ${repo} is not mapped to BB project ${projectId}`
    );
  }
  const result = await bb.sdk.plugins.callRpc({
    pluginId: 'github',
    method: 'getIssue',
    input: { repo, number },
    outputSchema: detailOutputSchema
  });
  if (result.issue.repo !== repo || result.issue.number !== number) {
    throw new Error(`GitHub returned the wrong issue for ${locator}`);
  }
  return toItem({ ...result.issue, kind: 'issue' }, result.issue.comments);
}

export async function statusOptions(
  scope: GithubScope,
  locator: string
): Promise<ExternalWorkStatusOption[]> {
  const issue = await scopedIssue(scope, locator);
  const current = issue.status.toLowerCase() === 'open' ? 'open' : 'closed';
  return [
    {
      id: 'open',
      name: 'Open',
      stateCategory: 'todo',
      current: current === 'open'
    },
    {
      id: 'closed',
      name: 'Closed',
      stateCategory: 'done',
      current: current === 'closed'
    }
  ];
}

export async function assertMappedRepository(
  { bb, projectId }: GithubScope,
  repo: string
): Promise<void> {
  const status = await loadGithubStatus(bb);
  if (!status.ghOk) {
    throw new Error(status.ghError ?? 'GitHub is not authenticated');
  }
  if (!githubReposForProject(status, projectId).includes(repo)) {
    throw new Error(
      `GitHub repository ${repo} is not mapped to this BB project`
    );
  }
}
