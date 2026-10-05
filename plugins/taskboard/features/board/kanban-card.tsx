import {
  type DragEvent as ReactDragEvent,
  type KeyboardEvent as ReactKeyboardEvent
} from 'react';
import { Icon } from '@/components/ui/icon';
import { cn } from '@/lib/utils';
import { type WorkItem } from '../../contract.js';
import { workflowStatusTone } from '../../browse.js';
import {
  AssigneeMark,
  PriorityMark,
  visibleAssignee,
  visiblePriority
} from '../shared/work-item-marks.js';
import { WorkStateGlyph } from '../shared/work-state-glyph.js';
import { formatUpdatedAt } from '../shared/format.js';

export function KanbanCard({
  item,
  pickedUp,
  pending,
  moveDisabled,
  composerDragEnabled,
  onOpen,
  onPrepare,
  onDragStart,
  onDragEnd,
  onKeyDown
}: {
  item: WorkItem;
  pickedUp: boolean;
  pending: boolean;
  moveDisabled: boolean;
  composerDragEnabled: boolean;
  onOpen: () => void;
  onPrepare: () => void;
  onDragStart: (event: ReactDragEvent<HTMLButtonElement>) => void;
  onDragEnd: () => void;
  onKeyDown: (event: ReactKeyboardEvent<HTMLButtonElement>) => void;
}) {
  const priority = visiblePriority(item.priority);
  const assignee = visibleAssignee(item.assignee);
  const labels = item.labels
    .map(label => label.trim())
    .filter(Boolean)
    .slice(0, 2);

  return (
    <button
      type="button"
      draggable={!pending && !moveDisabled}
      aria-grabbed={pickedUp}
      aria-busy={pending}
      aria-label={`${item.key}: ${item.title}. Status ${item.status}.${priority ? ` Priority ${priority}.` : ''}${assignee ? ` Assigned to ${assignee}.` : ''}${moveDisabled ? ' Workflow statuses are loading. Press Enter to open.' : ' Press Space to move, or Enter to open.'}`}
      data-state-category={item.stateCategory}
      data-status-tone={workflowStatusTone(item.status, item.stateCategory)}
      data-picked-up={pickedUp ? 'true' : 'false'}
      data-pending={pending ? 'true' : 'false'}
      data-move-disabled={moveDisabled ? 'true' : 'false'}
      data-composer-drag={composerDragEnabled ? 'true' : undefined}
      onPointerDown={onPrepare}
      onFocus={onPrepare}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onKeyDown={onKeyDown}
      onClick={onOpen}
      className={cn(
        'tb-kanban-card group w-full rounded-md px-3 py-2.5 text-left transition-[border-color,background-color,opacity,transform] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        composerDragEnabled && 'cursor-grab active:cursor-grabbing'
      )}
    >
      <span className="flex items-center gap-2 text-xs">
        <span className="tb-priority-slot flex size-4 items-center justify-center">
          {priority ? <PriorityMark priority={priority} /> : null}
        </span>
        <span className="tb-key min-w-0 truncate font-medium tabular-nums">
          {item.key}
        </span>
        {composerDragEnabled ? (
          <span
            aria-hidden="true"
            className="tb-composer-drag-grip ml-auto flex items-center justify-center text-muted-foreground"
          >
            <Icon name="DragDropVertical" className="size-3.5" />
          </span>
        ) : null}
      </span>
      <span className="mt-1.5 flex items-start gap-1.5">
        <span className="mt-1 flex shrink-0">
          <WorkStateGlyph category={item.stateCategory} />
        </span>
        <span className="line-clamp-2 block text-sm font-medium leading-snug text-foreground">
          {item.title}
        </span>
      </span>
      {labels.length > 0 ? (
        <span className="mt-2 flex min-w-0 gap-1 overflow-hidden">
          {labels.map((label, index) => (
            <span
              key={`${label}-${index}`}
              className="tb-label-chip min-w-0 truncate rounded-full px-2 py-0.5 text-xs"
              title={label}
            >
              {label}
            </span>
          ))}
        </span>
      ) : null}
      <span className="tb-meta mt-2 flex min-w-0 items-center gap-2 text-xs">
        <time className="shrink-0 tabular-nums" dateTime={item.updatedAt}>
          Updated {formatUpdatedAt(item.updatedAt)}
        </time>
        {pending ? (
          <span className="ml-auto min-w-0 truncate">Updating…</span>
        ) : assignee ? (
          <span className="ml-auto flex shrink-0">
            <AssigneeMark assignee={assignee} />
          </span>
        ) : null}
      </span>
    </button>
  );
}
