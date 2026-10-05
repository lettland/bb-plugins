import type { PluginCliContext, PluginCliResult } from '@get-bb/plugin-sdk';
import { filterWorkItemsByAttributes } from '../browse.js';
import {
  escapeExternalInlineText,
  escapeExternalJsonOutput,
  formatWorkItemContext,
  sourceName,
  type WorkItem,
  type WorkSource
} from '../contract.js';
import { assertSelectedSourceAfterMutations, statuses } from './adapters.js';
import { resolvePresetListSelection, type ParsedCliArguments } from './cli-args.js';
import {
  SOURCE_ERROR,
  parseOptionalSource,
  parseRequiredSource,
  requireProject
} from './cli-shared.js';
import { USAGE } from './cli-usage.js';
import type { TaskboardContext } from './context.js';
import { getLiveItem, liveStatusOptions, updateItemStatus } from './items.js';
import {
  assertPresetProviderIsCurrent,
  resolvePresetByName
} from './presets.js';
import { syncAll } from './sync.js';
import { refreshedItemCount } from './util.js';

export async function runStatus(
  tc: TaskboardContext,
  args: ParsedCliArguments,
  cli: PluginCliContext
): Promise<PluginCliResult> {
  if (args.positionals.length > 0) {
    throw new Error(`Usage: ${USAGE.status}`);
  }
  const project = await requireProject(tc, args, cli);
  const result = {
    projectId: project.id,
    sources: await statuses(tc, project.id)
  };
  return {
    exitCode: 0,
    stdout: args.json
      ? JSON.stringify(result, null, 2)
      : result.sources
          .map(
            entry =>
              `${sourceName(entry.source)}\t${entry.available ? 'ready' : entry.configured ? 'unavailable' : 'not configured'}\t${entry.message ?? ''}`
          )
          .join('\n')
  };
}

export async function runRefresh(
  tc: TaskboardContext,
  args: ParsedCliArguments,
  cli: PluginCliContext
): Promise<PluginCliResult> {
  if (args.positionals.length > 1) {
    throw new Error(`Usage: ${USAGE.refresh}`);
  }
  const project = await requireProject(tc, args, cli);
  const source = parseOptionalSource(args.positionals[0], SOURCE_ERROR);
  const sources = await syncAll(tc, project.id, source, true);
  const result = {
    projectId: project.id,
    sources,
    itemCount: refreshedItemCount(sources, source)
  };
  const failures = source
    ? sources.filter(entry => entry.source === source && !entry.available)
    : sources.filter(entry => entry.configured && !entry.available);
  if (failures.length > 0) {
    return {
      exitCode: 1,
      stderr: `${failures
        .map(
          entry =>
            `${sourceName(entry.source)} refresh failed: ${entry.message ?? 'connector unavailable'}`
        )
        .join('\n')}\n`
    };
  }
  return {
    exitCode: 0,
    stdout: args.json
      ? JSON.stringify(result, null, 2)
      : `Refreshed ${result.itemCount} work items for ${project.id}.`
  };
}

async function selectListItems(
  tc: TaskboardContext,
  args: ParsedCliArguments,
  projectId: string,
  explicitSource: WorkSource | undefined
): Promise<WorkItem[]> {
  // Explicit --source/--query flags beat a --preset's saved values;
  // a preset source of "all" means the preset applies no filter.
  const preset = args.preset
    ? resolvePresetByName(tc, projectId, args.preset)
    : undefined;
  if (preset) {
    await assertPresetProviderIsCurrent(tc, projectId, preset);
  }
  const selection = resolvePresetListSelection(
    preset,
    explicitSource,
    args.query,
    tc.store.projectBoardSettings(projectId).enabledFilters
  );
  const { source, query } = selection;
  if (source) {
    await assertSelectedSourceAfterMutations(tc, projectId, source);
  }
  if (!args.cached) await syncAll(tc, projectId, source, true);
  // Sync may wait behind a project reconfiguration. Recheck the
  // preset's provider at the read boundary so old-provider facets can
  // never filter a freshly switched provider's items.
  if (preset) {
    await assertPresetProviderIsCurrent(tc, projectId, preset);
  }
  const items = tc.store.list({
    projectId,
    ...(source ? { source } : {}),
    ...(query ? { query } : {}),
    ...(selection.stateCategories.length > 0
      ? { stateCategories: selection.stateCategories }
      : {}),
    limit: 500
  });
  return (
    selection.attributeFilters
      ? filterWorkItemsByAttributes(items, selection.attributeFilters)
      : items
  ).slice(0, 200);
}

export async function runList(
  tc: TaskboardContext,
  args: ParsedCliArguments,
  cli: PluginCliContext
): Promise<PluginCliResult> {
  if (args.positionals.length > 0) {
    throw new Error(`Usage: ${USAGE.list}`);
  }
  const explicitSource = parseOptionalSource(args.source, SOURCE_ERROR);
  const project = await requireProject(tc, args, cli);
  const narrowedItems = await selectListItems(
    tc,
    args,
    project.id,
    explicitSource
  );
  return {
    exitCode: 0,
    stdout: args.json
      ? escapeExternalJsonOutput(
          JSON.stringify({ items: narrowedItems }, null, 2)
        )
      : narrowedItems
          .map(
            item =>
              `${escapeExternalInlineText(item.bbProjectId)}\t${sourceName(item.source)}\t${escapeExternalInlineText(item.key)}\t${escapeExternalInlineText(item.status)}\t${escapeExternalInlineText(item.assignee ?? '-')}\t${escapeExternalInlineText(item.title)}`
          )
          .join('\n')
  };
}

async function resolveItemTarget(
  tc: TaskboardContext,
  args: ParsedCliArguments,
  cli: PluginCliContext,
  usage: string
): Promise<{ projectId: string; source: WorkSource; locator: string }> {
  if (args.positionals.length !== 2) throw new Error(`Usage: ${usage}`);
  const project = await requireProject(tc, args, cli);
  const source = parseRequiredSource(args.positionals[0]);
  return { projectId: project.id, source, locator: args.positionals[1]! };
}

function itemResult(
  args: ParsedCliArguments,
  item: WorkItem
): PluginCliResult {
  return {
    exitCode: 0,
    stdout: args.json
      ? escapeExternalJsonOutput(JSON.stringify({ item }, null, 2))
      : formatWorkItemContext(item)
  };
}

export async function runShow(
  tc: TaskboardContext,
  args: ParsedCliArguments,
  cli: PluginCliContext
): Promise<PluginCliResult> {
  const { projectId, source, locator } = await resolveItemTarget(
    tc,
    args,
    cli,
    USAGE.show
  );
  return itemResult(args, await getLiveItem(tc, projectId, source, locator));
}

export async function runTransitions(
  tc: TaskboardContext,
  args: ParsedCliArguments,
  cli: PluginCliContext
): Promise<PluginCliResult> {
  const { projectId, source, locator } = await resolveItemTarget(
    tc,
    args,
    cli,
    USAGE.transitions
  );
  const options = await liveStatusOptions(tc, projectId, source, locator);
  return {
    exitCode: 0,
    stdout: args.json
      ? escapeExternalJsonOutput(
          JSON.stringify(
            { projectId, source, locator, options },
            null,
            2
          )
        )
      : options
          .map(
            option =>
              `${escapeExternalInlineText(option.id)}\t${escapeExternalInlineText(option.name)}\t${option.stateCategory}\t${option.current ? 'current' : 'available'}`
          )
          .join('\n')
  };
}

export async function runMove(
  tc: TaskboardContext,
  args: ParsedCliArguments,
  cli: PluginCliContext
): Promise<PluginCliResult> {
  if (!args.statusId) throw new Error(`Usage: ${USAGE.move}`);
  const { projectId, source, locator } = await resolveItemTarget(
    tc,
    args,
    cli,
    USAGE.move
  );
  return itemResult(
    args,
    await updateItemStatus(tc, projectId, source, locator, args.statusId)
  );
}
