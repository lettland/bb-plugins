import { jiraProjectKeysFromJql } from '../jira-scope.js';

export function assertProjectKey(jql: string, destinationId: string): string {
  const projectKey = destinationId.trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9_-]*$/u.test(projectKey)) {
    throw new Error('Enter a valid Jira project key');
  }
  const configuredProjectKeys = jiraProjectKeysFromJql(jql);
  if (
    configuredProjectKeys.length > 0 &&
    !configuredProjectKeys.includes(projectKey)
  ) {
    throw new Error(
      `Jira project ${projectKey} is outside the configured JQL scope`
    );
  }
  return projectKey;
}
