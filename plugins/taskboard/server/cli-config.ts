import type { PluginCliContext, PluginCliResult } from '@get-bb/plugin-sdk';
import { projectCredentialsInteractionResponseSchema } from '../contract.js';
import type { ParsedCliArguments } from './cli-args.js';
import {
  credentialStatus,
  formatCredentialStatus,
  formatProjectConfig
} from './cli-format.js';
import { parseOptionalSource, requireProject } from './cli-shared.js';
import { USAGE } from './cli-usage.js';
import { persistProjectConfig } from './config.js';
import { KEEP_SECRET } from './constants.js';
import type { TaskboardContext } from './context.js';
import { readConsistentProjectConfigView } from './projects.js';

export async function runConfig(
  tc: TaskboardContext,
  args: ParsedCliArguments,
  cli: PluginCliContext
): Promise<PluginCliResult> {
  if (args.positionals.length > 0) {
    throw new Error(`Usage: ${USAGE.config}`);
  }
  const source = parseOptionalSource(
    args.source,
    '--source must be linear, github, or jira'
  );
  if (args.jiraJql !== undefined && !args.jiraJql.trim()) {
    throw new Error('--jira-jql requires a non-empty value');
  }
  const project = await requireProject(tc, args, cli);
  const snapshot = await readConsistentProjectConfigView(tc, project.id);
  const previous = snapshot.config;
  const changed =
    source !== undefined ||
    args.linearTeam !== undefined ||
    args.jiraUrl !== undefined ||
    args.jiraEmail !== undefined ||
    args.jiraJql !== undefined;
  const config = changed
    ? await persistProjectConfig(
        tc,
        {
          projectId: previous.projectId,
          source: source ?? previous.source,
          linearTeamKey: args.linearTeam ?? previous.linearTeamKey,
          jiraBaseUrl: args.jiraUrl ?? previous.jiraBaseUrl,
          jiraEmail: args.jiraEmail ?? previous.jiraEmail,
          jiraJql: args.jiraJql ?? previous.jiraJql,
          linearCredential: KEEP_SECRET,
          jiraCredential: KEEP_SECRET
        },
        { config: previous, revisions: snapshot.revisions }
      )
    : previous;
  return {
    exitCode: 0,
    stdout: args.json
      ? JSON.stringify({ config }, null, 2)
      : formatProjectConfig(config)
  };
}

export async function runCredentials(
  tc: TaskboardContext,
  args: ParsedCliArguments,
  cli: PluginCliContext
): Promise<PluginCliResult> {
  if (args.positionals.length > 0) {
    throw new Error(`Usage: ${USAGE.credentials}`);
  }
  if (!cli.threadId) {
    throw new Error(
      'bb taskboard credentials must run from an active BB thread'
    );
  }
  const project = await requireProject(tc, args, cli);
  const snapshot = await readConsistentProjectConfigView(tc, project.id);
  const previous = snapshot.config;
  const result = await tc.bb.ui.requestInput(
    {
      threadId: cli.threadId,
      rendererId: 'taskboard-credentials',
      title: `Manage credentials for ${project.name}`,
      payload: {
        projectId: project.id,
        projectName: project.name,
        linearTeamKey: previous.linearTeamKey,
        jiraBaseUrl: previous.jiraBaseUrl,
        jiraEmail: previous.jiraEmail,
        linearCredentialConfigured: previous.linearCredentialConfigured,
        jiraCredentialConfigured: previous.jiraCredentialConfigured
      }
    },
    { signal: cli.signal }
  );
  if (result.outcome === 'cancelled') {
    return {
      exitCode: 1,
      stderr: 'Credential update cancelled.\n'
    };
  }
  const parsedResponse = projectCredentialsInteractionResponseSchema.safeParse(
    result.value
  );
  if (!parsedResponse.success) {
    throw new Error('Credential form response was invalid');
  }
  const response = parsedResponse.data;
  const config = await persistProjectConfig(
    tc,
    {
      projectId: previous.projectId,
      source: previous.source,
      linearTeamKey: previous.linearTeamKey,
      jiraBaseUrl: previous.jiraBaseUrl,
      jiraEmail: previous.jiraEmail,
      jiraJql: previous.jiraJql,
      linearCredential: response.linearCredential,
      jiraCredential: response.jiraCredential
    },
    { config: previous, revisions: snapshot.revisions }
  );
  return {
    exitCode: 0,
    stdout: args.json
      ? JSON.stringify(credentialStatus(config), null, 2)
      : formatCredentialStatus(config)
  };
}
