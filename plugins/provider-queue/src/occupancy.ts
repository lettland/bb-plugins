import type { BbPluginApi } from "@get-bb/plugin-sdk";
import {
  INTERACTION_TTL_MS,
  MAX_ANCESTOR_DEPTH,
  MAX_PROVIDER_CACHE,
  errorMessage,
  type QueuedThreadRef,
  type SlotRow,
} from "./shared.js";

export interface ProviderCaches {
  providerByThread: Map<string, string>;
  blockedCache: Map<string, { blocked: boolean; at: number }>;
}

export function rememberProvider(
  caches: ProviderCaches,
  threadId: string,
  providerId: string,
): void {
  if (caches.providerByThread.size >= MAX_PROVIDER_CACHE) {
    caches.providerByThread.clear();
  }
  caches.providerByThread.set(threadId, providerId);
}

export async function exemptThreadIds(
  bb: BbPluginApi,
  thread: QueuedThreadRef,
): Promise<Set<string>> {
  const exempt = new Set<string>([thread.id]);
  let next = thread.parentThreadId;
  for (
    let depth = 0;
    next !== null && !exempt.has(next) && depth < MAX_ANCESTOR_DEPTH;
    depth += 1
  ) {
    const ancestorId = next;
    exempt.add(ancestorId);
    try {
      next = (await bb.sdk.threads.get({ threadId: ancestorId }))
        .parentThreadId;
    } catch (error) {
      bb.log.warn(
        `Could not read ancestor ${ancestorId} of ${thread.id}: ${errorMessage(error)}`,
      );
      break;
    }
  }
  return exempt;
}

export async function runningInfoOf(
  bb: BbPluginApi,
  caches: ProviderCaches,
  id: string,
): Promise<{ providerId: string; row: SlotRow } | null> {
  try {
    const thread = await bb.sdk.threads.get({ threadId: id });
    rememberProvider(caches, id, thread.providerId);
    return {
      providerId: thread.providerId,
      row: {
        threadId: id,
        title: thread.title ?? thread.titleFallback ?? "(untitled)",
      },
    };
  } catch (error) {
    bb.log.warn(`Could not read the provider of ${id}: ${errorMessage(error)}`);
    return null;
  }
}

async function rowOf(
  bb: BbPluginApi,
  caches: ProviderCaches,
  id: string,
  providerId: string,
): Promise<SlotRow | null> {
  const cached = caches.providerByThread.get(id);
  if (cached !== undefined && cached !== providerId) return null;
  const info = await runningInfoOf(bb, caches, id);
  return info !== null && info.providerId === providerId ? info.row : null;
}

export async function occupancyOf(
  bb: BbPluginApi,
  caches: ProviderCaches,
  providerId: string,
  exempt: ReadonlySet<string>,
): Promise<{
  occupied: number;
  runningTitles: SlotRow[];
  awaitingTitles: SlotRow[];
}> {
  const running = (await bb.sdk.threads.listRunning()).filter(
    ({ id }) => !exempt.has(id),
  );
  const rows = await Promise.all(
    running.map(({ id }) => rowOf(bb, caches, id, providerId)),
  );
  const onProvider = rows.filter((row): row is SlotRow => row !== null);
  const blocked = await Promise.all(
    onProvider.map(async ({ threadId }) => {
      try {
        const pending = await bb.sdk.threads.interactions.list({ threadId });
        return pending.length > 0;
      } catch (error) {
        bb.log.warn(
          `Could not read the pending interactions of ${threadId}: ${errorMessage(error)}`,
        );
        return true;
      }
    }),
  );
  const awaitingTitles = onProvider.filter((_, index) => blocked[index]);
  return {
    occupied: onProvider.length - awaitingTitles.length,
    runningTitles: onProvider,
    awaitingTitles,
  };
}

export async function isBlockedForDisplay(
  bb: BbPluginApi,
  caches: ProviderCaches,
  threadId: string,
): Promise<boolean> {
  const cached = caches.blockedCache.get(threadId);
  if (cached !== undefined && Date.now() - cached.at < INTERACTION_TTL_MS) {
    return cached.blocked;
  }
  try {
    const pending = await bb.sdk.threads.interactions.list({ threadId });
    const blocked = pending.length > 0;
    if (caches.blockedCache.size >= MAX_PROVIDER_CACHE) {
      caches.blockedCache.clear();
    }
    caches.blockedCache.set(threadId, { blocked, at: Date.now() });
    return blocked;
  } catch (error) {
    bb.log.warn(
      `Could not read the pending interactions of ${threadId}: ${errorMessage(error)}`,
    );
    return false;
  }
}

export async function titleOf(
  bb: BbPluginApi,
  threadId: string,
): Promise<string> {
  try {
    const thread = await bb.sdk.threads.get({ threadId });
    return thread.title ?? thread.titleFallback ?? "(untitled)";
  } catch (error) {
    bb.log.warn(`Could not read ${threadId}: ${errorMessage(error)}`);
    return "(untitled)";
  }
}
