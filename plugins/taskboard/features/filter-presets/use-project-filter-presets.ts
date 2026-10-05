import {
  type MutableRefObject,
  useCallback,
  useEffect,
  useRef,
  useState
} from 'react';
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

export interface ProjectFilterPresets {
  presets: readonly FilterPreset[];
  error: string | null;
  refreshError: string | null;
  loading: boolean;
  reload: (options?: { background?: boolean }) => Promise<void>;
  setAuthoritative: (presets: readonly FilterPreset[]) => void;
}

function usePresetState(projectId: string | null) {
  const [presets, setPresets] = useState<readonly FilterPreset[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [loading, setLoading] = useState(projectId !== null);
  const [loadedProjectId, setLoadedProjectId] = useState<string | null>(
    projectId
  );
  return {
    presets,
    setPresets,
    error,
    setError,
    refreshError,
    setRefreshError,
    loading,
    setLoading,
    loadedProjectId,
    setLoadedProjectId
  };
}

type PresetState = ReturnType<typeof usePresetState>;

function usePresetReload(
  projectId: string | null,
  state: PresetState,
  requestRevisionRef: MutableRefObject<number>,
  projectIdRef: MutableRefObject<string | null>
) {
  const rpc = useRpc<TaskboardRpcContract>();
  const { setPresets, setError, setRefreshError } = state;
  const { setLoading, setLoadedProjectId } = state;

  return useCallback(async (
    options: { background?: boolean } = {}
  ) => {
    if (projectIdRef.current !== projectId) return;
    const requestRevision = ++requestRevisionRef.current;
    const isCurrent = () =>
      requestRevision === requestRevisionRef.current &&
      projectIdRef.current === projectId;
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
      if (!isCurrent()) return;
      setPresets(result.presets);
      setError(null);
      setRefreshError(null);
      setLoadedProjectId(projectId);
    } catch (nextError) {
      if (!isCurrent()) return;
      const message = describeError(nextError);
      if (options.background) {
        setRefreshError(message);
      } else {
        setPresets([]);
        setError(message);
      }
      setLoadedProjectId(projectId);
    } finally {
      if (isCurrent()) setLoading(false);
    }
  }, [projectId, rpc]);
}

export function useProjectFilterPresets(
  projectId: string | null
): ProjectFilterPresets {
  const state = usePresetState(projectId);
  const requestRevisionRef = useRef(0);
  const projectIdRef = useRef(projectId);
  projectIdRef.current = projectId;
  const reload = usePresetReload(
    projectId,
    state,
    requestRevisionRef,
    projectIdRef
  );

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

  const { setPresets, setError, setRefreshError } = state;
  const { setLoading, setLoadedProjectId } = state;
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

  const scopeMatches = state.loadedProjectId === projectId;
  return {
    presets: scopeMatches ? state.presets : [],
    error: scopeMatches ? state.error : null,
    refreshError: scopeMatches ? state.refreshError : null,
    loading: scopeMatches ? state.loading : projectId !== null,
    reload,
    setAuthoritative
  };
}
