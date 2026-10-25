import type { BbPluginApi } from "@get-bb/plugin-sdk";
import {
  errorMessage,
  httpStatus,
  pausedReason,
  staleReason,
  waitDecision,
  type ProviderSummary,
  type QueuedView,
  type QueueEntry,
  type ReleaseEntry,
} from "./shared.js";
import {
  exemptThreadIds,
  isBlockedForDisplay,
  occupancyOf,
  runningInfoOf,
  titleOf,
  type ProviderCaches,
} from "./occupancy.js";

export interface ViewDeps {
  bb: BbPluginApi;
  caches: ProviderCaches;
  queue: QueueEntry[];
  limits: Readonly<Record<string, number>>;
  providerLabels: () => Promise<Map<string, string>>;
  labelOf: (providerId: string) => Promise<string>;
  limitOf: (providerId: string) => number;
  releaseThreads: (entries: readonly ReleaseEntry[]) => Promise<void>;
}

export async function snapshot(deps: ViewDeps): Promise<{
  providers: ProviderSummary[];
  queueOrder: string[];
}> {
  const { bb, caches, queue, limits } = deps;
  const [running, labels] = await Promise.all([
    bb.sdk.threads.listRunning(),
    deps.providerLabels(),
  ]);
  const infos = await Promise.all(
    running.map(({ id }) => runningInfoOf(bb, caches, id)),
  );
  const summaries = new Map<string, ProviderSummary>();
  function summaryFor(providerId: string): ProviderSummary {
    let summary = summaries.get(providerId);
    if (summary === undefined) {
      summary = {
        providerId,
        label: labels.get(providerId) ?? providerId,
        limit: deps.limitOf(providerId),
        running: [],
        awaiting: [],
        queue: [],
      };
      summaries.set(providerId, summary);
    }
    return summary;
  }
  for (const providerId of Object.keys(limits)) summaryFor(providerId);
  for (const entry of queue) summaryFor(entry.providerId);
  for (const info of infos) {
    if (info !== null) summaryFor(info.providerId);
  }
  for (const info of infos) {
    if (info === null) continue;
    const summary = summaryFor(info.providerId);
    if (await isBlockedForDisplay(bb, caches, info.row.threadId)) {
      summary.awaiting.push(info.row);
    } else {
      summary.running.push(info.row);
    }
  }
  for (const entry of queue) {
    summaryFor(entry.providerId).queue.push({
      threadId: entry.threadId,
      providerId: entry.providerId,
      title: await titleOf(bb, entry.threadId),
    });
  }
  return {
    providers: [...summaries.values()],
    queueOrder: queue.map((entry) => entry.threadId),
  };
}

export async function listViews(
  deps: ViewDeps,
  providerFilter: string | undefined,
): Promise<QueuedView[]> {
  const { bb, caches, queue } = deps;
  const views = await Promise.all(
    queue.map(async (entry): Promise<QueuedView | null> => {
      try {
        const thread = await bb.sdk.threads.get({ threadId: entry.threadId });
        if (
          providerFilter !== undefined &&
          entry.providerId !== providerFilter
        ) {
          return null;
        }
        const reason = staleReason(thread);
        if (reason !== null) {
          return { threadId: entry.threadId, state: "stale", reason };
        }
        const exempt = await exemptThreadIds(bb, thread);
        const occ = await occupancyOf(bb, caches, entry.providerId, exempt);
        const label = await deps.labelOf(entry.providerId);
        const limit = deps.limitOf(entry.providerId);
        const position = queue
          .filter((candidate) => candidate.providerId === entry.providerId)
          .findIndex((candidate) => candidate.threadId === entry.threadId);
        const waiting =
          limit === 0
            ? pausedReason(label)
            : limit - occ.occupied > position
              ? null
              : waitDecision(occ.occupied, label, limit);
        return {
          threadId: entry.threadId,
          state: "queued",
          title: thread.title ?? thread.titleFallback,
          providerId: entry.providerId,
          provider: label,
          waiting,
        };
      } catch (error) {
        if (httpStatus(error) === 404) {
          return {
            threadId: entry.threadId,
            state: "stale",
            reason: "thread not found",
          };
        }
        return {
          threadId: entry.threadId,
          state: "unknown",
          error: errorMessage(error),
        };
      }
    }),
  );
  const present = views.filter((view): view is QueuedView => view !== null);
  await deps.releaseThreads(
    present.flatMap((view) =>
      view.state === "stale" ? [{ id: view.threadId, cause: view.reason }] : [],
    ),
  );
  return present;
}
