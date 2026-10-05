import { z } from 'zod';
import type { WorkSource } from '../contract.js';
import {
  CREATE_ASSIGNEE_DEFAULT_VERSION,
  CREATE_ASSIGNEE_STORAGE_PREFIX,
  boundedValueSchema,
  workSourcePreferenceSchema,
  type PreferenceStorage
} from './schemas.ts';
import {
  defaultBrowserStorage,
  safeStorageGet,
  safeStorageRemove,
  safeStorageSet
} from './storage.ts';

export const createAssigneeScopeSchema = z
  .object({
    projectId: z.string().trim().min(1).max(500),
    provider: workSourcePreferenceSchema,
    destinationId: boundedValueSchema,
    issueType: z.string().trim().min(1).max(100).nullable()
  })
  .strict();

export type CreateAssigneeScope = z.infer<typeof createAssigneeScopeSchema>;

export const createAssigneeDefaultV1Schema = z
  .object({
    version: z.literal(CREATE_ASSIGNEE_DEFAULT_VERSION),
    assigneeId: boundedValueSchema
  })
  .strict();

export type CreateAssigneeDefault = z.infer<
  typeof createAssigneeDefaultV1Schema
>;

export function createAssigneeScope(
  projectId: string,
  provider: WorkSource,
  destinationId: string,
  issueType: string | null
): CreateAssigneeScope {
  const normalizedDestination =
    provider === 'jira'
      ? destinationId.trim().toUpperCase()
      : destinationId.trim();
  return createAssigneeScopeSchema.parse({
    projectId,
    provider,
    destinationId: normalizedDestination,
    issueType
  });
}

export function createAssigneeStorageKey(
  scope: CreateAssigneeScope
): string {
  const parsed = createAssigneeScopeSchema.parse(scope);
  return `${CREATE_ASSIGNEE_STORAGE_PREFIX}${encodeURIComponent(
    JSON.stringify([
      parsed.projectId,
      parsed.provider,
      parsed.destinationId,
      parsed.issueType
    ])
  )}`;
}

export function readRememberedCreateAssignee(
  scope: CreateAssigneeScope,
  storage: PreferenceStorage | null = defaultBrowserStorage
): string | null {
  const serialized = safeStorageGet(storage, createAssigneeStorageKey(scope));
  if (serialized === null) return null;
  try {
    const parsed = createAssigneeDefaultV1Schema.safeParse(
      JSON.parse(serialized)
    );
    return parsed.success ? parsed.data.assigneeId : null;
  } catch {
    return null;
  }
}

export function rememberCreateAssignee(
  scope: CreateAssigneeScope,
  assigneeId: string | null,
  storage: PreferenceStorage | null = defaultBrowserStorage
): void {
  const key = createAssigneeStorageKey(scope);
  if (assigneeId === null) {
    safeStorageRemove(storage, key);
    return;
  }
  const record = createAssigneeDefaultV1Schema.parse({
    version: CREATE_ASSIGNEE_DEFAULT_VERSION,
    assigneeId
  });
  safeStorageSet(storage, key, JSON.stringify(record));
}

export async function rememberCreateAssigneeAfterSuccess<
  T extends {
    assigneeConfirmation:
      | { confirmed: true; id: string | null }
      | { confirmed: false };
  }
>(
  creation: Promise<T>,
  scope: CreateAssigneeScope,
  assigneeId: string | null,
  storage: PreferenceStorage | null = defaultBrowserStorage
): Promise<T> {
  const result = await creation;
  if (
    result.assigneeConfirmation.confirmed &&
    result.assigneeConfirmation.id === assigneeId
  ) {
    rememberCreateAssignee(scope, assigneeId, storage);
  }
  return result;
}

export function validateRememberedCreateAssignee(
  assigneeId: string | null,
  assigneeOptions: readonly (string | { id: string })[]
): string | null {
  const parsedId = boundedValueSchema.safeParse(assigneeId);
  if (!parsedId.success) return null;
  return assigneeOptions.some(option => {
    const optionId = typeof option === 'string' ? option : option.id;
    return optionId === parsedId.data;
  })
    ? parsedId.data
    : null;
}

export function restoreRememberedCreateAssignee(
  scope: CreateAssigneeScope,
  assigneeOptions: readonly (string | { id: string })[],
  storage: PreferenceStorage | null = defaultBrowserStorage
): string | null {
  return validateRememberedCreateAssignee(
    readRememberedCreateAssignee(scope, storage),
    assigneeOptions
  );
}
