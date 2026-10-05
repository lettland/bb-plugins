import type { PluginCliContext, PluginCliResult } from '@get-bb/plugin-sdk';
import { bbProjectIdSchema, workSourceSchema } from '../contract.js';
import type { TrackerProject, WorkSource } from '../contract.js';
import type { ParsedCliArguments } from './cli-args.js';
import type { TaskboardContext } from './context.js';
import { projectById } from './projects.js';

export type CliCommandRunner = (
  tc: TaskboardContext,
  args: ParsedCliArguments,
  cli: PluginCliContext
) => Promise<PluginCliResult>;

export const SOURCE_ERROR = 'Source must be linear, github, or jira';

export async function requireProject(
  tc: TaskboardContext,
  args: ParsedCliArguments,
  cli: PluginCliContext
): Promise<TrackerProject> {
  const parsedProject = bbProjectIdSchema.safeParse(
    args.projectId ?? cli.projectId
  );
  if (!parsedProject.success) {
    throw new Error(
      'Choose a BB project with --project <proj_id> or run this command from a project thread'
    );
  }
  return projectById(tc, parsedProject.data);
}

export function parseOptionalSource(
  value: string | undefined,
  message: string
): WorkSource | undefined {
  const parsed = value ? workSourceSchema.safeParse(value) : null;
  if (parsed && !parsed.success) throw new Error(message);
  return parsed?.data;
}

export function parseRequiredSource(value: string | undefined): WorkSource {
  const parsed = workSourceSchema.safeParse(value);
  if (!parsed.success) throw new Error(SOURCE_ERROR);
  return parsed.data;
}
