import { useCallback, useMemo } from "react";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import {
  sidebarHiddenGroupsAtom,
  sidebarManualSectionOrderAtom,
  sidebarMachineSectionOrderAtom,
  sidebarOrganizationModeAtom,
  sidebarSectionOrderAtom,
} from "../preferences/atoms.js";
import type { OrganizationMode as SidebarOrganizationMode } from "../../shared/preferences.js";
import type { SidebarSectionId } from "../model/sidebar-section-id.js";
import {
  applyVisibleSidebarSectionOrder,
  insertSpaceAfterPinned,
  normalizeSidebarSectionOrder,
  type LegacySidebarEntityAnchor,
} from "../model/sidebar-section-order.js";

const NO_SPACE_SECTION_IDS: readonly SidebarSectionId[] = [];

const MODE_SECTION_ORDER_CONFIG: Record<
  SidebarOrganizationMode,
  {
    atom: typeof sidebarSectionOrderAtom;
    entityKind: "project" | "section" | "machine";
    legacyEntityAnchor: LegacySidebarEntityAnchor;
  }
> = {
  project: {
    atom: sidebarSectionOrderAtom,
    entityKind: "project",
    legacyEntityAnchor: "projects",
  },
  chronological: {
    atom: sidebarManualSectionOrderAtom,
    entityKind: "section",
    legacyEntityAnchor: "sections",
  },
  machine: {
    atom: sidebarMachineSectionOrderAtom,
    entityKind: "machine",
    legacyEntityAnchor: "machines",
  },
};

interface UseSidebarModeSectionOrderArgs {
  entitySectionIds: readonly SidebarSectionId[];
  hasThreadsSection?: boolean;
  mode: SidebarOrganizationMode;
  showPinnedSection: boolean;
  spaceSectionIds?: readonly SidebarSectionId[];
}

export function useInsertSpaceInModeOrder(): (
  spaceSectionId: SidebarSectionId,
) => void {
  const mode = useAtomValue(sidebarOrganizationModeAtom);
  const setStoredOrder = useSetAtom(MODE_SECTION_ORDER_CONFIG[mode].atom);
  return useCallback(
    (spaceSectionId) =>
      setStoredOrder((current) =>
        insertSpaceAfterPinned(current, spaceSectionId),
      ),
    [setStoredOrder],
  );
}

interface UseSidebarModeSectionOrderResult {
  onOrderChange: (order: SidebarSectionId[]) => void;
  order: SidebarSectionId[];
  persistedOrder: SidebarSectionId[];
}

export function useSidebarModeSectionOrder({
  entitySectionIds,
  hasThreadsSection,
  mode,
  showPinnedSection,
  spaceSectionIds = NO_SPACE_SECTION_IDS,
}: UseSidebarModeSectionOrderArgs): UseSidebarModeSectionOrderResult {
  const config = MODE_SECTION_ORDER_CONFIG[mode];
  const [storedOrder, setStoredOrder] = useAtom(config.atom);
  const hiddenGroups = useAtomValue(sidebarHiddenGroupsAtom);
  const hiddenGroupIds = useMemo(
    () => new Set<string>(hiddenGroups),
    [hiddenGroups],
  );
  const persistedOrder = useMemo(
    () =>
      normalizeSidebarSectionOrder({
        storedOrder,
        entitySectionIds,
        legacyEntityAnchor: config.legacyEntityAnchor,
        hasPinnedSection: true,
        spaceSectionIds,
        ...(hasThreadsSection === undefined ? {} : { hasThreadsSection }),
      }),
    [
      config.legacyEntityAnchor,
      entitySectionIds,
      hasThreadsSection,
      spaceSectionIds,
      storedOrder,
    ],
  );
  const order = useMemo(
    () =>
      persistedOrder.filter(
        (sectionId) =>
          (sectionId !== "pinned" || showPinnedSection) &&
          !hiddenGroupIds.has(sectionId),
      ),
    [hiddenGroupIds, persistedOrder, showPinnedSection],
  );
  const onOrderChange = useCallback(
    (nextOrder: SidebarSectionId[]) => {
      setStoredOrder(
        (current) =>
          applyVisibleSidebarSectionOrder({
            storedOrder: current,
            nextVisibleOrder: nextOrder,
            entitySectionIds,
            entityKind: config.entityKind,
            legacyEntityAnchor: config.legacyEntityAnchor,
            hasThreadsSection,
            spaceSectionIds,
          }) ?? current,
      );
    },
    [
      config,
      entitySectionIds,
      hasThreadsSection,
      setStoredOrder,
      spaceSectionIds,
    ],
  );
  return { onOrderChange, order, persistedOrder };
}
