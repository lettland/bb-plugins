import { useCallback, useMemo, type ReactNode } from "react";
import { useAtom, useAtomValue } from "jotai";
import type { ConsumeDragClickSuppression } from "@/components/ui/use-drag-click-suppression";
import {
  buildProjectThreadGroups,
  getProjectThreadItemDescendants,
  isSidebarProjectThread,
  type ProjectThreadItem,
  type ThreadComparator,
} from "../model/project-thread-groups.js";
import type { SidebarSectionId } from "../model/sidebar-section-id.js";
import type { SidebarSpace } from "../model/use-sidebar-data.js";
import {
  collapsedProjectIdsAtom,
  sidebarGroupThreadsByEnvironmentAtom,
} from "../preferences/atoms.js";
import { ProjectThreadTree } from "./ProjectRow.js";
import {
  getSpaceSectionId,
  SpaceSection,
  type SpaceSectionTarget,
} from "./SpaceSection.js";
import {
  ThreadListVisibilityGroupScope,
  type ThreadListVisibilityGroup,
} from "./ThreadListVisibility.js";

export interface SpaceActions {
  onCreateThread: (spaceId: string) => void;
  onDelete: (space: SpaceSectionTarget) => void;
  onEditBrief: (space: SpaceSectionTarget) => void;
}

interface UseSpaceSectionsArgs {
  actions: SpaceActions;
  collapsedEnvironmentIds: Set<string>;
  collapsedThreadIds: Set<string>;
  compareThreads: ThreadComparator;
  effectivePinnedThreadIds: ReadonlySet<string>;
  onProjectSelect?: () => void;
  onToggleEnvironmentCollapsed: (environmentId: string) => void;
  onToggleThreadCollapsed: (threadId: string) => void;
  selectedThreadId?: string;
  spaces: readonly SidebarSpace[];
}

export interface SpaceSections {
  renderSpace: (
    sectionId: SidebarSectionId,
    disabled: boolean,
    consumeClickSuppression?: ConsumeDragClickSuppression,
  ) => ReactNode;
  sectionIds: SidebarSectionId[];
  visibilityGroups: ThreadListVisibilityGroup[];
}

interface SpaceSectionModel {
  items: ProjectThreadItem[];
  sectionId: SidebarSectionId;
  space: SidebarSpace;
  threads: SidebarSpace["threads"];
}

export const NO_SPACE_SECTIONS: SpaceSections = {
  renderSpace: () => null,
  sectionIds: [],
  visibilityGroups: [],
};

function compareSpacesByName(left: SidebarSpace, right: SidebarSpace): number {
  return left.name.localeCompare(right.name) || left.id.localeCompare(right.id);
}

export function useSpaceSections({
  actions,
  collapsedEnvironmentIds,
  collapsedThreadIds,
  compareThreads,
  effectivePinnedThreadIds,
  onProjectSelect,
  onToggleEnvironmentCollapsed,
  onToggleThreadCollapsed,
  selectedThreadId,
  spaces,
}: UseSpaceSectionsArgs): SpaceSections {
  const groupThreadsByEnvironment = useAtomValue(
    sidebarGroupThreadsByEnvironmentAtom,
  );
  const [collapsedKeys, setCollapsedKeys] = useAtom(collapsedProjectIdsAtom);
  const collapsedKeySet = useMemo(() => new Set(collapsedKeys), [collapsedKeys]);
  const models = useMemo<SpaceSectionModel[]>(
    () =>
      [...spaces].sort(compareSpacesByName).map((space) => {
        const threads = space.threads.filter(
          (thread) =>
            !effectivePinnedThreadIds.has(thread.id) &&
            isSidebarProjectThread(thread),
        );
        return {
          items: buildProjectThreadGroups(
            threads,
            compareThreads,
            groupThreadsByEnvironment,
          ),
          sectionId: getSpaceSectionId(space.id),
          space,
          threads,
        };
      }),
    [compareThreads, effectivePinnedThreadIds, groupThreadsByEnvironment, spaces],
  );
  const modelsBySectionId = useMemo(
    () => new Map(models.map((model) => [model.sectionId, model])),
    [models],
  );
  const sectionIds = useMemo(
    () => models.map((model) => model.sectionId),
    [models],
  );
  const toggleCollapsed = useCallback(
    (spaceId: string) => {
      const key = getSpaceSectionId(spaceId);
      setCollapsedKeys((current) =>
        current.includes(key)
          ? current.filter((value) => value !== key)
          : [...current, key],
      );
    },
    [setCollapsedKeys],
  );
  const visibilityGroups = useMemo<ThreadListVisibilityGroup[]>(
    () =>
      models.map((model) => ({
        id: model.sectionId,
        title: model.space.name,
        threads: getProjectThreadItemDescendants(model.items),
        onNewThread: () => actions.onCreateThread(model.space.id),
        renderContent: (close: () => void) => (
          <ProjectThreadTree
            rootItems={model.items}
            threadListState={{ status: "ready", threads: model.threads }}
            selectedThreadId={selectedThreadId}
            collapsedThreadIds={collapsedThreadIds}
            collapsedEnvironmentIds={collapsedEnvironmentIds}
            compareThreads={compareThreads}
            onProjectSelect={() => {
              close();
              onProjectSelect?.();
            }}
            onToggleThreadCollapsed={onToggleThreadCollapsed}
            onToggleEnvironmentCollapsed={onToggleEnvironmentCollapsed}
          />
        ),
      })),
    [
      actions,
      collapsedEnvironmentIds,
      collapsedThreadIds,
      compareThreads,
      models,
      onProjectSelect,
      onToggleEnvironmentCollapsed,
      onToggleThreadCollapsed,
      selectedThreadId,
    ],
  );
  const renderSpace = useCallback<SpaceSections["renderSpace"]>(
    (sectionId, disabled, consumeClickSuppression) => {
      const model = modelsBySectionId.get(sectionId);
      if (model === undefined) return null;
      return (
        <ThreadListVisibilityGroupScope key={sectionId} id={sectionId}>
          <SpaceSection
            space={model.space}
            rootItems={model.items}
            threads={model.threads}
            disabled={disabled}
            isCollapsed={collapsedKeySet.has(sectionId)}
            consumeClickSuppression={consumeClickSuppression}
            selectedThreadId={selectedThreadId}
            collapsedThreadIds={collapsedThreadIds}
            collapsedEnvironmentIds={collapsedEnvironmentIds}
            compareThreads={compareThreads}
            onProjectSelect={onProjectSelect}
            onCreateThread={actions.onCreateThread}
            onDelete={actions.onDelete}
            onEditBrief={actions.onEditBrief}
            onToggleCollapsed={toggleCollapsed}
            onToggleThreadCollapsed={onToggleThreadCollapsed}
            onToggleEnvironmentCollapsed={onToggleEnvironmentCollapsed}
          />
        </ThreadListVisibilityGroupScope>
      );
    },
    [
      actions,
      collapsedEnvironmentIds,
      collapsedKeySet,
      collapsedThreadIds,
      compareThreads,
      modelsBySectionId,
      onProjectSelect,
      onToggleEnvironmentCollapsed,
      onToggleThreadCollapsed,
      selectedThreadId,
      toggleCollapsed,
    ],
  );
  return { renderSpace, sectionIds, visibilityGroups };
}
