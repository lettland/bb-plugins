import { type Dispatch, type SetStateAction } from 'react';
import { useRpc } from '@get-bb/plugin-sdk/app';
import {
  type FilterPreset,
  type TaskboardRpcContract
} from '../../contract.js';
import { type ProjectFilterPresets } from './use-project-filter-presets.js';
import {
  type PresetFocus,
  type PresetMutationState
} from './use-preset-form-state.js';

export interface PresetActionContext {
  rpc: ReturnType<typeof useRpc<TaskboardRpcContract>>;
  projectId: string;
  presetState: ProjectFilterPresets;
  nameDrafts: Record<string, string>;
  setNameDrafts: Dispatch<SetStateAction<Record<string, string>>>;
  mutation: PresetMutationState;
  focus: PresetFocus;
}

export async function renamePreset(
  ctx: PresetActionContext,
  preset: FilterPreset
): Promise<void> {
  const { rpc, projectId, presetState, nameDrafts, setNameDrafts } = ctx;
  const { mutation, focus } = ctx;
  const name = (nameDrafts[preset.id] ?? preset.name).trim();
  if (name === preset.name) {
    setNameDrafts(current => ({ ...current, [preset.id]: preset.name }));
    return;
  }
  if (!name) {
    mutation.setMutationFeedback({
      kind: 'error',
      presetId: preset.id,
      message: `Rename "${preset.name}": preset names cannot be empty.`
    });
    return;
  }
  if (!mutation.beginMutation()) return;
  try {
    const result = await rpc.call('saveFilterPreset', {
      projectId,
      id: preset.id,
      name,
      state: preset.state
    });
    presetState.setAuthoritative(result.presets);
    mutation.setMutationFeedback({
      kind: 'status',
      message: `Renamed preset to "${result.preset.name}".`
    });
    focus.restorePresetFocus(preset.id);
  } catch (nextError) {
    mutation.reportMutationError(nextError, {
      presetId: preset.id,
      action: `Could not rename "${preset.name}"`
    });
    focus.restorePresetFocus(preset.id);
  } finally {
    mutation.finishMutation();
  }
}

export async function removePreset(
  ctx: PresetActionContext,
  preset: FilterPreset
): Promise<void> {
  const { rpc, projectId, presetState, mutation, focus } = ctx;
  if (mutation.mutationInFlightRef.current) return;
  if (!window.confirm(`Delete the preset "${preset.name}"?`)) return;
  if (!mutation.beginMutation()) return;
  const deletedIndex = presetState.presets.findIndex(
    candidate => candidate.id === preset.id
  );
  try {
    const result = await rpc.call('deleteFilterPreset', {
      projectId,
      id: preset.id
    });
    presetState.setAuthoritative(result.presets);
    mutation.setMutationFeedback({
      kind: 'status',
      message: `Deleted preset "${preset.name}".`
    });
    const focusTarget =
      result.presets[
        Math.min(Math.max(deletedIndex, 0), result.presets.length - 1)
      ];
    window.requestAnimationFrame(() => {
      const input = focusTarget
        ? focus.presetNameInputRefs.current.get(focusTarget.id)
        : undefined;
      (input ?? focus.headingRef.current)?.focus();
    });
  } catch (nextError) {
    mutation.reportMutationError(nextError, {
      action: `Could not delete "${preset.name}"`
    });
    focus.restorePresetFocus(preset.id, 'delete');
  } finally {
    mutation.finishMutation();
  }
}

export async function movePreset(
  ctx: PresetActionContext,
  preset: FilterPreset,
  delta: number
): Promise<void> {
  const { rpc, projectId, presetState, mutation, focus } = ctx;
  if (mutation.mutationInFlightRef.current) return;
  const ids = presetState.presets.map(candidate => candidate.id);
  const from = ids.indexOf(preset.id);
  const to = from + delta;
  if (from < 0 || to < 0 || to >= ids.length || !mutation.beginMutation()) {
    return;
  }
  const reordered = [...ids];
  const [moved] = reordered.splice(from, 1);
  if (!moved) {
    mutation.finishMutation();
    return;
  }
  reordered.splice(to, 0, moved);
  try {
    const result = await rpc.call('reorderFilterPresets', {
      projectId,
      ids: reordered
    });
    presetState.setAuthoritative(result.presets);
    mutation.setMutationFeedback({
      kind: 'status',
      message: `Moved preset "${preset.name}" ${delta < 0 ? 'up' : 'down'}.`
    });
    focus.restorePresetFocus(preset.id, delta < 0 ? 'move-up' : 'move-down');
  } catch (nextError) {
    mutation.reportMutationError(nextError, {
      action: `Could not move "${preset.name}"`
    });
    focus.restorePresetFocus(preset.id, delta < 0 ? 'move-up' : 'move-down');
  } finally {
    mutation.finishMutation();
  }
}
