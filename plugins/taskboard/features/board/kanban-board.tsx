import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRpc } from '@get-bb/plugin-sdk/app';
import {
  type TaskboardRpcContract,
  type WorkItem,
  type WorkStatusOption
} from '../../contract.js';
import {
  workflowStatusLaneKey,
  workflowStatusLanes,
  workflowStatusTone
} from '../../browse.js';
import { writeTaskboardComposerDrag } from '../../composer-handoff.js';
import { describeError } from '../shared/format.js';
import { WorkStateGlyph } from '../shared/work-state-glyph.js';
import { KanbanCard } from './kanban-card.js';

function kanbanItemId(item: WorkItem): string {
  return `${item.bbProjectId}:${item.source}:${item.locator}`;
}

function mergeDiscoveredStatuses(
  current: WorkStatusOption[],
  incoming: readonly WorkStatusOption[]
): WorkStatusOption[] {
  const merged = new Map(
    current.map(status => [
      workflowStatusLaneKey(status.name, status.stateCategory),
      status
    ])
  );
  let changed = false;
  for (const status of incoming) {
    const key = workflowStatusLaneKey(status.name, status.stateCategory);
    if (merged.has(key)) continue;
    merged.set(key, status);
    changed = true;
  }
  return changed ? [...merged.values()] : current;
}

export function KanbanBoard({
  items,
  workflowItems,
  statusOrder,
  composerDragEnabled,
  onOpen,
  onMove
}: {
  items: readonly WorkItem[];
  workflowItems: readonly WorkItem[];
  statusOrder: readonly string[];
  composerDragEnabled: boolean;
  onOpen: (item: WorkItem) => void;
  onMove: (item: WorkItem, option: WorkStatusOption) => Promise<void>;
}) {
  const rpc = useRpc<TaskboardRpcContract>();
  const optionsRef = useRef(
    new Map<string, Promise<readonly WorkStatusOption[]>>()
  );
  const draggedItemRef = useRef<WorkItem | null>(null);
  const suppressOpenRef = useRef<string | null>(null);
  const [discovered, setDiscovered] = useState<WorkStatusOption[]>([]);
  const [pickup, setPickup] = useState<{
    item: WorkItem;
    options: readonly WorkStatusOption[];
    targetLane: string | null;
    mode: 'pointer' | 'keyboard';
  } | null>(null);
  const [checking, setChecking] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [workflowReady, setWorkflowReady] = useState(
    workflowItems.length === 0
  );
  const [announcement, setAnnouncement] = useState('');
  const [visibleMessage, setVisibleMessage] = useState<string | null>(null);
  const lanes = useMemo(
    () => workflowStatusLanes(items, discovered, statusOrder),
    [discovered, items, statusOrder]
  );
  const preloadItems = useMemo(() => {
    const representatives = new Map<string, WorkItem>();
    for (const item of workflowItems) {
      const scope = `${item.bbProjectId}:${item.source}`;
      if (!representatives.has(scope)) {
        representatives.set(scope, item);
      }
    }
    return [...representatives.values()];
  }, [workflowItems]);

  const loadOptions = useCallback(
    (item: WorkItem) => {
      const itemId = kanbanItemId(item);
      const existing = optionsRef.current.get(itemId);
      if (existing) return existing;
      const request = rpc
        .call('statusOptions', {
          projectId: item.bbProjectId,
          source: item.source,
          locator: item.locator
        })
        .then(result => result.options)
        .catch((error: unknown) => {
          optionsRef.current.delete(itemId);
          throw error;
        });
      optionsRef.current.set(itemId, request);
      return request;
    },
    [rpc]
  );

  useEffect(() => {
    if (preloadItems.length === 0) {
      setWorkflowReady(true);
      return;
    }
    let cancelled = false;
    setWorkflowReady(false);
    void Promise.all(
      preloadItems.map(item => loadOptions(item).catch(() => []))
    ).then(statusSets => {
      if (cancelled) return;
      setDiscovered(current =>
        mergeDiscoveredStatuses(current, statusSets.flat())
      );
      setWorkflowReady(true);
    });
    return () => {
      cancelled = true;
    };
  }, [loadOptions, preloadItems]);

  const beginPickup = useCallback(
    async (item: WorkItem, mode: 'pointer' | 'keyboard') => {
      const itemId = kanbanItemId(item);
      setPickup({ item, options: [], targetLane: null, mode });
      setChecking(itemId);
      setVisibleMessage(null);
      setAnnouncement(`Checking valid statuses for ${item.key}`);
      try {
        const options = await loadOptions(item);
        const targets = options.filter(option => !option.current);
        setDiscovered(current => mergeDiscoveredStatuses(current, options));
        if (targets.length === 0) {
          const message = `${item.key} has no available status moves.`;
          setPickup(null);
          setVisibleMessage(message);
          setAnnouncement(message);
          return;
        }
        const targetLane = workflowStatusLaneKey(
          targets[0]!.name,
          targets[0]!.stateCategory
        );
        setPickup(current =>
          current && kanbanItemId(current.item) === itemId
            ? {
                ...current,
                options,
                targetLane: current.targetLane ?? targetLane
              }
            : current
        );
        setAnnouncement(
          `${item.key} picked up. ${targets.length} status ${targets.length === 1 ? 'target' : 'targets'} available. ${targets[0]!.name} selected.`
        );
      } catch (error) {
        const message = describeError(error);
        setPickup(null);
        setVisibleMessage(message);
        setAnnouncement(`Could not move ${item.key}. ${message}`);
      } finally {
        setChecking(current => (current === itemId ? null : current));
      }
    },
    [loadOptions]
  );

  const optionForLane = useCallback(
    (laneKey: string) =>
      pickup?.options.find(
        option =>
          !option.current &&
          workflowStatusLaneKey(option.name, option.stateCategory) === laneKey
      ),
    [pickup]
  );

  const commitMove = useCallback(
    async (
      item: WorkItem,
      laneKey: string,
      knownOptions: readonly WorkStatusOption[] = []
    ) => {
      if (pending) return;
      const itemId = kanbanItemId(item);
      let option = knownOptions.find(
        candidate =>
          !candidate.current &&
          workflowStatusLaneKey(candidate.name, candidate.stateCategory) ===
          laneKey
      );
      if (!option) {
        try {
          const options = await loadOptions(item);
          option = options.find(
            candidate =>
              !candidate.current &&
              workflowStatusLaneKey(
                candidate.name,
                candidate.stateCategory
              ) === laneKey
          );
        } catch (error) {
          const message = describeError(error);
          setPickup(null);
          setVisibleMessage(message);
          setAnnouncement(`Could not move ${item.key}. ${message}`);
          return;
        }
      }
      if (!option) {
        const message = `${item.key} cannot move to that status.`;
        setPickup(null);
        setVisibleMessage(message);
        setAnnouncement(message);
        return;
      }
      setPending(itemId);
      setPickup(null);
      setVisibleMessage(null);
      setAnnouncement(`Moving ${item.key} to ${option.name}`);
      try {
        await onMove(item, option);
        optionsRef.current.delete(itemId);
        setAnnouncement(`${item.key} moved to ${option.name}`);
      } catch (error) {
        optionsRef.current.delete(itemId);
        const message = describeError(error);
        setVisibleMessage(`${item.key} stayed in ${item.status}. ${message}`);
        setAnnouncement(`${item.key} move failed. ${message}`);
      } finally {
        setPending(current => (current === itemId ? null : current));
      }
    },
    [loadOptions, onMove, pending]
  );

  const keyboardTargets =
    pickup?.options.filter(option => !option.current) ?? [];

  return (
    <div
      role="region"
      aria-label="Kanban board"
      className="tb-kanban-area h-full min-h-0 overflow-auto p-2"
    >
      <p
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className="sr-only"
      >
        {announcement}
      </p>
      {visibleMessage ? (
        <div
          role="alert"
          className="tb-kanban-feedback sticky left-0 top-0 z-30 mb-2 w-fit max-w-lg rounded-md border px-2.5 py-1.5 text-xs text-destructive"
        >
          {visibleMessage}
        </div>
      ) : null}
      {!workflowReady ? (
        <div
          role="status"
          className="tb-kanban-feedback sticky left-0 top-0 z-30 mb-2 w-fit rounded-md border px-2.5 py-1.5 text-xs text-muted-foreground"
        >
          Loading workflow statuses…
        </div>
      ) : null}
      {lanes.length === 0 ? (
        <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
          No external statuses in the current results
        </div>
      ) : (
        <div
          dir="ltr"
          data-kanban-lanes="ordered"
          className="ml-0 mr-auto flex min-h-full min-w-max flex-row gap-2.5"
        >
          {lanes.map(lane => {
            const columnItems = items.filter(
              item =>
                workflowStatusLaneKey(item.status, item.stateCategory) ===
                lane.key
            );
            const option = optionForLane(lane.key);
            const dropState = pickup
              ? pickup.options.length === 0
                ? pickup.targetLane === lane.key
                  ? 'checking'
                  : 'invalid'
                : option
                  ? pickup.targetLane === lane.key
                    ? 'target'
                    : 'valid'
                  : 'invalid'
              : 'idle';
            const headingId = `kanban-${encodeURIComponent(lane.key)}`;
            return (
              <section
                key={lane.key}
                aria-labelledby={headingId}
                aria-dropeffect={
                  pickup && (pickup.options.length === 0 || option)
                    ? 'move'
                    : 'none'
                }
                data-drop-state={dropState}
                data-state-category={lane.category}
                data-status-tone={workflowStatusTone(
                  lane.name,
                  lane.category
                )}
                onDragOver={event => {
                  if (!pickup && !draggedItemRef.current) return;
                  event.preventDefault();
                  event.dataTransfer.dropEffect = 'move';
                  setPickup(current =>
                    current ? { ...current, targetLane: lane.key } : current
                  );
                }}
                onDrop={event => {
                  event.preventDefault();
                  const item = draggedItemRef.current ?? pickup?.item;
                  draggedItemRef.current = null;
                  if (item) {
                    void commitMove(item, lane.key, pickup?.options);
                  }
                }}
                className="tb-kanban-column flex w-[264px] min-w-[264px] flex-col rounded-lg border border-transparent"
              >
                <div className="tb-kanban-column-header sticky top-0 z-10 flex h-8 items-center gap-2 px-1">
                  <WorkStateGlyph category={lane.category} />
                  <h3
                    id={headingId}
                    className="min-w-0 truncate text-xs font-semibold"
                  >
                    {lane.name}
                  </h3>
                  <span
                    aria-label={`${columnItems.length} ${columnItems.length === 1 ? 'item' : 'items'}`}
                    className="tb-lane-count ml-auto text-xs tabular-nums"
                  >
                    {columnItems.length}
                  </span>
                </div>
                <div className="min-h-20 flex-1 space-y-1.5 p-1.5 pt-1">
                  {columnItems.length > 0 ? (
                    columnItems.map(item => {
                      const itemId = kanbanItemId(item);
                      return (
                        <KanbanCard
                          key={itemId}
                          item={item}
                          pickedUp={
                            pickup
                              ? kanbanItemId(pickup.item) === itemId
                              : false
                          }
                          pending={pending === itemId}
                          moveDisabled={!workflowReady}
                          composerDragEnabled={composerDragEnabled}
                          onPrepare={() => {
                            void loadOptions(item).catch(() => undefined);
                          }}
                          onDragStart={event => {
                            if (pending || checking || !workflowReady) {
                              event.preventDefault();
                              return;
                            }
                            event.dataTransfer.effectAllowed = composerDragEnabled
                              ? 'copyMove'
                              : 'move';
                            event.dataTransfer.setData('text/plain', itemId);
                            if (composerDragEnabled) {
                              writeTaskboardComposerDrag(
                                event.dataTransfer,
                                item,
                                'copyMove'
                              );
                            }
                            draggedItemRef.current = item;
                            suppressOpenRef.current = itemId;
                            void beginPickup(item, 'pointer');
                          }}
                          onDragEnd={() => {
                            draggedItemRef.current = null;
                            setPickup(current =>
                              current?.mode === 'pointer' ? null : current
                            );
                            window.setTimeout(() => {
                              if (suppressOpenRef.current === itemId) {
                                suppressOpenRef.current = null;
                              }
                            }, 0);
                          }}
                          onKeyDown={event => {
                            if (!workflowReady && event.key === ' ') {
                              event.preventDefault();
                              setAnnouncement(
                                'Workflow statuses are still loading'
                              );
                              return;
                            }
                            const isThisPickup =
                              pickup && kanbanItemId(pickup.item) === itemId;
                            if (!isThisPickup && event.key === ' ') {
                              event.preventDefault();
                              void beginPickup(item, 'keyboard');
                              return;
                            }
                            if (!isThisPickup) return;
                            if (event.key === 'Escape') {
                              event.preventDefault();
                              setPickup(null);
                              setAnnouncement(`${item.key} move canceled`);
                              return;
                            }
                            if (
                              event.key === 'ArrowLeft' ||
                              event.key === 'ArrowRight'
                            ) {
                              event.preventDefault();
                              const currentIndex = keyboardTargets.findIndex(
                                target =>
                                  workflowStatusLaneKey(
                                    target.name,
                                    target.stateCategory
                                  ) === pickup.targetLane
                              );
                              const direction =
                                event.key === 'ArrowRight' ? 1 : -1;
                              const next =
                                keyboardTargets[
                                  (currentIndex +
                                    direction +
                                    keyboardTargets.length) %
                                    keyboardTargets.length
                                ];
                              if (!next) return;
                              const targetLane = workflowStatusLaneKey(
                                next.name,
                                next.stateCategory
                              );
                              setPickup(current =>
                                current ? { ...current, targetLane } : current
                              );
                              setAnnouncement(
                                `${next.name} selected for ${item.key}`
                              );
                              return;
                            }
                            if (event.key === 'Enter' || event.key === ' ') {
                              event.preventDefault();
                              if (pickup.targetLane) {
                                void commitMove(
                                  pickup.item,
                                  pickup.targetLane,
                                  pickup.options
                                );
                              }
                            }
                          }}
                          onOpen={() => {
                            if (suppressOpenRef.current === itemId) {
                              suppressOpenRef.current = null;
                              return;
                            }
                            if (!pickup) onOpen(item);
                          }}
                        />
                      );
                    })
                  ) : (
                    <p className="px-2 py-5 text-center text-xs text-muted-foreground">
                      {dropState === 'target' ? 'Drop to move here' : 'No work'}
                    </p>
                  )}
                </div>
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}
