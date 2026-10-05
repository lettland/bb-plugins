import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { useRpc } from '@get-bb/plugin-sdk/app';
import { type TaskboardRpcContract } from '../../contract.js';
import {
  defaultProjectBoardSettings,
  type ProjectBoardSettings
} from '../../board-settings.js';
import {
  type BrowsePreferences,
  type BrowsePreferenceScope,
  browsePreferenceStore
} from '../../browse-preferences.js';

export function useBrowsePreferences(preferenceScope: BrowsePreferenceScope) {
  const subscribePreferences = useCallback(
    (listener: () => void) =>
      browsePreferenceStore.subscribe(preferenceScope, listener),
    [preferenceScope]
  );
  const readPreferences = useCallback(
    () => browsePreferenceStore.get(preferenceScope),
    [preferenceScope]
  );
  const preferences = useSyncExternalStore(
    subscribePreferences,
    readPreferences,
    readPreferences
  );
  const updatePreferences = useCallback(
    (update: (current: BrowsePreferences) => BrowsePreferences) =>
      browsePreferenceStore.update(preferenceScope, update),
    [preferenceScope]
  );
  return { preferences, updatePreferences };
}

export function useBoardSettings(
  projectId: string | null,
  preferenceScope: BrowsePreferenceScope
) {
  const rpc = useRpc<TaskboardRpcContract>();
  const [boardSettings, setBoardSettings] = useState<ProjectBoardSettings>(() =>
    defaultProjectBoardSettings(projectId ?? 'proj_across_projects')
  );
  const [boardSettingsReady, setBoardSettingsReady] = useState(
    projectId === null
  );

  useEffect(() => {
    if (projectId === null) {
      setBoardSettings(defaultProjectBoardSettings('proj_across_projects'));
      setBoardSettingsReady(true);
      return;
    }
    let cancelled = false;
    setBoardSettingsReady(false);
    void rpc
      .call('getProjectBoardSettings', { projectId })
      .then(result => {
        if (cancelled) return;
        setBoardSettings(result.settings);
        browsePreferenceStore.seed(preferenceScope, {
          view: result.settings.defaultView
        });
      })
      .catch(() => {
        if (cancelled) return;
        const defaults = defaultProjectBoardSettings(projectId);
        setBoardSettings(defaults);
        browsePreferenceStore.seed(preferenceScope, {
          view: defaults.defaultView
        });
      })
      .finally(() => {
        if (!cancelled) setBoardSettingsReady(true);
      });
    return () => {
      cancelled = true;
    };
  }, [preferenceScope, projectId, rpc]);

  return { boardSettings, boardSettingsReady };
}
