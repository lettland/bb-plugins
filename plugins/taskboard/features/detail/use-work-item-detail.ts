import {
  type Dispatch,
  type SetStateAction,
  useCallback,
  useEffect,
  useRef,
  useState
} from 'react';
import { useRealtime, useRpc } from '@get-bb/plugin-sdk/app';
import {
  type TaskboardRpcContract,
  type WorkItem,
  type WorkItemDetail,
  type WorkStatusOption
} from '../../contract.js';
import { type ItemRoute } from '../shared/route.js';
import {
  changedProjectId,
  describeError,
  useRefreshOnReconnect
} from '../shared/format.js';

function useDetailStatusMove(
  route: ItemRoute,
  item: WorkItemDetail | null | undefined,
  setItem: Dispatch<SetStateAction<WorkItemDetail | null | undefined>>
) {
  const rpc = useRpc<TaskboardRpcContract>();
  return useCallback(
    async (_selectedItem: WorkItem, option: WorkStatusOption) => {
      if (!item) throw new Error('The work item is not loaded.');
      const previous = item;
      setItem({
        ...item,
        status: option.name,
        stateCategory: option.stateCategory
      });
      try {
        const result = await rpc.call('updateItemStatus', {
          projectId: route.projectId,
          source: route.source,
          locator: route.locator,
          statusId: option.id
        });
        setItem(current =>
          current
            ? { ...current, ...result.item, comments: current.comments }
            : current
        );
      } catch (nextError) {
        setItem(previous);
        throw nextError;
      }
    },
    [item, route.locator, route.projectId, route.source, rpc]
  );
}

export function useWorkItemDetail(route: ItemRoute, refreshGeneration: number) {
  const rpc = useRpc<TaskboardRpcContract>();
  const [item, setItem] = useState<WorkItemDetail | null | undefined>();
  const [error, setError] = useState<string | null>(null);
  const requestRevisionRef = useRef(0);

  const load = useCallback(async () => {
    const requestRevision = ++requestRevisionRef.current;
    setError(null);
    try {
      const result = await rpc.call('getItem', {
        projectId: route.projectId,
        source: route.source,
        locator: route.locator
      });
      if (requestRevision !== requestRevisionRef.current) return;
      setItem(result.item);
    } catch (nextError) {
      if (requestRevision !== requestRevisionRef.current) return;
      setItem(null);
      setError(describeError(nextError));
    }
  }, [rpc, route.projectId, route.source, route.locator]);

  useEffect(() => {
    setItem(undefined);
    void load();
    return () => {
      requestRevisionRef.current += 1;
    };
  }, [load, refreshGeneration]);
  useRealtime('taskboard:changed', payload => {
    const changedProject = changedProjectId(payload);
    if (changedProject === null || changedProject === route.projectId) {
      void load();
    }
  });
  useRefreshOnReconnect(() => void load());

  const moveItemStatus = useDetailStatusMove(route, item, setItem);
  return { item, setItem, error, load, moveItemStatus };
}
