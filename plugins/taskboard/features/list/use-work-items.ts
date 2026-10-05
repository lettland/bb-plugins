import {
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
  useCallback,
  useEffect,
  useState
} from 'react';
import { useRealtime, useRpc } from '@get-bb/plugin-sdk/app';
import {
  type TaskboardRpcContract,
  type WorkItem,
  type WorkSource,
  type WorkStatusOption
} from '../../contract.js';
import { type TrackerView } from '../../board-settings.js';
import {
  type BrowsePreferences,
  browsePreferenceStore,
  projectBrowseScope
} from '../../browse-preferences.js';
import { ALL_SOURCES } from '../shared/constants.js';
import {
  changedProjectId,
  describeError,
  useRefreshOnReconnect
} from '../shared/format.js';

export function useWorkItems({
  projectId,
  source,
  committedQuery,
  stateFilterEnabled,
  stateCategories,
  defaultView,
  boardSettingsReady,
  refreshGeneration,
  requestRevisionRef
}: {
  projectId: string | null;
  source: BrowsePreferences['source'];
  committedQuery: string;
  stateFilterEnabled: boolean;
  stateCategories: BrowsePreferences['stateCategories'];
  defaultView: TrackerView;
  boardSettingsReady: boolean;
  refreshGeneration: number;
  requestRevisionRef: MutableRefObject<number>;
}) {
  const rpc = useRpc<TaskboardRpcContract>();
  const [items, setItems] = useState<WorkItem[] | undefined>();
  const [authoritativeProvider, setAuthoritativeProvider] =
    useState<WorkSource | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadItems = useCallback(async () => {
    if (!boardSettingsReady) return;
    const requestRevision = ++requestRevisionRef.current;
    if (projectId !== null) setAuthoritativeProvider(null);
    setError(null);
    try {
      const result = await rpc.call('listItems', {
        ...(projectId === null ? {} : { projectId }),
        ...(projectId === null && source !== ALL_SOURCES ? { source } : {}),
        ...(committedQuery.trim() ? { query: committedQuery.trim() } : {}),
        ...(stateFilterEnabled && stateCategories.length > 0
          ? { stateCategories }
          : {}),
        limit: 500
      });
      if (requestRevision !== requestRevisionRef.current) return;
      const provider = result.provider;
      if (projectId !== null && provider) {
        browsePreferenceStore.reconcileProvider(
          projectBrowseScope(projectId),
          provider,
          { view: defaultView }
        );
        setAuthoritativeProvider(provider);
      }
      setItems(result.items);
    } catch (nextError) {
      if (requestRevision !== requestRevisionRef.current) return;
      setError(describeError(nextError));
      setItems([]);
    }
  }, [
    rpc,
    projectId,
    source,
    committedQuery,
    stateCategories,
    stateFilterEnabled,
    defaultView,
    boardSettingsReady
  ]);

  useEffect(() => {
    void loadItems();
  }, [loadItems, refreshGeneration]);

  return { items, setItems, error, authoritativeProvider, loadItems };
}

export function useQueryCommit(
  query: string,
  setCommittedQuery: (query: string) => void,
  requestRevisionRef: MutableRefObject<number>
): void {
  useEffect(() => {
    const timeout = window.setTimeout(
      () => setCommittedQuery(query.trim()),
      160
    );
    return () => window.clearTimeout(timeout);
  }, [query]);
  useEffect(
    () => () => {
      requestRevisionRef.current += 1;
    },
    []
  );
}

export function useWorkItemsRefresh(
  projectId: string | null,
  loadItems: () => Promise<void>
): void {
  useRealtime('taskboard:changed', payload => {
    const changedProject = changedProjectId(payload);
    if (
      projectId === null ||
      changedProject === null ||
      changedProject === projectId
    ) {
      void loadItems();
    }
  });
  useRefreshOnReconnect(() => void loadItems());
}

export function useMoveItemStatus(
  setItems: Dispatch<SetStateAction<WorkItem[] | undefined>>
) {
  const rpc = useRpc<TaskboardRpcContract>();
  return useCallback(
    async (item: WorkItem, option: WorkStatusOption) => {
      const matches = (candidate: WorkItem) =>
        candidate.bbProjectId === item.bbProjectId &&
        candidate.source === item.source &&
        candidate.locator === item.locator;
      setItems(current =>
        current?.map(candidate =>
          matches(candidate)
            ? {
                ...candidate,
                status: option.name,
                stateCategory: option.stateCategory
              }
            : candidate
        )
      );
      try {
        const result = await rpc.call('updateItemStatus', {
          projectId: item.bbProjectId,
          source: item.source,
          locator: item.locator,
          statusId: option.id
        });
        setItems(current =>
          current?.map(candidate =>
            matches(candidate) ? result.item : candidate
          )
        );
      } catch (error) {
        setItems(current =>
          current?.map(candidate => (matches(candidate) ? item : candidate))
        );
        throw error;
      }
    },
    [rpc]
  );
}
