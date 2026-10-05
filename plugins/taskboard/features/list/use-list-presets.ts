import { useCallback, useRef, useState } from 'react';
import { useRpc } from '@get-bb/plugin-sdk/app';
import { toast } from 'sonner';
import {
  type FilterPreset,
  type TaskboardRpcContract,
  type WorkSource
} from '../../contract.js';
import {
  type BrowsePreferences,
  type BrowsePreferenceScope,
  browsePreferenceStore
} from '../../browse-preferences.js';
import { describeError } from '../shared/format.js';

export function useApplyPreset(
  projectId: string | null,
  preferenceScope: BrowsePreferenceScope,
  authoritativeProvider: WorkSource | null
) {
  return useCallback(
    (preset: FilterPreset) => {
      if (projectId === null || preset.projectId !== projectId) {
        toast.error('This preset belongs to a different project.');
        return;
      }
      if (authoritativeProvider === null) {
        toast.error('Wait for this project’s tracker to finish loading.');
        return;
      }
      if (preset.state.provider !== authoritativeProvider) {
        toast.error(
          'This preset was saved for a different tracker. Save a new preset for the current project connection.'
        );
        return;
      }
      browsePreferenceStore.set(preferenceScope, preset.state);
      toast.success(`Applied preset "${preset.name}"`);
    },
    [authoritativeProvider, preferenceScope, projectId]
  );
}

export function useSavePreset(
  projectId: string | null,
  preferences: BrowsePreferences,
  authoritativeProvider: WorkSource | null,
  setAuthoritativePresets: (presets: FilterPreset[]) => void
) {
  const rpc = useRpc<TaskboardRpcContract>();
  const [presetNameDraft, setPresetNameDraft] = useState<string | null>(null);
  const [presetSaveError, setPresetSaveError] = useState<string | null>(null);
  const [savingPreset, setSavingPreset] = useState(false);
  const savingPresetRef = useRef(false);
  const saveCurrentPreset = useCallback(
    async (name: string) => {
      if (projectId === null || savingPresetRef.current) return;
      if (
        authoritativeProvider === null ||
        preferences.provider !== authoritativeProvider
      ) {
        setPresetSaveError(
          'Wait for this project’s tracker to finish loading, then try again.'
        );
        return;
      }
      savingPresetRef.current = true;
      setSavingPreset(true);
      setPresetSaveError(null);
      try {
        const result = await rpc.call('saveFilterPreset', {
          projectId,
          name,
          state: preferences
        });
        setAuthoritativePresets(result.presets);
        setPresetNameDraft(null);
        setPresetSaveError(null);
        toast.success(`Saved preset "${result.preset.name}"`);
      } catch (nextError) {
        const message = describeError(nextError);
        setPresetSaveError(message);
        toast.error(message);
      } finally {
        savingPresetRef.current = false;
        setSavingPreset(false);
      }
    },
    [authoritativeProvider, preferences, setAuthoritativePresets, projectId, rpc]
  );
  return {
    presetNameDraft,
    setPresetNameDraft,
    presetSaveError,
    setPresetSaveError,
    savingPreset,
    saveCurrentPreset
  };
}
