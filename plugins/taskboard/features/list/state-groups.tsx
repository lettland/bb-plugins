import { Icon } from '@/components/ui/icon';
import { cn } from '@/lib/utils';
import {
  type TrackerProject,
  type WorkItem,
  type WorkStateCategory,
  type WorkStatusOption
} from '../../contract.js';
import { workflowStatusGroups, workflowStatusTone } from '../../browse.js';
import { isGroupCollapsed } from '../../browse-preferences.js';
import { WorkStateGlyph } from '../shared/work-state-glyph.js';
import { WorkItemRow } from './work-item-row.js';

export function ListStateGroups({
  items,
  statusOrder,
  projectsById,
  showProject,
  composerDragEnabled,
  idPrefix,
  nested = false,
  collapsedGroups,
  searchActive,
  onToggleGroup,
  onMove,
  onOpen
}: {
  items: readonly WorkItem[];
  statusOrder: readonly string[];
  projectsById: ReadonlyMap<string, TrackerProject>;
  showProject: boolean;
  composerDragEnabled: boolean;
  idPrefix: string;
  nested?: boolean;
  collapsedGroups: Readonly<Record<string, boolean>>;
  searchActive: boolean;
  onToggleGroup: (
    groupKey: string,
    category: WorkStateCategory
  ) => void;
  onMove: (item: WorkItem, option: WorkStatusOption) => Promise<void>;
  onOpen: (item: WorkItem) => void;
}) {
  return workflowStatusGroups(items, statusOrder).map(group => {
    const headingId = `${idPrefix}-state-${encodeURIComponent(group.key)}`;
    const contentId = `${headingId}-items`;
    const preferenceKey = `${idPrefix}:${group.key}`;
    const collapsed = isGroupCollapsed({
      overrides: collapsedGroups,
      groupKey: preferenceKey,
      category: group.category,
      searchActive
    });
    return (
      <section key={group.key} aria-labelledby={headingId}>
        <h3
          id={headingId}
          data-state-group-header={group.name}
          data-state-category={group.category}
          data-status-tone={workflowStatusTone(group.name, group.category)}
          className={cn(
            'tb-group-heading sticky z-10 h-8 border-b backdrop-blur-sm',
            nested ? 'top-9' : 'top-0'
          )}
        >
          <button
            type="button"
            aria-controls={contentId}
            aria-expanded={!collapsed}
            disabled={searchActive}
            title={searchActive ? 'Search keeps matching groups open' : undefined}
            className="flex h-full w-full items-center gap-2 px-2.5 text-left text-2xs font-semibold uppercase tracking-[0.12em] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:cursor-default"
            onClick={() => onToggleGroup(preferenceKey, group.category)}
          >
            <Icon
              name="ChevronDown"
              className={cn(
                'size-3 transition-transform',
                collapsed && '-rotate-90'
              )}
            />
            <WorkStateGlyph category={group.category} />
            <span className="truncate">{group.name}</span>
            <span className="tb-count-chip ml-auto rounded-full px-1.5 py-0.5 text-xs font-normal tabular-nums text-subtle-foreground">
              {group.items.length}
            </span>
          </button>
        </h3>
        <div id={contentId} hidden={collapsed}>
          {group.items.map(item => (
            <WorkItemRow
              key={`${item.bbProjectId}:${item.source}:${item.locator}`}
              item={item}
              project={projectsById.get(item.bbProjectId)}
              showProject={showProject}
              composerDragEnabled={composerDragEnabled}
              onMove={onMove}
              onOpen={() => onOpen(item)}
            />
          ))}
        </div>
      </section>
    );
  });
}
