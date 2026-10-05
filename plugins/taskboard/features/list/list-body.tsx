import { type ComponentProps } from 'react';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import {
  type TrackerProject,
  type WorkItem,
  type WorkStateCategory,
  type WorkStatusOption
} from '../../contract.js';
import { type TrackerView } from '../../board-settings.js';
import { EmptyState, ListMeasure, LoadingRows } from './list-states.js';
import { ListStateGroups } from './state-groups.js';
import { KanbanBoard } from '../board/kanban-board.js';

interface ListBodyProps {
  projectId: string | null;
  items: WorkItem[] | undefined;
  visibleItems: readonly WorkItem[];
  boardSettingsReady: boolean;
  statusOrder: readonly string[];
  error: string | null;
  view: TrackerView;
  surfaceMode: 'full' | 'constrained';
  filtered: boolean;
  searchActive: boolean;
  projectsById: ReadonlyMap<string, TrackerProject>;
  acrossProjectGroups: ReadonlyArray<{
    project: TrackerProject;
    items: readonly WorkItem[];
  }>;
  duplicateProjectNames: ReadonlySet<string>;
  collapsedGroups: Readonly<Record<string, boolean>>;
  onToggleGroup: (groupKey: string, category: WorkStateCategory) => void;
  onMove: (item: WorkItem, option: WorkStatusOption) => Promise<void>;
  onOpen: (item: WorkItem) => void;
  onClear: () => void;
  onRetry: () => void;
}

function ListLoadError({
  error,
  onRetry
}: {
  error: string;
  onRetry: () => void;
}) {
  return (
    <ListMeasure className="h-full">
      <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
        <Icon name="AlertCircle" className="size-5 text-destructive" />
        <p className="text-sm font-medium">Could not load work items</p>
        <p role="alert" className="max-w-md text-sm text-destructive">
          {error}
        </p>
        <Button variant="outline" size="sm" onClick={onRetry}>
          Try again
        </Button>
      </div>
    </ListMeasure>
  );
}

function AcrossProjectsList({
  props,
  groupProps
}: {
  props: ListBodyProps;
  groupProps: Omit<ComponentProps<typeof ListStateGroups>, 'items' | 'idPrefix'>;
}) {
  return (
    <ListMeasure>
      {props.acrossProjectGroups.map(({ project, items: projectItems }) => (
        <section
          key={project.id}
          aria-labelledby={`project-${project.id}`}
          className="border-b border-border last:border-b-0"
        >
          <h2
            id={`project-${project.id}`}
            className="tb-project-strip sticky top-0 z-20 flex h-8 items-center gap-2 border-b px-2.5 text-xs font-semibold"
          >
            <Icon name="Folder" className="size-3.5 text-muted-foreground" />
            {project.name}
            {props.duplicateProjectNames.has(project.name) ? (
              <span className="truncate font-mono text-xs font-normal text-muted-foreground">
                {project.id}
              </span>
            ) : null}
          </h2>
          <ListStateGroups
            {...groupProps}
            items={projectItems}
            idPrefix={project.id}
            nested
          />
        </section>
      ))}
    </ListMeasure>
  );
}

export function ListBody(props: ListBodyProps) {
  const { projectId, items, visibleItems, surfaceMode } = props;
  const groupProps = {
    statusOrder: props.statusOrder,
    projectsById: props.projectsById,
    showProject: false,
    composerDragEnabled: surfaceMode === 'constrained',
    collapsedGroups: props.collapsedGroups,
    searchActive: props.searchActive,
    onToggleGroup: props.onToggleGroup,
    onMove: props.onMove,
    onOpen: props.onOpen
  };
  if (items === undefined || !props.boardSettingsReady) {
    return (
      <ListMeasure>
        <LoadingRows />
      </ListMeasure>
    );
  }
  if (props.error) {
    return <ListLoadError error={props.error} onRetry={props.onRetry} />;
  }
  if (projectId !== null && props.view === 'kanban') {
    return (
      <KanbanBoard
        key={projectId}
        items={visibleItems}
        workflowItems={items}
        statusOrder={props.statusOrder}
        composerDragEnabled={surfaceMode === 'constrained'}
        onOpen={props.onOpen}
        onMove={props.onMove}
      />
    );
  }
  if (visibleItems.length === 0) {
    return (
      <ListMeasure className="h-full">
        <EmptyState filtered={props.filtered} onClear={props.onClear} />
      </ListMeasure>
    );
  }
  if (projectId === null) {
    return <AcrossProjectsList props={props} groupProps={groupProps} />;
  }
  return (
    <ListMeasure>
      <ListStateGroups
        {...groupProps}
        items={visibleItems}
        idPrefix={projectId ?? 'selected-project'}
      />
    </ListMeasure>
  );
}
