import type { WorkStateCategory } from '../contract.js';
import {
  boundedValueSchema,
  collapseOverridesSchema,
  workStateCategoryPreferenceSchema
} from './schemas.ts';

export function isTerminalStateCategory(
  category: WorkStateCategory
): boolean {
  return category === 'done' || category === 'canceled';
}

export function isGroupCollapsed({
  overrides,
  groupKey,
  category,
  searchActive = false,
  hasSearchMatch = true
}: {
  overrides: Readonly<Record<string, boolean>>;
  groupKey: string;
  category: WorkStateCategory;
  searchActive?: boolean;
  hasSearchMatch?: boolean;
}): boolean {
  if (searchActive && hasSearchMatch) return false;
  return overrides[groupKey] ?? isTerminalStateCategory(category);
}

export function setGroupCollapsedOverride(
  overrides: Readonly<Record<string, boolean>>,
  groupKey: string,
  category: WorkStateCategory,
  collapsed: boolean
): Record<string, boolean> {
  const parsedKey = boundedValueSchema.parse(groupKey);
  workStateCategoryPreferenceSchema.parse(category);
  const next = { ...overrides };
  if (collapsed === isTerminalStateCategory(category)) {
    delete next[parsedKey];
  } else {
    next[parsedKey] = collapsed;
  }
  return collapseOverridesSchema.parse(next);
}

export function toggleGroupCollapsedOverride(
  overrides: Readonly<Record<string, boolean>>,
  groupKey: string,
  category: WorkStateCategory
): Record<string, boolean> {
  return setGroupCollapsedOverride(
    overrides,
    groupKey,
    category,
    !isGroupCollapsed({ overrides, groupKey, category })
  );
}
