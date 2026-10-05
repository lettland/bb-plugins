import { useCallback, useEffect, useRef, useState } from 'react';
import { useRealtime, useRpc } from '@get-bb/plugin-sdk/app';
import {
  type FilterPreset,
  type TaskboardRpcContract
} from '../../contract.js';
import {
  changedProjectId,
  describeError,
  useRefreshOnReconnect
} from '../shared/format.js';

export function useProjectFilterPresets(projectId: string | null): {
  presets: readonly FilterPreset[];
  error: string | null;
  refreshError: string | null;
  loading: boolean;
  reload: (options?: { background?: boolean }) => Promise<void>;
  setAuthoritative: (presets: readonly FilterPreset[]) => void;
} {
  const rpc = useRpc<TaskboardRpcContract>();
  const [presets, setPresets] = useState<readonly FilterPreset[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [loading, setLoading] = useState(projectId !== null);
  const [loadedProjectId, setLoadedProjectId] = useState<string | null>(
    projectId
  );
  const requestRevisionRef = useRef(0);
  const projectIdRef = useRef(projectId);
  projectIdRef.current = projectId;

  const reload = useCallback(async (
    options: { background?: boolean } = {}
  ) => {
    if (projectIdRef.current !== projectId) return;
    const requestRevision = ++requestRevisionRef.current;
    if (projectId === null) {
      setPresets([]);
      setError(null);
      setRefreshError(null);
      setLoading(false);
      setLoadedProjectId(null);
      return;
    }
    if (!options.background) {
      setPresets([]);
      setLoading(true);
      setLoadedProjectId(projectId);
      setError(null);
    }
    setRefreshError(null);
    try {
      const result = await rpc.call('listFilterPresets', { projectId });
      if (
        requestRevision !== requestRevisionRef.current ||
        projectIdRef.current !== projectId
      ) {
        return;
      }
      setPresets(result.presets);
      setError(null);
      setRefreshError(null);
      setLoadedProjectId(projectId);
    } catch (nextError) {
      if (
        requestRevision !== requestRevisionRef.current ||
        projectIdRef.current !== projectId
      ) {
        return;
      }
      const message = describeError(nextError);
      if (options.background) {
        setRefreshError(message);
      } else {
        setPresets([]);
        setError(message);
      }
      setLoadedProjectId(projectId);
    } finally {
      if (
        requestRevision === requestRevisionRef.current &&
        projectIdRef.current === projectId
      ) {
        setLoading(false);
      }
    }
  }, [projectId, rpc]);

  useEffect(() => {
    void reload();
    return () => {
      requestRevisionRef.current += 1;
    };
  }, [reload]);
  useRealtime('taskboard:presets-changed', payload => {
    if (projectId === null) return;
    const changedProject = changedProjectId(payload);
    if (changedProject === null || changedProject === projectId) {
      void reload({ background: true });
    }
  });
  useRefreshOnReconnect(() => {
    if (projectId !== null) void reload({ background: true });
  });

  const setAuthoritative = useCallback(
    (nextPresets: readonly FilterPreset[]) => {
      if (projectIdRef.current !== projectId) return;
      requestRevisionRef.current += 1;
      setPresets(nextPresets);
      setError(null);
      setRefreshError(null);
      setLoading(false);
      setLoadedProjectId(projectId);
      // A mutation result is authoritative for that request, but another
      // surface may have committed a later change while it was in flight.
      // Refresh after the response so the last completed read always wins.
      void reload({ background: true });
    },
    [projectId, reload]
  );

  const scopeMatches = loadedProjectId === projectId;
  return {
    presets: scopeMatches ? presets : [],
    error: scopeMatches ? error : null,
    refreshError: scopeMatches ? refreshError : null,
    loading: scopeMatches ? loading : projectId !== null,
    reload,
    setAuthoritative
  };
}
