import type {
  ExternalWorkItemCreateInput,
  WorkSourceAdapter
} from './types.js';
import { withoutComments } from './types.js';
import { createMetadata } from './linear/create-metadata.js';
import {
  createIssue,
  isOutsideTeam,
  listIssues,
  loadIssue,
  statusOptions,
  updateStatus,
  type LinearScope
} from './linear/issues.js';
import { toItem } from './linear/mapping.js';

export function createLinearAdapter(options: {
  enabled: boolean;
  apiKey: string | undefined;
  teamKey: string;
}): WorkSourceAdapter {
  const teamKey = options.teamKey.trim();
  const apiKey = options.apiKey?.trim() ?? '';
  const hasApiKey = Boolean(apiKey);
  const configured = options.enabled && hasApiKey && Boolean(teamKey);
  const scope: LinearScope = { apiKey, teamKey };

  return {
    source: 'linear',
    configured: () => configured,
    configurationMessage: () =>
      !options.enabled
        ? 'Enable Linear for this BB project in Manage.'
        : !teamKey
          ? 'Choose a Linear team key for this BB project in Manage.'
          : hasApiKey
            ? null
            : 'Add a Linear personal API key for this BB project in Manage.',
    async list() {
      if (!configured) throw new Error('Linear is not configured');
      const issues = await listIssues(scope);
      return issues.map(issue => withoutComments(toItem(issue)));
    },
    async get(locator) {
      if (!configured) throw new Error('Linear is not configured');
      return loadIssue(scope, locator);
    },
    async statusOptions(locator) {
      if (!configured) throw new Error('Linear is not configured');
      return statusOptions(scope, locator);
    },
    async createMetadata(input) {
      if (!configured) throw new Error('Linear is not configured');
      if (isOutsideTeam(scope, input.destinationId)) {
        throw new Error(
          `Linear team ${input.destinationId} is outside the configured scope`
        );
      }
      return createMetadata(apiKey, teamKey);
    },
    async create(input: ExternalWorkItemCreateInput) {
      if (!configured) throw new Error('Linear is not configured');
      return createIssue(scope, input);
    },
    async updateStatus(locator, statusId) {
      if (!configured) throw new Error('Linear is not configured');
      return updateStatus(scope, locator, statusId);
    }
  };
}
