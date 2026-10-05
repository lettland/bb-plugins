import { useCallback, useEffect, useState } from 'react';
import { useRpc } from '@get-bb/plugin-sdk/app';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu';
import { Icon } from '@/components/ui/icon';
import { cn } from '@/lib/utils';
import {
  type TaskboardRpcContract,
  type TrackerProject,
  type WorkItem,
  type WorkStatusOption
} from '../../contract.js';
import { workflowStatusTone } from '../../browse.js';
import { writeTaskboardComposerDrag } from '../../composer-handoff.js';
import { describeError, formatUpdatedAt } from '../shared/format.js';
import { WorkStateGlyph } from '../shared/work-state-glyph.js';
import {
  AssigneeMark,
  PriorityMark,
  visibleAssignee,
  visiblePriority
} from '../shared/work-item-marks.js';

export function WorkItemStatusMenu({
  item,
  variant,
  onMove
}: {
  item: WorkItem;
  variant: 'row' | 'detail';
  onMove: (item: WorkItem, option: WorkStatusOption) => Promise<void>;
}) {
  const rpc = useRpc<TaskboardRpcContract>();
  const [options, setOptions] = useState<WorkStatusOption[] | undefined>();
  const [loading, setLoading] = useState(false);
  const [pendingStatusId, setPendingStatusId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const identity = `${item.bbProjectId}:${item.source}:${item.locator}`;

  useEffect(() => {
    setOptions(undefined);
    setError(null);
  }, [identity, item.status]);

  const loadOptions = useCallback(async () => {
    if (loading || options !== undefined) return;
    setLoading(true);
    setError(null);
    try {
      const result = await rpc.call('statusOptions', {
        projectId: item.bbProjectId,
        source: item.source,
        locator: item.locator
      });
      setOptions(result.options);
    } catch (nextError) {
      setError(describeError(nextError));
    } finally {
      setLoading(false);
    }
  }, [item.bbProjectId, item.locator, item.source, loading, options, rpc]);

  const changeStatus = async (option: WorkStatusOption) => {
    const current =
      option.current ||
      (option.name === item.status &&
        option.stateCategory === item.stateCategory);
    if (current || pendingStatusId !== null) return;
    setPendingStatusId(option.id);
    try {
      await onMove(item, option);
      toast.success(`${item.key} moved to ${option.name}`);
    } catch (nextError) {
      toast.error(`Could not update ${item.key}`, {
        description: describeError(nextError)
      });
    } finally {
      setPendingStatusId(null);
    }
  };

  const trigger =
    variant === 'row' ? (
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="size-5 rounded-full p-0"
        aria-label={`Change status for ${item.key}. Current status: ${item.status}`}
        disabled={pendingStatusId !== null}
      >
        <WorkStateGlyph category={item.stateCategory} />
      </Button>
    ) : (
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="tb-status-pill h-7 gap-1.5 rounded-full px-2.5 text-xs"
        aria-label={`Change status for ${item.key}. Current status: ${item.status}`}
        data-state-category={item.stateCategory}
        data-status-tone={workflowStatusTone(
          item.status,
          item.stateCategory
        )}
        disabled={pendingStatusId !== null}
      >
        <WorkStateGlyph category={item.stateCategory} />
        {pendingStatusId === null ? item.status : 'Updating…'}
        <Icon name="ChevronDown" className="size-3 opacity-60" />
      </Button>
    );

  return (
    <DropdownMenu
      onOpenChange={open => {
        if (open) void loadOptions();
      }}
    >
      <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
      <DropdownMenuContent
        align={variant === 'row' ? 'start' : 'end'}
        className="min-w-48"
      >
        {loading && options === undefined ? (
          <DropdownMenuItem disabled>
            <Icon name="Loading" className="size-3.5 animate-spin" />
            Loading statuses…
          </DropdownMenuItem>
        ) : error ? (
          <DropdownMenuItem disabled className="max-w-64 text-destructive">
            {error}
          </DropdownMenuItem>
        ) : options?.length ? (
          options.map(option => {
            const current =
              option.current ||
              (option.name === item.status &&
                option.stateCategory === item.stateCategory);
            return (
              <DropdownMenuItem
                key={option.id}
                disabled={current || pendingStatusId !== null}
                onSelect={() => void changeStatus(option)}
              >
                <WorkStateGlyph category={option.stateCategory} />
                <span className="min-w-0 flex-1 truncate">{option.name}</span>
                {current ? <Icon name="Check" className="size-3.5" /> : null}
              </DropdownMenuItem>
            );
          })
        ) : (
          <DropdownMenuItem disabled>No status changes available</DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function WorkItemRow({
  item,
  project,
  showProject,
  composerDragEnabled,
  onMove,
  onOpen
}: {
  item: WorkItem;
  project: TrackerProject | undefined;
  showProject: boolean;
  composerDragEnabled: boolean;
  onMove: (item: WorkItem, option: WorkStatusOption) => Promise<void>;
  onOpen: () => void;
}) {
  const priority = visiblePriority(item.priority);
  const assignee = visibleAssignee(item.assignee);
  return (
    <div
      data-state-category={item.stateCategory}
      data-status-tone={workflowStatusTone(item.status, item.stateCategory)}
      data-composer-drag={composerDragEnabled ? 'true' : undefined}
      className="tb-item-row group relative grid min-h-9 w-full items-center gap-x-2 border-b border-border-hairline px-2.5 py-1 text-left"
    >
      <button
        type="button"
        draggable={composerDragEnabled}
        aria-label={`Open ${item.key}: ${item.title}.${priority ? ` Priority ${priority}.` : ''}${assignee ? ` Assigned to ${assignee}.` : ''}`}
        onDragStart={event => {
          if (
            !composerDragEnabled ||
            !writeTaskboardComposerDrag(event.dataTransfer, item, 'copy')
          ) {
            event.preventDefault();
          }
        }}
        onClick={onOpen}
        className={cn(
          'absolute inset-0 z-0 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring',
          composerDragEnabled && 'cursor-grab active:cursor-grabbing'
        )}
      />
      {composerDragEnabled ? (
        <span
          aria-hidden="true"
          className="tb-composer-drag-grip pointer-events-none relative z-[1] flex items-center justify-center text-muted-foreground"
        >
          <Icon name="DragDropVertical" className="size-3.5" />
        </span>
      ) : null}
      <span className="relative z-10 flex items-center justify-center">
        <WorkItemStatusMenu item={item} variant="row" onMove={onMove} />
      </span>
      <span className="tb-key pointer-events-none relative z-[1] min-w-0 truncate text-xs font-medium tabular-nums">
        {item.key}
      </span>
      <span className="pointer-events-none relative z-[1] min-w-0 truncate text-[13px] font-medium text-foreground">
        {item.title}
      </span>
      <span className="tb-row-trailing tb-meta pointer-events-none relative z-[1] flex min-w-0 items-center gap-2 overflow-hidden text-xs">
        {priority ? <PriorityMark priority={priority} /> : null}
        {showProject && project ? (
          <span className="max-w-28 truncate" title={project.name}>
            {project.name}
          </span>
        ) : null}
        {assignee ? <AssigneeMark assignee={assignee} /> : null}
        <time className="tb-row-time ml-auto shrink-0 tabular-nums">
          {formatUpdatedAt(item.updatedAt)}
        </time>
      </span>
    </div>
  );
}
