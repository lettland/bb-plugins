import type { PluginCliContext, PluginCliResult } from '@get-bb/plugin-sdk';
import {
  escapeExternalInlineText,
  filterPresetStateSchema
} from '../contract.js';
import type { ParsedCliArguments } from './cli-args.js';
import { formatFilterPresetCliJson } from './cli-format.js';
import { requireProject } from './cli-shared.js';
import type { TaskboardContext } from './context.js';
import {
  publishFilterPresetsChanged,
  resolvePresetByName,
  saveFilterPresetLinearized
} from './presets.js';

interface PresetCommand {
  tc: TaskboardContext;
  projectId: string;
  rest: string[];
  args: ParsedCliArguments;
}

type PresetVerbRunner = (command: PresetCommand) => Promise<PluginCliResult>;

function requirePresetArguments(rest: string[], count: number, usage: string) {
  if (rest.length !== count) {
    throw new Error(
      `Usage: bb taskboard presets ${usage} [--project <proj_id>] [--json]`
    );
  }
}

function presetResult(
  args: ParsedCliArguments,
  payload: unknown,
  text: string
): PluginCliResult {
  return {
    exitCode: 0,
    stdout: args.json ? formatFilterPresetCliJson(payload) : text
  };
}

async function listPresets(
  command: PresetCommand
): Promise<PluginCliResult> {
  const { tc, projectId, rest, args } = command;
  requirePresetArguments(rest, 0, 'list');
  const presets = tc.store.listFilterPresets(projectId);
  return presetResult(
    args,
    { presets },
    presets.length > 0
      ? presets.map(item => escapeExternalInlineText(item.name)).join('\n')
      : 'This project has no filter presets.'
  );
}

async function savePreset(
  command: PresetCommand
): Promise<PluginCliResult> {
  const { tc, projectId, rest, args } = command;
  if (rest.length !== 1 || !args.fromState) {
    throw new Error(
      'Usage: bb taskboard presets save <name> ' +
        '--from-state <json> [--project <proj_id>] [--json]'
    );
  }
  let fromStateJson: unknown;
  try {
    fromStateJson = JSON.parse(args.fromState);
  } catch {
    throw new Error('--from-state must be valid JSON');
  }
  const parsedState = filterPresetStateSchema.safeParse(fromStateJson);
  if (!parsedState.success) {
    throw new Error(
      '--from-state is not a valid project browse preference state'
    );
  }
  const { preset } = await saveFilterPresetLinearized(tc, {
    projectId,
    name: rest[0]!,
    state: parsedState.data
  });
  return presetResult(
    args,
    { preset },
    `Saved preset "${escapeExternalInlineText(preset.name)}"`
  );
}

async function renamePreset(
  command: PresetCommand
): Promise<PluginCliResult> {
  const { tc, projectId, rest, args } = command;
  requirePresetArguments(rest, 2, 'rename <name> <new-name>');
  const existing = resolvePresetByName(tc, projectId, rest[0]!);
  const { preset } = await saveFilterPresetLinearized(tc, {
    projectId,
    id: existing.id,
    name: rest[1]!,
    state: existing.state
  });
  return presetResult(
    args,
    { preset },
    `Renamed preset "${escapeExternalInlineText(existing.name)}" to "${escapeExternalInlineText(preset.name)}"`
  );
}

async function deletePreset(
  command: PresetCommand
): Promise<PluginCliResult> {
  const { tc, projectId, rest, args } = command;
  requirePresetArguments(rest, 1, 'delete <name>');
  const existing = resolvePresetByName(tc, projectId, rest[0]!);
  const presets = tc.store.deleteFilterPreset(projectId, existing.id);
  publishFilterPresetsChanged(tc, projectId);
  return presetResult(
    args,
    { presets },
    `Deleted preset "${escapeExternalInlineText(existing.name)}"`
  );
}

const PRESET_VERBS = new Map<string, PresetVerbRunner>([
  ['list', listPresets],
  ['save', savePreset],
  ['rename', renamePreset],
  ['delete', deletePreset]
]);

export async function runPresets(
  tc: TaskboardContext,
  args: ParsedCliArguments,
  cli: PluginCliContext
): Promise<PluginCliResult> {
  const verb = args.positionals[0] ?? 'list';
  const rest = args.positionals.slice(1);
  const runVerb = PRESET_VERBS.get(verb);
  if (!runVerb) {
    throw new Error('Usage: bb taskboard presets <list|save|rename|delete> ...');
  }
  const project = await requireProject(tc, args, cli);
  return runVerb({ tc, projectId: project.id, rest, args });
}
