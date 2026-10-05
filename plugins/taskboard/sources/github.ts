import type { BbPluginApi } from '@get-bb/plugin-sdk';
import type {
  ExternalWorkItemCreateInput,
  WorkSourceAdapter
} from './types.js';
import { withoutComments } from './types.js';
import { refreshGithubCache } from './github/cache.js';
import { runGh } from './github/cli.js';
import { createIssue } from './github/create.js';
import {
  scopedIssue,
  statusOptions,
  type GithubScope
} from './github/issues.js';
import { toItem, parseLocator } from './github/mapping.js';
import { createMetadata } from './github/metadata.js';
import { listOutputSchema, okOutputSchema } from './github/schemas.js';
import {
  githubReposForProject,
  loadGithubStatus
} from './github/status.js';

export { githubStatusOutputSchema } from './github/schemas.js';
export type { GithubStatus } from './github/schemas.js';
export { githubReposForProject, loadGithubStatus };

export function createGithubAdapter(
  bb: BbPluginApi,
  enabled: boolean,
  projectId: string,
  runGithubCli: (args: string[], timeoutMs?: number) => Promise<string> = runGh
): WorkSourceAdapter {
  const scope: GithubScope = { bb, projectId, runGithubCli };

  return {
    source: 'github',
    configured: () => enabled,
    configurationMessage: () =>
      enabled ? null : 'Enable GitHub in Taskboard settings.',
    async list(options) {
      if (!enabled) throw new Error('GitHub is disabled');
      if (options?.refresh) await refreshGithubCache(bb);
      const status = await loadGithubStatus(bb);
      if (!status.ghOk) {
        throw new Error(status.ghError ?? 'GitHub is not authenticated');
      }
      const repos = githubReposForProject(status, projectId);
      const results = await Promise.all(
        repos.map(async repo => ({
          repo,
          result: await bb.sdk.plugins.callRpc({
            pluginId: 'github',
            method: 'listItems',
            input: { kind: 'issue', repo },
            outputSchema: listOutputSchema
          })
        }))
      );
      return results.flatMap(({ repo, result }) =>
        result.items.map(item => {
          if (item.repo !== repo || item.kind !== 'issue') {
            throw new Error(
              `GitHub returned an item outside requested repository ${repo}`
            );
          }
          return withoutComments(toItem(item));
        })
      );
    },
    async get(locator) {
      if (!enabled) throw new Error('GitHub is disabled');
      return scopedIssue(scope, locator);
    },
    async statusOptions(locator) {
      if (!enabled) throw new Error('GitHub is disabled');
      return statusOptions(scope, locator);
    },
    async createMetadata(input) {
      if (!enabled) throw new Error('GitHub is disabled');
      return createMetadata(scope, input);
    },
    async create(input: ExternalWorkItemCreateInput) {
      if (!enabled) throw new Error('GitHub is disabled');
      return createIssue(scope, input);
    },
    async updateStatus(locator, statusId) {
      if (!enabled) throw new Error('GitHub is disabled');
      const available = await statusOptions(scope, locator);
      const target = available.find(option => option.id === statusId);
      if (!target) {
        throw new Error('GitHub status is not available for this issue');
      }
      if (!target.current) {
        const { repo, number } = parseLocator(locator);
        await bb.sdk.plugins.callRpc({
          pluginId: 'github',
          method: 'setIssueState',
          input: { repo, number, state: statusId },
          outputSchema: okOutputSchema
        });
      }
      return scopedIssue(scope, locator);
    }
  };
}
