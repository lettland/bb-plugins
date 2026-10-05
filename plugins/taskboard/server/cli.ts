import { parseTaskboardCliArguments } from './cli-args.js';
import { runConfig, runCredentials } from './cli-config.js';
import { runPresets } from './cli-presets.js';
import {
  runList,
  runMove,
  runRefresh,
  runShow,
  runStatus,
  runTransitions
} from './cli-read.js';
import type { CliCommandRunner } from './cli-shared.js';
import { CLI_COMMANDS } from './cli-usage.js';
import type { TaskboardContext } from './context.js';
import { errorMessage } from './util.js';

const COMMAND_RUNNERS = new Map<string, CliCommandRunner>([
  ['status', runStatus],
  ['refresh', runRefresh],
  ['list', runList],
  ['show', runShow],
  ['transitions', runTransitions],
  ['move', runMove],
  ['config', runConfig],
  ['credentials', runCredentials],
  ['presets', runPresets]
]);

export function registerCli(tc: TaskboardContext): void {
  tc.bb.cli.register({
    name: 'taskboard',
    summary: 'Browse project-scoped Linear, GitHub, and Jira issues',
    commands: CLI_COMMANDS,
    async run(argv, cli) {
      try {
        const firstArgument = argv[0];
        const hasExplicitCommand = Boolean(
          firstArgument && !firstArgument.startsWith('--')
        );
        const command = hasExplicitCommand ? firstArgument! : 'status';
        const args = parseTaskboardCliArguments(
          command,
          hasExplicitCommand ? argv.slice(1) : argv
        );
        const runCommand = COMMAND_RUNNERS.get(command);
        if (!runCommand) throw new Error('Unknown bb taskboard command');
        return await runCommand(tc, args, cli);
      } catch (error) {
        return { exitCode: 1, stderr: `${errorMessage(error)}\n` };
      }
    }
  });
}
