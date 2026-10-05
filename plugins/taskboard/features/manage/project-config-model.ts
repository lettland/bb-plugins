import {
  type ProjectConfigView,
  type SecretMutation,
  type WorkSource
} from '../../contract.js';
import { jiraBaseUrlSchema } from '../../credential-contract.js';

export const TRACKER_OPTIONS: ReadonlyArray<{
  source: WorkSource;
  description: string;
}> = [
  { source: 'github', description: 'Repository issues' },
  { source: 'linear', description: 'Team issues' },
  { source: 'jira', description: 'JQL-filtered issues' }
];

export function configFingerprint(config: ProjectConfigView): string {
  return JSON.stringify({
    source: config.source,
    linearTeamKey: config.linearTeamKey,
    jiraBaseUrl: config.jiraBaseUrl,
    jiraEmail: config.jiraEmail,
    jiraJql: config.jiraJql
  });
}

export function secretMutation(value: string, remove: boolean): SecretMutation {
  if (value.trim()) return { operation: 'set', value: value.trim() };
  return remove ? { operation: 'clear' } : { operation: 'keep' };
}

type ProjectConfigValidation =
  | { error: string }
  | { error: null; jiraBaseUrl: string };

export function validateProjectConfig({
  config,
  baseline,
  linearCredential,
  jiraCredential
}: {
  config: ProjectConfigView;
  baseline: ProjectConfigView;
  linearCredential: SecretMutation;
  jiraCredential: SecretMutation;
}): ProjectConfigValidation {
  const linearWillBeConfigured =
    linearCredential.operation === 'set' ||
    (baseline.linearCredentialConfigured &&
      linearCredential.operation === 'keep');
  const jiraWillBeConfigured =
    jiraCredential.operation === 'set' ||
    (baseline.jiraCredentialConfigured && jiraCredential.operation === 'keep');

  if (config.source === 'linear') {
    if (!config.linearTeamKey.trim()) {
      return { error: 'Add a Linear team key for this project.' };
    }
    if (!linearWillBeConfigured && linearCredential.operation !== 'clear') {
      return { error: 'Add a Linear API key for this project.' };
    }
  }
  const parsedUrl = jiraBaseUrlSchema.safeParse(config.jiraBaseUrl.trim());
  if (!parsedUrl.success) {
    return { error: 'Jira URL must be an HTTPS atlassian.net origin.' };
  }
  const jiraBaseUrl = parsedUrl.data;
  const jiraIdentityChanged =
    jiraBaseUrl !== baseline.jiraBaseUrl ||
    config.jiraEmail.trim() !== baseline.jiraEmail;
  if (config.source === 'jira') {
    if (!config.jiraEmail.trim()) {
      return { error: 'Add the Jira account email for this project.' };
    }
    if (!config.jiraJql.trim()) {
      return { error: 'Add a Jira JQL query for this project.' };
    }
    if (!jiraWillBeConfigured && jiraCredential.operation !== 'clear') {
      return { error: 'Add a Jira API token for this project.' };
    }
  }
  if (
    jiraIdentityChanged &&
    baseline.jiraCredentialConfigured &&
    jiraCredential.operation === 'keep'
  ) {
    return {
      error:
        'Changing the Jira site or email requires a replacement token or explicit credential removal.'
    };
  }
  return { error: null, jiraBaseUrl };
}
