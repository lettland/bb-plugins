import { PLUGIN_CLI_OUTPUT_MAX_BYTES } from '@get-bb/plugin-sdk';
import {
  escapeExternalJsonOutput,
  sourceName,
  type ProjectConfigView
} from '../contract.js';

export function formatFilterPresetCliJson(value: unknown): string {
  const output = escapeExternalJsonOutput(JSON.stringify(value));
  if (new TextEncoder().encode(output).byteLength > PLUGIN_CLI_OUTPUT_MAX_BYTES) {
    throw new Error('Filter preset output exceeds the plugin CLI limit');
  }
  return output;
}

export function formatProjectConfig(config: ProjectConfigView): string {
  return [
    `Project\t${config.projectId}`,
    `Source\t${sourceName(config.source)}`,
    `GitHub repos\t${config.githubRepos.join(', ') || 'none mapped'}`,
    `Linear team\t${config.linearTeamKey || 'not configured'}`,
    `Linear credential\t${config.linearCredentialConfigured ? 'configured' : 'not configured'}`,
    `Jira URL\t${config.jiraBaseUrl || 'not configured'}`,
    `Jira email\t${config.jiraEmail || 'not configured'}`,
    `Jira credential\t${config.jiraCredentialConfigured ? 'configured' : 'not configured'}`,
    `Jira JQL\t${config.jiraJql}`
  ].join('\n');
}

export function formatCredentialStatus(config: ProjectConfigView): string {
  return [
    `Project\t${config.projectId}`,
    `Linear credential\t${config.linearCredentialConfigured ? 'configured' : 'not configured'}`,
    `Jira credential\t${config.jiraCredentialConfigured ? 'configured' : 'not configured'}`
  ].join('\n');
}

export function credentialStatus(config: ProjectConfigView) {
  return {
    projectId: config.projectId,
    linearCredentialConfigured: config.linearCredentialConfigured,
    jiraCredentialConfigured: config.jiraCredentialConfigured
  };
}
