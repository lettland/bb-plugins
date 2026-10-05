import type { BbPluginApi } from '@get-bb/plugin-sdk';
import { githubStatusOutputSchema, type GithubStatus } from './schemas.js';

export function loadGithubStatus(bb: BbPluginApi) {
  return bb.sdk.plugins.callRpc({
    pluginId: 'github',
    method: 'status',
    input: null,
    outputSchema: githubStatusOutputSchema
  });
}

export function githubReposForProject(
  status: GithubStatus,
  projectId: string
): string[] {
  return [
    ...new Set(
      status.repos
        .filter(repo => repo.projectId === projectId)
        .map(repo => repo.repo)
    )
  ];
}
