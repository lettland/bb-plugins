import {
  applyNeighborReorder,
  buildNeighborReorderRequest,
} from "./neighbor-reorder.js";
import type { SidebarSectionId } from "./sidebar-section-id.js";
import { reorderStoredOrder } from "./stored-order.js";

type SidebarModeEntityKind = "project" | "section" | "machine";
type SidebarEntitySectionKind = SidebarModeEntityKind | "space";
export type LegacySidebarEntityAnchor = "projects" | "sections" | "machines";

export function buildSidebarEntitySectionId(
  kind: SidebarEntitySectionKind,
  id: string,
): SidebarSectionId {
  return `${kind}:${id}`;
}

function isSidebarSectionId(value: string): value is SidebarSectionId {
  return (
    value === "pinned" ||
    value === "threads" ||
    value.startsWith("project:") ||
    value.startsWith("section:") ||
    value.startsWith("machine:") ||
    value.startsWith("space:")
  );
}

interface ReorderSidebarSectionOrderArgs {
  activeId: string;
  overId: string;
  order: readonly SidebarSectionId[];
}

export function reorderSidebarSectionOrder({
  activeId,
  overId,
  order,
}: ReorderSidebarSectionOrderArgs): SidebarSectionId[] | null {
  if (!isSidebarSectionId(activeId) || !isSidebarSectionId(overId)) {
    return null;
  }
  const items = order.map((id) => ({ id }));
  const request = buildNeighborReorderRequest({ activeId, overId, items });
  if (!request) return null;
  return applyNeighborReorder({ items, request })
    .map((item) => item.id)
    .filter(isSidebarSectionId);
}

interface NormalizeSidebarSectionOrderArgs {
  storedOrder: readonly string[];
  entitySectionIds: readonly SidebarSectionId[];
  legacyEntityAnchor: LegacySidebarEntityAnchor;
  hasPinnedSection: boolean;
  hasThreadsSection?: boolean;
  spaceSectionIds?: readonly SidebarSectionId[];
}

export function normalizeSidebarSectionOrder({
  storedOrder,
  entitySectionIds,
  legacyEntityAnchor,
  hasPinnedSection,
  hasThreadsSection = true,
  spaceSectionIds = [],
}: NormalizeSidebarSectionOrderArgs): SidebarSectionId[] {
  const available = new Set<SidebarSectionId>([
    ...(hasPinnedSection ? (["pinned"] as const) : []),
    ...spaceSectionIds,
    ...entitySectionIds,
    ...(hasThreadsSection ? (["threads"] as const) : []),
  ]);
  const entitySet = new Set(entitySectionIds);
  const seen = new Set<SidebarSectionId>();
  const normalized: SidebarSectionId[] = [];
  let expandedLegacyAnchor = false;

  const append = (sectionId: SidebarSectionId) => {
    if (!available.has(sectionId) || seen.has(sectionId)) {
      return;
    }
    seen.add(sectionId);
    normalized.push(sectionId);
  };

  for (const storedId of storedOrder) {
    if (storedId === legacyEntityAnchor) {
      expandedLegacyAnchor = true;
      for (const entityId of entitySectionIds) {
        append(entityId);
      }
      continue;
    }
    if (isSidebarSectionId(storedId)) {
      append(storedId);
    }
  }

  if (hasPinnedSection && !seen.has("pinned")) {
    normalized.unshift("pinned");
    seen.add("pinned");
  }

  const missingSpaces = spaceSectionIds.filter(
    (sectionId) => !seen.has(sectionId),
  );
  if (missingSpaces.length > 0) {
    normalized.splice(normalized.indexOf("pinned") + 1, 0, ...missingSpaces);
    for (const sectionId of missingSpaces) {
      seen.add(sectionId);
    }
  }

  const missingEntities = entitySectionIds.filter(
    (sectionId) => !seen.has(sectionId),
  );
  if (missingEntities.length > 0) {
    const lastEntityIndex = normalized.reduce(
      (lastIndex, sectionId, index) =>
        entitySet.has(sectionId) ? index : lastIndex,
      -1,
    );
    const threadsIndex = normalized.indexOf("threads");
    const insertionIndex =
      lastEntityIndex >= 0
        ? lastEntityIndex + 1
        : threadsIndex >= 0 || expandedLegacyAnchor
          ? Math.max(threadsIndex, 0)
          : normalized.length;
    normalized.splice(insertionIndex, 0, ...missingEntities);
    for (const sectionId of missingEntities) {
      seen.add(sectionId);
    }
  }

  if (hasThreadsSection && !seen.has("threads")) {
    normalized.push("threads");
  }

  return normalized;
}

interface ApplyVisibleSidebarSectionOrderArgs {
  storedOrder: readonly string[];
  nextVisibleOrder: readonly SidebarSectionId[];
  entitySectionIds: readonly SidebarSectionId[];
  entityKind: SidebarModeEntityKind;
  legacyEntityAnchor: LegacySidebarEntityAnchor;
  hasThreadsSection?: boolean;
  spaceSectionIds?: readonly SidebarSectionId[];
}

export function applyVisibleSidebarSectionOrder({
  storedOrder,
  nextVisibleOrder,
  entitySectionIds,
  entityKind,
  legacyEntityAnchor,
  hasThreadsSection,
  spaceSectionIds,
}: ApplyVisibleSidebarSectionOrderArgs): SidebarSectionId[] | null {
  const nextIds = new Set(nextVisibleOrder);
  const storedEntityIds = storedOrder
    .filter((id) => id.startsWith(`${entityKind}:`))
    .map((id) =>
      buildSidebarEntitySectionId(entityKind, id.slice(entityKind.length + 1)),
    );
  const fullOrder = normalizeSidebarSectionOrder({
    storedOrder,
    entitySectionIds: [...entitySectionIds, ...storedEntityIds],
    legacyEntityAnchor,
    hasPinnedSection: true,
    hasThreadsSection:
      hasThreadsSection !== false || storedOrder.includes("threads"),
    ...(spaceSectionIds === undefined ? {} : { spaceSectionIds }),
  });
  return reorderStoredOrder({
    order: fullOrder,
    visibleIds: fullOrder.filter((id) => nextIds.has(id)),
    nextVisibleIds: nextVisibleOrder,
  });
}

interface InsertSidebarSectionAfterArgs {
  storedOrder: readonly string[];
  entitySectionIds: readonly SidebarSectionId[];
  legacyEntityAnchor: LegacySidebarEntityAnchor;
  anchorSectionId: SidebarSectionId;
  sectionId: SidebarSectionId;
  spaceSectionIds?: readonly SidebarSectionId[];
}

export function insertSidebarSectionAfter({
  storedOrder,
  entitySectionIds,
  legacyEntityAnchor,
  anchorSectionId,
  sectionId,
  spaceSectionIds,
}: InsertSidebarSectionAfterArgs): SidebarSectionId[] | null {
  if (anchorSectionId === sectionId) {
    return null;
  }
  const isSpaceSection = sectionId.startsWith("space:");
  const normalized = normalizeSidebarSectionOrder({
    storedOrder,
    entitySectionIds: isSpaceSection
      ? entitySectionIds
      : [...entitySectionIds, sectionId],
    legacyEntityAnchor,
    hasPinnedSection: true,
    spaceSectionIds: isSpaceSection
      ? [...(spaceSectionIds ?? []), sectionId]
      : (spaceSectionIds ?? []),
  }).filter((id) => id !== sectionId);
  const anchorIndex = normalized.indexOf(anchorSectionId);
  if (anchorIndex === -1) {
    return null;
  }
  normalized.splice(anchorIndex + 1, 0, sectionId);
  return normalized;
}

export function insertSpaceAfterPinned(
  storedOrder: readonly string[],
  spaceSectionId: SidebarSectionId,
): string[] {
  if (storedOrder.includes(spaceSectionId)) {
    return [...storedOrder];
  }
  const next = [...storedOrder];
  next.splice(next.indexOf("pinned") + 1, 0, spaceSectionId);
  return next;
}
