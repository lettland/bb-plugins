import { z } from 'zod';
import type { TrackerView } from '../board-settings.js';
import type { WorkSource } from '../contract.js';

export const BROWSE_PREFERENCES_VERSION = 1 as const;
export const CREATE_ASSIGNEE_DEFAULT_VERSION = 1 as const;
export const ACROSS_PROJECTS_SCOPE = 'across-projects' as const;
export const MAX_BROWSE_QUERY_LENGTH = 500;

export const BROWSE_STORAGE_PREFIX = 'bb-taskboard:browse-preferences:';
export const CREATE_ASSIGNEE_STORAGE_PREFIX =
  'bb-taskboard:create-assignee-default:';
export const ALL_SOURCES = 'all' as const;
const MAX_FILTER_VALUES = 100;
const MAX_COLLAPSE_OVERRIDES = 100;

const trackerViewPreferenceSchema = z.enum(['list', 'kanban']);
export const workSourcePreferenceSchema = z.enum(['linear', 'github', 'jira']);
export const workStateCategoryPreferenceSchema = z.enum([
  'backlog',
  'todo',
  'in_progress',
  'done',
  'canceled'
]);
export const boundedValueSchema = z.string().trim().min(1).max(500);
const sourceFilterSchema = z.union([
  z.literal(ALL_SOURCES),
  workSourcePreferenceSchema
]);
const uniqueValuesSchema = z
  .array(boundedValueSchema)
  .max(MAX_FILTER_VALUES)
  .transform(values => [...new Set(values)]);
export const collapseOverridesSchema = z
  .record(boundedValueSchema, z.boolean())
  .superRefine((overrides, context) => {
    if (Object.keys(overrides).length > MAX_COLLAPSE_OVERRIDES) {
      context.addIssue({
        code: 'custom',
        message: `At most ${MAX_COLLAPSE_OVERRIDES} collapse overrides are allowed`
      });
    }
  });

export const browsePreferencesV1Schema = z
  .object({
    version: z.literal(BROWSE_PREFERENCES_VERSION),
    provider: workSourcePreferenceSchema.nullable(),
    source: sourceFilterSchema,
    view: trackerViewPreferenceSchema,
    query: z.string().max(MAX_BROWSE_QUERY_LENGTH).default(''),
    stateCategories: z
      .array(workStateCategoryPreferenceSchema)
      .max(5)
      .transform(values => [...new Set(values)]),
    statuses: uniqueValuesSchema,
    assignees: uniqueValuesSchema,
    priorities: uniqueValuesSchema,
    externalProjects: uniqueValuesSchema,
    labels: uniqueValuesSchema,
    collapsedGroups: collapseOverridesSchema
  })
  .strict();

export type BrowsePreferences = z.infer<typeof browsePreferencesV1Schema>;
export type SourceFilter = z.infer<typeof sourceFilterSchema>;
export type ProjectBrowseScope = `project:${string}`;
export type BrowsePreferenceScope =
  | typeof ACROSS_PROJECTS_SCOPE
  | ProjectBrowseScope;

export interface BrowsePreferenceSeed {
  provider?: WorkSource | null;
  source?: SourceFilter;
  view?: TrackerView;
}

export interface PreferenceStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface BrowsePreferenceStoreOptions {
  storage?: PreferenceStorage | null;
  subscribeToStorage?: (
    listener: (key: string | null) => void
  ) => () => void;
}

export interface BrowsePreferenceStore {
  get(
    scope: BrowsePreferenceScope,
    seed?: BrowsePreferenceSeed
  ): BrowsePreferences;
  seed(
    scope: BrowsePreferenceScope,
    seed: BrowsePreferenceSeed
  ): BrowsePreferences;
  set(
    scope: BrowsePreferenceScope,
    preferences: BrowsePreferences
  ): BrowsePreferences;
  update(
    scope: BrowsePreferenceScope,
    update: (preferences: BrowsePreferences) => BrowsePreferences,
    seed?: BrowsePreferenceSeed
  ): BrowsePreferences;
  clearFilters(
    scope: BrowsePreferenceScope,
    seed?: BrowsePreferenceSeed
  ): BrowsePreferences;
  reconcileProvider(
    scope: ProjectBrowseScope,
    provider: WorkSource,
    seed?: BrowsePreferenceSeed
  ): BrowsePreferences;
  reset(
    scope: BrowsePreferenceScope,
    seed?: BrowsePreferenceSeed
  ): BrowsePreferences;
  subscribe(scope: BrowsePreferenceScope, listener: () => void): () => void;
  dispose(): void;
}

export const browsePreferenceScopeSchema = z.union([
  z.literal(ACROSS_PROJECTS_SCOPE),
  z.string().trim().min(9).max(520).refine(value => {
    return value.startsWith('project:') && value.length > 'project:'.length;
  })
]);
