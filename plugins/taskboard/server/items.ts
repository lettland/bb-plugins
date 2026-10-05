import {
  sourceName,
  workStatusOptionSchema,
  type WorkItem,
  type WorkItemDetail,
  type WorkSource,
  type WorkStatusOption
} from '../contract.js';
import {
  withoutComments,
  type ExternalWorkItemDetail,
  type WorkSourceAdapter
} from '../sources/types.js';
import {
  adapters,
  assertAdapterConfigured,
  assertSelectedSource
} from './adapters.js';
import type { TaskboardContext } from './context.js';
import { enqueueMutation, waitForMutations } from './mutations.js';
import {
  advanceSourceRevision,
  assertRevisionCurrent,
  currentRevision
} from './revisions.js';
import { syncAll } from './sync.js';
import { errorMessage, scopedItem, scopedItemDetail } from './util.js';

async function loadCachedItemAdapter(
  tc: TaskboardContext,
  projectId: string,
  source: WorkSource,
  locator: string
): Promise<{ adapter: WorkSourceAdapter; revision: number }> {
  assertSelectedSource(tc, projectId, source);
  await waitForMutations(tc, projectId, [source]);
  assertSelectedSource(tc, projectId, source);
  if (!tc.store.get(projectId, source, locator)) {
    throw new Error(
      `${sourceName(source)} item is not cached for this BB project; refresh the project tracker first`
    );
  }
  const revision = currentRevision(tc, projectId, source);
  const adapter = (await adapters(tc, projectId)).get(source);
  if (!adapter) {
    assertSelectedSource(tc, projectId, source);
    throw new Error(`Missing ${source} adapter`);
  }
  return { adapter, revision };
}

export async function getLiveItem(
  tc: TaskboardContext,
  projectId: string,
  source: WorkSource,
  locator: string
): Promise<WorkItemDetail> {
  const { adapter, revision } = await loadCachedItemAdapter(
    tc,
    projectId,
    source,
    locator
  );
  const changed = 'while loading the item; reopen it';
  assertRevisionCurrent(tc, projectId, source, revision, changed);
  assertAdapterConfigured(adapter, source);
  let externalItem: ExternalWorkItemDetail;
  try {
    externalItem = await adapter.get(locator);
  } catch {
    throw new Error(
      `${sourceName(source)} could not load the requested item`
    );
  }
  assertRevisionCurrent(tc, projectId, source, revision, changed);
  return scopedItemDetail(projectId, externalItem);
}

export async function liveStatusOptions(
  tc: TaskboardContext,
  projectId: string,
  source: WorkSource,
  locator: string
): Promise<WorkStatusOption[]> {
  const { adapter, revision } = await loadCachedItemAdapter(
    tc,
    projectId,
    source,
    locator
  );
  const changed = 'while loading statuses; try again';
  assertRevisionCurrent(tc, projectId, source, revision, changed);
  assertAdapterConfigured(adapter, source);
  let options: WorkStatusOption[];
  try {
    options = workStatusOptionSchema
      .array()
      .parse(await adapter.statusOptions(locator));
  } catch (error) {
    const message = errorMessage(error);
    throw new Error(
      message.includes('outside the configured scope')
        ? message
        : `${sourceName(source)} could not load valid statuses for this item`
    );
  }
  assertRevisionCurrent(tc, projectId, source, revision, changed);
  if (new Set(options.map(option => option.id)).size !== options.length) {
    throw new Error(`${sourceName(source)} returned duplicate status ids`);
  }
  if (!options.some(option => option.current)) {
    throw new Error(
      `${sourceName(source)} did not return the current status`
    );
  }
  return options;
}

interface StatusUpdate {
  projectId: string;
  source: WorkSource;
  locator: string;
  statusId: string;
  adapter: WorkSourceAdapter;
  revision: number;
}

async function applyStatusUpdate(
  tc: TaskboardContext,
  update: StatusUpdate
): Promise<WorkItem> {
  const { projectId, source, locator, statusId, adapter, revision } = update;
  assertRevisionCurrent(
    tc,
    projectId,
    source,
    revision,
    'before the status update; try again'
  );
  if (!tc.store.get(projectId, source, locator)) {
    throw new Error(
      `${sourceName(source)} item is no longer cached for this BB project`
    );
  }
  advanceSourceRevision(tc, projectId, source);
  let externalItem: ExternalWorkItemDetail;
  try {
    externalItem = await adapter.updateStatus(locator, statusId);
  } catch (error) {
    const message = errorMessage(error);
    throw new Error(
      message.includes('not available') ||
        message.includes('outside the configured scope')
        ? message
        : `${sourceName(source)} could not update this item status`
    );
  }
  if (externalItem.source !== source || externalItem.locator !== locator) {
    throw new Error(
      `${sourceName(source)} returned an invalid status update result`
    );
  }
  const item = scopedItem(projectId, withoutComments(externalItem));
  tc.store.upsert(item);
  tc.bb.realtime.publish('taskboard:changed', { projectId, source });
  return item;
}

export async function updateItemStatus(
  tc: TaskboardContext,
  projectId: string,
  source: WorkSource,
  locator: string,
  statusId: string
): Promise<WorkItem> {
  const { adapter, revision } = await loadCachedItemAdapter(
    tc,
    projectId,
    source,
    locator
  );
  assertAdapterConfigured(adapter, source);
  const mutation = enqueueMutation(tc, projectId, [source], () =>
    applyStatusUpdate(tc, {
      projectId,
      source,
      locator,
      statusId,
      adapter,
      revision
    })
  );
  void mutation
    .then(
      () => syncAll(tc, projectId, source, false),
      () => syncAll(tc, projectId, source, false)
    )
    .catch((error: unknown) => {
      tc.bb.log.warn(
        `${sourceName(source)} reconciliation failed for ${projectId}: ${errorMessage(error)}`
      );
    });
  return mutation;
}
