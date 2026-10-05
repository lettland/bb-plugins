import type { PluginCliCommandInfo } from '@get-bb/plugin-sdk';

export const USAGE = {
  status: 'bb taskboard status [--project <proj_id>] [--json]',
  list:
    'bb taskboard list [--project <proj_id>] ' +
    '[--source linear|github|jira] [--query <text>] ' +
    '[--preset <name>] [--cached] [--json]',
  show: 'bb taskboard show <linear|github|jira> <locator> [--project <proj_id>] [--json]',
  transitions:
    'bb taskboard transitions <linear|github|jira> <locator> [--project <proj_id>] [--json]',
  move: 'bb taskboard move <linear|github|jira> <locator> --status <id> [--project <proj_id>] [--json]',
  refresh:
    'bb taskboard refresh [linear|github|jira] [--project <proj_id>] [--json]',
  config:
    'bb taskboard config [--project <proj_id>] [--source linear|github|jira] [--linear-team <key>] [--jira-url <url>] [--jira-email <email>] [--jira-jql <text>] [--json]',
  credentials: 'bb taskboard credentials [--project <proj_id>] [--json]',
  presets:
    'bb taskboard presets list [--project <proj_id>] [--json]\n' +
    'bb taskboard presets save <name> --from-state <json> ' +
    '[--project <proj_id>] [--json]\n' +
    'bb taskboard presets rename <name> <new-name> ' +
    '[--project <proj_id>] [--json]\n' +
    'bb taskboard presets delete <name> ' +
    '[--project <proj_id>] [--json]'
} as const;

const COMMAND_SUMMARIES = [
  ['status', 'Show connector status for a BB project'],
  ['list', 'List cached project work, refreshing first by default'],
  ['show', 'Fetch one external issue in a BB project'],
  ['transitions', 'List valid status targets for one external issue'],
  ['move', 'Move one external issue to an exact listed status id'],
  ['refresh', "Refresh a BB project's external issue caches"],
  ['config', 'Show or update nonsecret project connector configuration'],
  ['credentials', 'Open a secure form for project connector credentials'],
  ['presets', 'List, save, rename, or delete project filter presets']
] as const;

export const CLI_COMMANDS: PluginCliCommandInfo[] = COMMAND_SUMMARIES.map(
  ([name, summary]) => ({ name, summary, usage: USAGE[name] })
);
