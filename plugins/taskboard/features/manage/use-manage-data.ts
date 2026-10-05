import { useEffect, useState } from 'react';
import { useRpc } from '@get-bb/plugin-sdk/app';
import {
  type ProjectConfigView,
  type TaskboardRpcContract
} from '../../contract.js';
import { type ProjectBoardSettings } from '../../board-settings.js';
import { describeError } from '../shared/format.js';

export function useManageData(projectId: string | null) {
  const rpc = useRpc<TaskboardRpcContract>();
  const [config, setConfig] = useState<ProjectConfigView | null>(null);
  const [boardSettings, setBoardSettings] =
    useState<ProjectBoardSettings | null>(null);
  const [loadingConfig, setLoadingConfig] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadRevision, setLoadRevision] = useState(0);

  useEffect(() => {
    setConfig(null);
    setBoardSettings(null);
    setError(null);
    if (!projectId) return;
    let cancelled = false;
    setLoadingConfig(true);
    void Promise.all([
      rpc.call('getProjectConfig', { projectId }),
      rpc.call('getProjectBoardSettings', { projectId })
    ])
      .then(([configResult, settingsResult]) => {
        if (cancelled) return;
        setConfig(configResult.config);
        setBoardSettings(settingsResult.settings);
      })
      .catch((nextError: unknown) => {
        if (!cancelled) setError(describeError(nextError));
      })
      .finally(() => {
        if (!cancelled) setLoadingConfig(false);
      });
    return () => {
      cancelled = true;
    };
  }, [loadRevision, projectId, rpc]);

  return {
    config,
    boardSettings,
    setBoardSettings,
    loadingConfig,
    error,
    setLoadRevision
  };
}
