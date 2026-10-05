import {
  FILTER_PRESET_STATE_JSON_MAX_LENGTH,
  type FilterPreset,
  type WorkItemFilterField,
  type WorkSource
} from '../contract.js';

export interface ParsedCliArguments {
  positionals: string[];
  projectId: string | undefined;
  source: string | undefined;
  query: string | undefined;
  linearTeam: string | undefined;
  jiraUrl: string | undefined;
  jiraEmail: string | undefined;
  jiraJql: string | undefined;
  statusId: string | undefined;
  preset: string | undefined;
  fromState: string | undefined;
  json: boolean;
  cached: boolean;
}

type ValueOptionField = Exclude<
  keyof ParsedCliArguments,
  'positionals' | 'json' | 'cached'
>;

const CLI_OPTIONS_BY_COMMAND = new Map<string, ReadonlySet<string>>([
  ['status', new Set(['--project', '--json'])],
  [
    'list',
    new Set([
      '--project',
      '--source',
      '--query',
      '--preset',
      '--cached',
      '--json'
    ])
  ],
  ['show', new Set(['--project', '--json'])],
  ['refresh', new Set(['--project', '--json'])],
  ['transitions', new Set(['--project', '--json'])],
  ['move', new Set(['--project', '--status', '--json'])],
  [
    'config',
    new Set([
      '--project',
      '--source',
      '--linear-team',
      '--jira-url',
      '--jira-email',
      '--jira-jql',
      '--json'
    ])
  ],
  ['credentials', new Set(['--project', '--json'])],
  ['presets', new Set(['--project', '--from-state', '--json'])]
]);

const VALUE_OPTION_FIELDS = new Map<string, ValueOptionField>([
  ['--project', 'projectId'],
  ['--source', 'source'],
  ['--query', 'query'],
  ['--linear-team', 'linearTeam'],
  ['--jira-url', 'jiraUrl'],
  ['--jira-email', 'jiraEmail'],
  ['--jira-jql', 'jiraJql'],
  ['--status', 'statusId'],
  ['--preset', 'preset'],
  ['--from-state', 'fromState']
]);

function valueAfter(argv: string[], flag: string, index: number): string {
  const value = argv[index + 1];
  if (
    value === undefined ||
    value.startsWith('--') ||
    (value.length === 0 &&
      !['--linear-team', '--jira-url', '--jira-email', '--query'].includes(
        flag
      ))
  ) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

export function parseTaskboardCliArguments(
  command: string,
  argv: string[]
): ParsedCliArguments {
  const allowedOptions = CLI_OPTIONS_BY_COMMAND.get(command);
  if (!allowedOptions) throw new Error('Unknown bb taskboard command');

  const parsed: ParsedCliArguments = {
    positionals: [],
    projectId: undefined,
    source: undefined,
    query: undefined,
    linearTeam: undefined,
    jiraUrl: undefined,
    jiraEmail: undefined,
    jiraJql: undefined,
    statusId: undefined,
    preset: undefined,
    fromState: undefined,
    json: false,
    cached: false
  };
  const seenOptions = new Set<string>();

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (!argument.startsWith('--')) {
      parsed.positionals.push(argument);
      continue;
    }
    if (!allowedOptions.has(argument)) {
      throw new Error('Unsupported bb taskboard option');
    }
    if (seenOptions.has(argument)) {
      throw new Error(`${argument} may only be provided once`);
    }
    seenOptions.add(argument);
    if (argument === '--json') {
      parsed.json = true;
    } else if (argument === '--cached') {
      parsed.cached = true;
    } else {
      const field = VALUE_OPTION_FIELDS.get(argument);
      if (!field) continue;
      const value = valueAfter(argv, argument, index);
      if (
        field === 'fromState' &&
        value.length > FILTER_PRESET_STATE_JSON_MAX_LENGTH
      ) {
        throw new Error('--from-state is too large');
      }
      parsed[field] = value;
      index += 1;
    }
  }

  if (
    command === 'presets' &&
    parsed.fromState !== undefined &&
    (parsed.positionals[0] ?? 'list') !== 'save'
  ) {
    throw new Error('--from-state is only valid with presets save');
  }

  return parsed;
}

export function resolvePresetListSelection(
  preset: FilterPreset | undefined,
  explicitSource: WorkSource | undefined,
  explicitQuery: string | undefined,
  enabledFilters: readonly WorkItemFilterField[]
) {
  const enabled = new Set(enabledFilters);
  const presetSource =
    preset && preset.state.source !== 'all'
      ? preset.state.source
      : undefined;
  return {
    source: explicitSource ?? presetSource,
    query: explicitQuery ?? preset?.state.query,
    stateCategories:
      preset && enabled.has('state') ? preset.state.stateCategories : [],
    attributeFilters: preset
      ? {
          statuses: enabled.has('status') ? preset.state.statuses : [],
          assignees: enabled.has('assignee') ? preset.state.assignees : [],
          priorities: enabled.has('priority')
            ? preset.state.priorities
            : [],
          projects: enabled.has('project')
            ? preset.state.externalProjects
            : [],
          labels: enabled.has('labels') ? preset.state.labels : []
        }
      : null
  };
}
