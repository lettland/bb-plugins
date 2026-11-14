import { memo, useCallback, useState, type ReactNode } from "react";
import { useSdk } from "@get-bb/plugin-sdk/app";
import {
  ActionMenuItem,
  ActionMenuSeparator,
  type ActionMenuSurface,
} from "@/components/ui/action-menu-items";
import { CompactLongPressMenu } from "@/components/ui/compact-long-press-menu";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { useIsCompactViewport } from "@/components/ui/hooks/use-compact-viewport";
import type { ConsumeDragClickSuppression } from "@/components/ui/use-drag-click-suppression";
import { readSpacesArea } from "../../fork-sdk-types.js";
import type { ProjectThreadItem, ThreadComparator } from "../model/project-thread-groups.js";
import type { SidebarSectionId } from "../model/sidebar-section-id.js";
import { buildSidebarEntitySectionId } from "../model/sidebar-section-order.js";
import type { SidebarThread } from "../model/sidebar-thread.js";
import { useSidebarRename } from "../rows/SidebarInlineRename.js";
import { SortableSidebarSection } from "./BuiltInSidebarSection.js";
import { ProjectThreadTree } from "./ProjectRow.js";
import {
  SidebarHeaderControls,
} from "./SidebarHeaderControls.js";
import { ThreadListVisibilityMenuItems } from "./ThreadListVisibility.js";

export interface SpaceSectionTarget {
  id: string;
  name: string;
  archivedAt: number | null;
}

interface SpaceSectionProps {
  collapsedEnvironmentIds: Set<string>;
  collapsedThreadIds: Set<string>;
  compareThreads: ThreadComparator;
  consumeClickSuppression?: ConsumeDragClickSuppression;
  disabled: boolean;
  isCollapsed: boolean;
  onCreateThread: (spaceId: string) => void;
  onEditBrief: (space: SpaceSectionTarget) => void;
  onProjectSelect?: () => void;
  onToggleArchived: (space: SpaceSectionTarget) => void;
  onToggleCollapsed: (spaceId: string) => void;
  onToggleEnvironmentCollapsed: (environmentId: string) => void;
  onToggleThreadCollapsed: (threadId: string) => void;
  rootItems: readonly ProjectThreadItem[];
  selectedThreadId?: string;
  space: SpaceSectionTarget;
  threads: SidebarThread[];
}

export function getSpaceSectionId(spaceId: string): SidebarSectionId {
  return buildSidebarEntitySectionId("space", spaceId);
}

function SpaceMenuItems({
  surface,
  isArchived,
  onEditBrief,
  onRename,
  onToggleArchived,
}: {
  surface: ActionMenuSurface;
  isArchived: boolean;
  onEditBrief: () => void;
  onRename: () => void;
  onToggleArchived: () => void;
}) {
  return (
    <>
      <ActionMenuItem surface={surface} icon="Edit" onSelect={onEditBrief}>
        Edit brief…
      </ActionMenuItem>
      <ActionMenuItem surface={surface} icon="Edit" onSelect={onRename}>
        Rename…
      </ActionMenuItem>
      <ThreadListVisibilityMenuItems surface={surface} />
      <ActionMenuSeparator surface={surface} />
      <ActionMenuItem
        surface={surface}
        icon={isArchived ? "ArchiveRestore" : "Archive"}
        onSelect={onToggleArchived}
      >
        {isArchived ? "Unarchive Space" : "Archive Space"}
      </ActionMenuItem>
    </>
  );
}

function SpaceContextMenu({
  children,
  disabled,
  items,
  label,
  onCloseAutoFocus,
  onOpenChange,
}: {
  children: ReactNode;
  disabled: boolean;
  items: (surface: ActionMenuSurface) => ReactNode;
  label: string;
  onCloseAutoFocus: (event: Event) => void;
  onOpenChange: (open: boolean) => void;
}) {
  const isCompactViewport = useIsCompactViewport();
  if (isCompactViewport) {
    return (
      <CompactLongPressMenu
        label={`${label} actions`}
        onOpenChange={onOpenChange}
        disabled={disabled}
        items={items("dropdown")}
      >
        {children}
      </CompactLongPressMenu>
    );
  }
  return (
    <ContextMenu onOpenChange={onOpenChange}>
      <ContextMenuTrigger asChild disabled={disabled}>
        {children}
      </ContextMenuTrigger>
      <ContextMenuContent
        aria-label={`${label} actions`}
        onCloseAutoFocus={onCloseAutoFocus}
        onClick={(event) => event.stopPropagation()}
      >
        {items("context")}
      </ContextMenuContent>
    </ContextMenu>
  );
}

export const SpaceSection = memo(function SpaceSection({
  collapsedEnvironmentIds,
  collapsedThreadIds,
  compareThreads,
  consumeClickSuppression,
  disabled,
  isCollapsed,
  onCreateThread,
  onEditBrief,
  onProjectSelect,
  onToggleArchived,
  onToggleCollapsed,
  onToggleEnvironmentCollapsed,
  onToggleThreadCollapsed,
  rootItems,
  selectedThreadId,
  space,
  threads,
}: SpaceSectionProps) {
  const sdk = useSdk();
  const sectionId = getSpaceSectionId(space.id);
  const rename = useSidebarRename({
    kind: "space",
    id: space.id,
    ownerKey: sectionId,
    name: space.name,
    label: "Space name",
    maxLength: 100,
    onSave: (name) => {
      const spaces = readSpacesArea(sdk);
      if (spaces === null) {
        return Promise.reject(new Error("Spaces are unavailable."));
      }
      return spaces.update({ id: space.id, name });
    },
  });
  const [isDropdownOpen, setIsDropdownOpen] = useState(false);
  const [isContextOpen, setIsContextOpen] = useState(false);
  const handleToggleCollapsed = useCallback(
    () => onToggleCollapsed(space.id),
    [onToggleCollapsed, space.id],
  );
  const handleEditBrief = useCallback(() => onEditBrief(space), [onEditBrief, space]);
  const handleToggleArchived = useCallback(
    () => onToggleArchived(space),
    [onToggleArchived, space],
  );
  const isArchived = space.archivedAt !== null;
  const renderItems = (surface: ActionMenuSurface) => (
    <SpaceMenuItems
      surface={surface}
      isArchived={isArchived}
      onEditBrief={handleEditBrief}
      onRename={rename.startEditingFromMenu}
      onToggleArchived={handleToggleArchived}
    />
  );
  const actions = (
    <SidebarHeaderControls
      label={space.name}
      sectionId={sectionId}
      onNewThread={() => onCreateThread(space.id)}
      showNewThread={!isArchived}
      open={isDropdownOpen}
      onOpenChange={setIsDropdownOpen}
      onCloseAutoFocus={rename.onCloseAutoFocus}
    >
      {renderItems("dropdown")}
    </SidebarHeaderControls>
  );
  return (
    <SpaceContextMenu
      label={space.name}
      disabled={rename.isEditing}
      items={renderItems}
      onCloseAutoFocus={rename.onCloseAutoFocus}
      onOpenChange={setIsContextOpen}
    >
      <div data-sidebar-space-id={space.id}>
        <SortableSidebarSection
          id={sectionId}
          sectionId={space.id}
          label={isArchived ? `${space.name} (archived)` : space.name}
          labelEditor={rename.editor}
          onRename={rename.startEditingFromDoubleClick}
          disabled={disabled || rename.isEditing}
          actions={actions}
          actionsMobileAlways
          actionsOpen={isDropdownOpen || isContextOpen}
          collapseControl={{
            isCollapsed,
            onToggleCollapsed: handleToggleCollapsed,
          }}
          collapsedThreads={threads}
          consumeClickSuppression={consumeClickSuppression}
        >
          <ProjectThreadTree
            rootItems={rootItems}
            threadListState={{ status: "ready", threads }}
            selectedThreadId={selectedThreadId}
            collapsedThreadIds={collapsedThreadIds}
            collapsedEnvironmentIds={collapsedEnvironmentIds}
            compareThreads={compareThreads}
            onProjectSelect={onProjectSelect}
            onToggleThreadCollapsed={onToggleThreadCollapsed}
            onToggleEnvironmentCollapsed={onToggleEnvironmentCollapsed}
          />
        </SortableSidebarSection>
      </div>
    </SpaceContextMenu>
  );
});
