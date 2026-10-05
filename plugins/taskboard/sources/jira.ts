import type {
  ExternalWorkItemCreateInput,
  WorkSourceAdapter
} from './types.js';
import { withoutComments } from './types.js';
import { createMetadata } from './jira/create-metadata.js';
import { createIssue } from './jira/create.js';
import {
  loadIssue,
  transitionOptions,
  type JiraScope
} from './jira/issues.js';
import { toItem } from './jira/mapping.js';
import { jiraRequest, normalizeBaseUrl } from './jira/request.js';
import { searchIssues } from './jira/search.js';

export function createJiraAdapter(options: {
  enabled: boolean;
  baseUrl: string;
  email: string;
  apiToken: string | undefined;
  jql: string;
}): WorkSourceAdapter {
  const rawBaseUrl = options.baseUrl.trim();
  const baseUrl = normalizeBaseUrl(options.baseUrl);
  const email = options.email.trim();
  const apiToken = options.apiToken?.trim() ?? '';
  const hasCredentials = Boolean(baseUrl && email && apiToken);
  const configured = options.enabled && hasCredentials;
  const scope: JiraScope = {
    auth: {
      baseUrl,
      email,
      apiToken
    },
    jql: options.jql
  };

  return {
    source: 'jira',
    configured: () => configured,
    configurationMessage: () =>
      !options.enabled
        ? 'Enable Jira for this BB project in Manage.'
        : rawBaseUrl && !baseUrl
          ? 'Jira Cloud URL must be an HTTPS atlassian.net origin.'
          : hasCredentials
            ? null
            : 'Set the Jira URL, email, and API token for this BB project in Manage.',
    async list() {
      if (!configured) throw new Error('Jira is not configured');
      const issues = await searchIssues(scope);
      return issues.map(issue => withoutComments(toItem(baseUrl, issue)));
    },
    async get(locator) {
      if (!configured) throw new Error('Jira is not configured');
      const issue = await loadIssue(scope, locator, {
        comments: true,
        verifyScope: true
      });
      return toItem(baseUrl, issue);
    },
    async statusOptions(locator) {
      if (!configured) throw new Error('Jira is not configured');
      const result = await transitionOptions(scope, locator);
      return result.options.map(
        ({ transitionId: _transitionId, ...option }) => option
      );
    },
    async createMetadata(input) {
      if (!configured) throw new Error('Jira is not configured');
      return createMetadata(scope, input);
    },
    async create(input: ExternalWorkItemCreateInput) {
      if (!configured) throw new Error('Jira is not configured');
      return createIssue(scope, baseUrl, input);
    },
    async updateStatus(locator, statusId) {
      if (!configured) throw new Error('Jira is not configured');
      const available = await transitionOptions(scope, locator);
      const target = available.options.find(option => option.id === statusId);
      if (!target) {
        throw new Error('Jira status is not available for this issue');
      }
      if (!target.current) {
        if (!target.transitionId) {
          throw new Error('Jira status does not have an available transition');
        }
        await jiraRequest(
          scope.auth,
          `/rest/api/3/issue/${encodeURIComponent(locator)}/transitions`,
          {
            method: 'POST',
            body: JSON.stringify({ transition: { id: target.transitionId } })
          }
        );
      }
      const issue = await loadIssue(scope, locator, {
        comments: false,
        verifyScope: false
      });
      if (issue.fields.status.id !== statusId) {
        throw new Error('Jira returned an invalid status update result');
      }
      return toItem(baseUrl, issue);
    }
  };
}
