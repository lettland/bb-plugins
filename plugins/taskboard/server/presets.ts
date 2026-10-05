import {
  normalizePresetName,
  sourceName,
  type FilterPreset
} from '../contract.js';
import { SOURCES } from './constants.js';
import type { TaskboardContext } from './context.js';
import { enqueueMutation, waitForMutations } from './mutations.js';
import { projectConfig } from './projects.js';

export function resolvePresetByName(
  tc: TaskboardContext,
  projectId: string,
  name: string
): FilterPreset {
  const presets = tc.store.listFilterPresets(projectId);
  const normalized = normalizePresetName(name);
  const match = presets.find(
    candidate => normalizePresetName(candidate.name) === normalized
  );
  if (match) return match;
  const available = presets.map(candidate => candidate.name).join(', ');
  throw new Error(
    available
      ? `Unknown filter preset "${name}". Available: ${available}`
      : `Unknown filter preset "${name}". This project has no presets.`
  );
}

export function publishFilterPresetsChanged(
  tc: TaskboardContext,
  projectId: string
): void {
  tc.bb.realtime.publish('taskboard:presets-changed', { projectId });
}

export async function assertPresetProviderIsCurrent(
  tc: TaskboardContext,
  projectId: string,
  preset: FilterPreset
): Promise<void> {
  await waitForMutations(tc, projectId, SOURCES);
  const provider = projectConfig(tc, projectId, true).source;
  if (preset.state.provider !== provider) {
    const savedProvider = preset.state.provider
      ? sourceName(preset.state.provider)
      : 'an unknown provider';
    throw new Error(
      `Filter preset "${preset.name}" was saved for ${savedProvider} but this project now uses ${sourceName(provider)}`
    );
  }
}

function assertPresetStateMatchesCurrentProvider(
  tc: TaskboardContext,
  projectId: string,
  state: FilterPreset['state']
): void {
  const provider = projectConfig(tc, projectId, true).source;
  if (state.provider !== provider) {
    throw new Error(
      `Preset provider must match this project's ${sourceName(provider)} provider`
    );
  }
}

function assertPresetWriteMatchesCurrentProvider(
  tc: TaskboardContext,
  projectId: string,
  id: string | undefined,
  state: FilterPreset['state']
): void {
  if (id) {
    const existing = tc.store
      .listFilterPresets(projectId)
      .find(preset => preset.id === id);
    if (!existing) throw new Error(`Unknown filter preset: ${id}`);
    if (JSON.stringify(existing.state) !== JSON.stringify(state)) {
      throw new Error('Renaming a filter preset cannot change its state');
    }
    return;
  }
  assertPresetStateMatchesCurrentProvider(tc, projectId, state);
}

export function saveFilterPresetLinearized(
  tc: TaskboardContext,
  input: {
    projectId: string;
    id?: string;
    name: string;
    state: FilterPreset['state'];
  }
): Promise<{ preset: FilterPreset; presets: FilterPreset[] }> {
  return enqueueMutation(tc, input.projectId, SOURCES, async () => {
    assertPresetWriteMatchesCurrentProvider(
      tc,
      input.projectId,
      input.id,
      input.state
    );
    const preset = tc.store.saveFilterPreset(input);
    const presets = tc.store.listFilterPresets(input.projectId);
    publishFilterPresetsChanged(tc, input.projectId);
    return { preset, presets };
  });
}
