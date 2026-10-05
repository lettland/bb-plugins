import { z } from 'zod';
import {
  browsePreferencesV1Schema,
  type BrowsePreferences
} from './browse-preferences.ts';

export const FILTER_PRESET_NAME_MAX_LENGTH = 60;
export const FILTER_PRESET_NORMALIZED_NAME_MAX_LENGTH = 240;
export const FILTER_PRESET_ID_MAX_LENGTH = 100;
export const FILTER_PRESET_PROJECT_ID_MAX_LENGTH = 500;
export const FILTER_PRESET_LIMIT = 50;
export const FILTER_PRESET_STATE_JSON_MAX_LENGTH = 910_000;
export const FILTER_PRESET_PROJECT_STATE_BYTES_MAX = 950_000;

const FILTER_PRESET_VALUE_LIMIT = 100;
const FILTER_PRESET_COLLAPSED_GROUP_LIMIT = 100;
const FILTER_PRESET_VALUE_MAX_LENGTH = 500;
const FILTER_PRESET_QUERY_MAX_LENGTH = 500;
const FILTER_PRESET_STATE_CATEGORY_LIMIT = 5;
const FILTER_PRESET_TOP_LEVEL_KEYS = new Set([
  'version',
  'provider',
  'source',
  'view',
  'query',
  'stateCategories',
  'statuses',
  'assignees',
  'priorities',
  'externalProjects',
  'labels',
  'collapsedGroups'
]);

const unsafeControlCharacters =
  /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/u;

function hasUnsafeControlCharacters(value: string): boolean {
  return unsafeControlCharacters.test(value);
}

export const filterPresetProjectIdSchema = z
  .string()
  .startsWith('proj_')
  .min(6)
  .max(FILTER_PRESET_PROJECT_ID_MAX_LENGTH)
  .refine(
    value =>
      value.length > FILTER_PRESET_PROJECT_ID_MAX_LENGTH ||
      !hasUnsafeControlCharacters(value),
    {
    message: 'Project id cannot contain control characters'
    }
  );

function presetTextSchema(label: 'id' | 'name', maxLength: number) {
  return z
    .string()
    .superRefine((value, context) => {
      if (value.length > maxLength) {
        context.addIssue({
          code: 'custom',
          message: `Preset ${label} must contain at most ${maxLength} characters`
        });
        return;
      }
      if (hasUnsafeControlCharacters(value)) {
        context.addIssue({
          code: 'custom',
          message: `Preset ${label} cannot contain control characters`
        });
      }
    })
    .trim()
    .min(1)
    .max(maxLength);
}

export const filterPresetIdSchema = presetTextSchema(
  'id',
  FILTER_PRESET_ID_MAX_LENGTH
);

export const filterPresetNameSchema = presetTextSchema(
  'name',
  FILTER_PRESET_NAME_MAX_LENGTH
);

function inspectBoundedString(
  value: unknown,
  maxLength: number,
  path: Array<string | number>,
  context: z.core.$RefinementCtx<unknown>
): void {
  if (typeof value !== 'string') return;
  if (value.length > maxLength) {
    context.addIssue({
      code: 'custom',
      path,
      message: `String must contain at most ${maxLength} characters`
    });
    return;
  }
  if (hasUnsafeControlCharacters(value)) {
    context.addIssue({
      code: 'custom',
      path,
      message: 'Preset state cannot contain control characters'
    });
  }
}

function ownDataValue(
  object: Record<string, unknown>,
  key: string,
  context: z.core.$RefinementCtx<unknown>
): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  if (!descriptor) return undefined;
  if (!('value' in descriptor)) {
    context.addIssue({
      code: 'custom',
      path: [key],
      message: 'Preset state must contain plain data properties'
    });
    return undefined;
  }
  return descriptor.value;
}

function inspectBoundedStringArray(
  object: Record<string, unknown>,
  key: string,
  maxItems: number,
  context: z.core.$RefinementCtx<unknown>
): void {
  const value = ownDataValue(object, key, context);
  if (!Array.isArray(value)) return;
  if (value.length > maxItems) {
    context.addIssue({
      code: 'custom',
      path: [key],
      message: `Array must contain at most ${maxItems} values`
    });
    return;
  }
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor && !('value' in descriptor)) {
      context.addIssue({
        code: 'custom',
        path: [key, index],
        message: 'Preset state must contain plain data properties'
      });
      continue;
    }
    inspectBoundedString(
      descriptor?.value,
      FILTER_PRESET_VALUE_MAX_LENGTH,
      [key, index],
      context
    );
  }
}

const controlFreePresetStateInputSchema = z.unknown().superRefine(
  (input, context) => {
    if (
      typeof input !== 'object' ||
      input === null ||
      Array.isArray(input)
    ) {
      return;
    }
    const record = input as Record<string, unknown>;
    const prototype = Object.getPrototypeOf(record);
    if (prototype !== Object.prototype && prototype !== null) {
      context.addIssue({
        code: 'custom',
        message: 'Preset state must be a plain object'
      });
      return;
    }
    let topLevelKeyCount = 0;
    for (const key in record) {
      topLevelKeyCount += 1;
      if (
        topLevelKeyCount > FILTER_PRESET_TOP_LEVEL_KEYS.size ||
        !Object.hasOwn(record, key) ||
        !FILTER_PRESET_TOP_LEVEL_KEYS.has(key)
      ) {
        context.addIssue({
          code: 'custom',
          message: 'Preset state contains unknown or inherited fields'
        });
        return;
      }
    }

    ownDataValue(record, 'version', context);
    inspectBoundedString(
      ownDataValue(record, 'provider', context),
      10,
      ['provider'],
      context
    );
    inspectBoundedString(
      ownDataValue(record, 'source', context),
      10,
      ['source'],
      context
    );
    inspectBoundedString(
      ownDataValue(record, 'view', context),
      10,
      ['view'],
      context
    );
    inspectBoundedString(
      ownDataValue(record, 'query', context),
      FILTER_PRESET_QUERY_MAX_LENGTH,
      ['query'],
      context
    );
    inspectBoundedStringArray(
      record,
      'stateCategories',
      FILTER_PRESET_STATE_CATEGORY_LIMIT,
      context
    );
    for (const key of [
      'statuses',
      'assignees',
      'priorities',
      'externalProjects',
      'labels'
    ]) {
      inspectBoundedStringArray(
        record,
        key,
        FILTER_PRESET_VALUE_LIMIT,
        context
      );
    }

    const collapsedGroups = ownDataValue(
      record,
      'collapsedGroups',
      context
    );
    if (
      typeof collapsedGroups === 'object' &&
      collapsedGroups !== null &&
      !Array.isArray(collapsedGroups)
    ) {
      const prototype = Object.getPrototypeOf(collapsedGroups);
      if (prototype !== Object.prototype && prototype !== null) {
        context.addIssue({
          code: 'custom',
          path: ['collapsedGroups'],
          message: 'Collapse overrides must be a plain object'
        });
        return;
      }
      let groupCount = 0;
      for (const key in collapsedGroups) {
        groupCount += 1;
        if (
          groupCount > FILTER_PRESET_COLLAPSED_GROUP_LIMIT ||
          !Object.hasOwn(collapsedGroups, key)
        ) {
          context.addIssue({
            code: 'custom',
            path: ['collapsedGroups'],
            message: `At most ${FILTER_PRESET_COLLAPSED_GROUP_LIMIT} collapse overrides are allowed`
          });
          return;
        }
        inspectBoundedString(
          key,
          FILTER_PRESET_VALUE_MAX_LENGTH,
          ['collapsedGroups', key],
          context
        );
        const descriptor = Object.getOwnPropertyDescriptor(
          collapsedGroups,
          key
        );
        if (descriptor && !('value' in descriptor)) {
          context.addIssue({
            code: 'custom',
            path: ['collapsedGroups', key],
            message: 'Preset state must contain plain data properties'
          });
        }
      }
    }
  }
);

export const filterPresetStateSchema = controlFreePresetStateInputSchema
  .pipe(browsePreferencesV1Schema)
  .superRefine((state, context) => {
    if (state.provider === null) {
      context.addIssue({
        code: 'custom',
        path: ['provider'],
        message: 'A project preset must record its provider'
      });
    } else if (state.source !== 'all' && state.source !== state.provider) {
      context.addIssue({
        code: 'custom',
        path: ['source'],
        message: 'A project preset source must match its provider'
      });
    }
  });

export const filterPresetSchema = z
  .object({
    id: filterPresetIdSchema,
    projectId: filterPresetProjectIdSchema,
    name: filterPresetNameSchema,
    state: filterPresetStateSchema,
    position: z.number().int().min(0).max(FILTER_PRESET_LIMIT - 1)
  })
  .strict();
export type FilterPreset = z.infer<typeof filterPresetSchema>;

export const filterPresetSummarySchema = filterPresetSchema
  .pick({
    id: true,
    projectId: true,
    name: true,
    position: true
  })
  .strict();
export type FilterPresetSummary = z.infer<typeof filterPresetSummarySchema>;

export function filterPresetSummary(
  preset: FilterPreset
): FilterPresetSummary {
  return filterPresetSummarySchema.parse({
    id: preset.id,
    projectId: preset.projectId,
    name: preset.name,
    position: preset.position
  });
}

const filterPresetOrderInputSchema = z.unknown().superRefine(
  (input, context) => {
    if (Array.isArray(input) && input.length > FILTER_PRESET_LIMIT) {
      context.addIssue({
        code: 'custom',
        message: `Preset order must contain at most ${FILTER_PRESET_LIMIT} ids`
      });
    }
  }
);

export const filterPresetOrderSchema = filterPresetOrderInputSchema.pipe(
  z.array(filterPresetIdSchema).max(FILTER_PRESET_LIMIT)
);

/**
 * Persisted uniqueness must not vary with the host locale. NFKC also makes
 * compatibility-equivalent spellings (for example full-width letters)
 * collide instead of creating visually duplicate preset names.
 */
export function normalizePresetName(name: string): string {
  const normalized = filterPresetNameSchema
    .parse(name)
    .normalize('NFKC')
    .toLowerCase();
  if (normalized.length > FILTER_PRESET_NORMALIZED_NAME_MAX_LENGTH) {
    throw new Error('Normalized filter preset name is too long');
  }
  return normalized;
}

/**
 * A reorder must be an exact permutation of the visible, parseable preset
 * ids. Anything else means the client is stale, so reject rather than guess.
 */
export function resolvePresetOrder(
  currentIds: readonly string[],
  requestedIds: readonly string[]
): string[] {
  const currentValues = filterPresetOrderSchema.parse(currentIds);
  const requestedValues = filterPresetOrderSchema.parse(requestedIds);
  if (requestedValues.length !== currentValues.length) {
    throw new Error('Preset order must list every preset exactly once');
  }
  const current = new Set(currentValues);
  if (current.size !== currentValues.length) {
    throw new Error('Stored preset order contains duplicate ids');
  }
  const seen = new Set<string>();
  for (const id of requestedValues) {
    if (!current.has(id)) throw new Error(`Unknown filter preset: ${id}`);
    if (seen.has(id)) throw new Error(`Duplicate filter preset: ${id}`);
    seen.add(id);
  }
  return [...requestedValues];
}

export function serializeFilterPresetState(state: BrowsePreferences): string {
  const serialized = JSON.stringify(filterPresetStateSchema.parse(state));
  if (
    new TextEncoder().encode(serialized).byteLength >
    FILTER_PRESET_STATE_JSON_MAX_LENGTH
  ) {
    throw new Error('Filter preset state is too large');
  }
  return serialized;
}
