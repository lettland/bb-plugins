import type { WorkSource } from '../contract.js';
import {
  ALL_SOURCES,
  BROWSE_PREFERENCES_VERSION,
  BROWSE_STORAGE_PREFIX,
  boundedValueSchema,
  browsePreferenceScopeSchema,
  browsePreferencesV1Schema,
  workSourcePreferenceSchema,
  type BrowsePreferenceScope,
  type BrowsePreferenceSeed,
  type BrowsePreferences,
  type ProjectBrowseScope
} from './schemas.ts';

export function projectBrowseScope(projectId: string): ProjectBrowseScope {
  const normalizedProjectId = boundedValueSchema.parse(projectId);
  return `project:${normalizedProjectId}`;
}

export function browsePreferenceStorageKey(
  scope: BrowsePreferenceScope
): string {
  const parsedScope = parseBrowseScope(scope);
  return `${BROWSE_STORAGE_PREFIX}${encodeURIComponent(parsedScope)}`;
}

export function defaultBrowsePreferences(
  seed: BrowsePreferenceSeed = {}
): BrowsePreferences {
  return browsePreferencesV1Schema.parse({
    version: BROWSE_PREFERENCES_VERSION,
    provider: seed.provider ?? null,
    source: seed.source ?? ALL_SOURCES,
    view: seed.view ?? 'list',
    query: '',
    stateCategories: [],
    statuses: [],
    assignees: [],
    priorities: [],
    externalProjects: [],
    labels: [],
    collapsedGroups: {}
  });
}

export function parseBrowsePreferences(
  value: unknown,
  fallback: BrowsePreferences = defaultBrowsePreferences()
): BrowsePreferences {
  const parsed = browsePreferencesV1Schema.safeParse(value);
  return parsed.success
    ? parsed.data
    : cloneBrowsePreferences(validatedFallback(fallback));
}

export function parseBrowsePreferencesJson(
  serialized: string | null,
  fallback: BrowsePreferences = defaultBrowsePreferences()
): BrowsePreferences {
  if (serialized === null) {
    return cloneBrowsePreferences(validatedFallback(fallback));
  }
  try {
    return parseBrowsePreferences(JSON.parse(serialized), fallback);
  } catch {
    return cloneBrowsePreferences(validatedFallback(fallback));
  }
}

export function clearBrowseFilters(
  preferences: BrowsePreferences
): BrowsePreferences {
  const current = browsePreferencesV1Schema.parse(preferences);
  return {
    ...current,
    source: ALL_SOURCES,
    query: '',
    stateCategories: [],
    statuses: [],
    assignees: [],
    priorities: [],
    externalProjects: [],
    labels: []
  };
}

export function reconcileBrowseProvider(
  preferences: BrowsePreferences,
  provider: WorkSource
): BrowsePreferences {
  const current = browsePreferencesV1Schema.parse(preferences);
  const nextProvider = workSourcePreferenceSchema.parse(provider);
  if (current.provider === nextProvider) return current;
  return defaultBrowsePreferences({
    provider: nextProvider,
    view: current.view
  });
}

export function parseBrowseScope(scope: string): BrowsePreferenceScope {
  const parsed = browsePreferenceScopeSchema.parse(scope);
  return parsed as BrowsePreferenceScope;
}

export function browseScopeFromStorageKey(
  storageKey: string
): BrowsePreferenceScope | null {
  if (!storageKey.startsWith(BROWSE_STORAGE_PREFIX)) return null;
  try {
    const scope = decodeURIComponent(storageKey.slice(BROWSE_STORAGE_PREFIX.length));
    const parsed = browsePreferenceScopeSchema.safeParse(scope);
    return parsed.success ? (parsed.data as BrowsePreferenceScope) : null;
  } catch {
    return null;
  }
}

export function parseStoredBrowsePreferences(
  serialized: string | null
): BrowsePreferences | null {
  if (serialized === null) return null;
  try {
    const parsed = browsePreferencesV1Schema.safeParse(JSON.parse(serialized));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function validatedFallback(fallback: BrowsePreferences): BrowsePreferences {
  const parsed = browsePreferencesV1Schema.safeParse(fallback);
  return parsed.success ? parsed.data : defaultBrowsePreferences();
}

export function cloneBrowsePreferences(
  preferences: BrowsePreferences
): BrowsePreferences {
  return {
    ...preferences,
    query: preferences.query,
    stateCategories: [...preferences.stateCategories],
    statuses: [...preferences.statuses],
    assignees: [...preferences.assignees],
    priorities: [...preferences.priorities],
    externalProjects: [...preferences.externalProjects],
    labels: [...preferences.labels],
    collapsedGroups: { ...preferences.collapsedGroups }
  };
}

export function browsePreferencesEqual(
  left: BrowsePreferences,
  right: BrowsePreferences
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
