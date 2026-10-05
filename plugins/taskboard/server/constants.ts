import type { CredentialSource } from '../credentials.js';
import type { ProjectSourceConfig, WorkSource } from '../contract.js';

export const SOURCES: readonly WorkSource[] = ['linear', 'github', 'jira'];
export const CREDENTIAL_SOURCES: readonly CredentialSource[] = [
  'linear',
  'jira'
];
export const SYNC_INTERVAL_MS = 5 * 60_000;
export const KEEP_SECRET = { operation: 'keep' } as const;
export const DEFAULT_PROJECT_CONFIG = {
  source: 'github',
  linearTeamKey: '',
  jiraBaseUrl: '',
  jiraEmail: '',
  jiraJql:
    'assignee = currentUser() AND resolution = Unresolved ORDER BY updated DESC'
} satisfies Omit<ProjectSourceConfig, 'projectId'>;
