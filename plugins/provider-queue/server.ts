import {
  type BbPluginApi,
  defineRpcContract,
  type MessageDispatchHookContext,
  type MessageDispatchHookDecision,
  type PluginThreadEventPayloads,
} from "@get-bb/plugin-sdk";
import { z } from "zod";
import { registerCli } from "./src/cli.js";
import {
  exemptThreadIds,
  occupancyOf,
  rememberProvider,
  type ProviderCaches,
} from "./src/occupancy.js";
import {
  DEFAULT_LIMIT,
  DIRECTIONS,
  KEEPER_INTERVAL_MS,
  LIMITS_KEY,
  PROCEED,
  QUEUE_KEY,
  errorMessage,
  httpStatus,
  limitsSchema,
  pausedReason,
  providerSummarySchema,
  queueEntriesSchema,
  queueIntentSchema,
  sleep,
  staleReason,
  waitDecision,
  type Direction,
  type QueueEntry,
  type ReleaseEntry,
} from "./src/shared.js";
import { listViews, snapshot } from "./src/views.js";

export { MAX_REASON_LENGTH } from "./src/shared.js";
export { providerSummarySchema } from "./src/shared.js";
export type {
  ProviderSummary,
  QueueRow,
  SlotRow,
} from "./src/shared.js";

export const rpcContract = defineRpcContract({
  snapshot: {
    input: z.null(),
    output: z.object({ providers: z.array(providerSummarySchema) }),
  },
  move: {
    input: z
      .object({
        threadId: z.string().min(1),
        direction: z.enum(DIRECTIONS),
      })
      .strict(),
    output: z.object({ ok: z.literal(true) }),
  },
  release: {
    input: z.object({ threadId: z.string().min(1) }).strict(),
    output: z.object({ ok: z.literal(true) }),
  },
  setLimit: {
    input: z
      .object({
        providerId: z.string().min(1),
        limit: z.number().int().min(0),
      })
      .strict(),
    output: z.object({ ok: z.literal(true) }),
  },
});

type ThreadPayload = PluginThreadEventPayloads["thread.created"]["thread"];

function warnIfMalformed(
  bb: BbPluginApi,
  key: string,
  value: unknown,
  parsed: boolean,
): void {
  const absent = value === null || value === undefined;
  if (!parsed && !absent) {
    bb.log.warn(`Stored ${key} is malformed; starting empty`);
  }
}

export default async function providerQueuePlugin(
  bb: BbPluginApi,
): Promise<void> {
  const storedQueue = await bb.storage.kv.get<unknown>(QUEUE_KEY);
  const storedEntries = queueEntriesSchema.safeParse(storedQueue);
  warnIfMalformed(bb, QUEUE_KEY, storedQueue, storedEntries.success);
  const queue: QueueEntry[] = storedEntries.success
    ? storedEntries.data.map((entry) => ({ ...entry }))
    : [];
  const storedLimitsValue = await bb.storage.kv.get<unknown>(LIMITS_KEY);
  const storedLimits = limitsSchema.safeParse(storedLimitsValue);
  warnIfMalformed(bb, LIMITS_KEY, storedLimitsValue, storedLimits.success);
  const limits: Record<string, number> = storedLimits.success
    ? { ...storedLimits.data }
    : {};
  const providerByThread = new Map<string, string>();
  const blockedCache = new Map<string, { blocked: boolean; at: number }>();
  const caches: ProviderCaches = { providerByThread, blockedCache };
  let writeChain: Promise<void> = Promise.resolve();
  let labelsPromise: Promise<Map<string, string>> | null = null;

  const viewDeps = {
    bb,
    caches,
    queue,
    limits,
    providerLabels,
    labelOf,
    limitOf,
    releaseThreads,
  };

  function persist(): Promise<void> {
    const write = writeChain.then(async () => {
      await Promise.all([
        bb.storage.kv.set(
          QUEUE_KEY,
          queue.map((entry) => ({ ...entry })),
        ),
        bb.storage.kv.set(LIMITS_KEY, { ...limits }),
      ]);
    });
    writeChain = write.catch((error: unknown) => {
      bb.log.warn(`Could not save the queue state: ${errorMessage(error)}`);
    });
    return writeChain;
  }

  function publish(): void {
    bb.realtime.publish("provider-queue", { kind: "state" });
  }

  async function releaseThreads(
    entries: readonly ReleaseEntry[],
  ): Promise<void> {
    let changed = false;
    for (const { id, cause } of entries) {
      const index = queue.findIndex((entry) => entry.threadId === id);
      if (index < 0) continue;
      queue.splice(index, 1);
      providerByThread.delete(id);
      blockedCache.delete(id);
      bb.log.info(`Released ${id}: ${cause}`);
      changed = true;
    }
    if (changed) {
      await persist();
      publish();
    }
  }

  async function enqueue(threadId: string, providerId: string): Promise<void> {
    if (queue.some((entry) => entry.threadId === threadId)) return;
    queue.push({ threadId, providerId });
    bb.log.info(`Queued ${threadId} on ${providerId}`);
    await persist();
    publish();
  }

  async function recheckDispatch(): Promise<void> {
    try {
      await bb.experimental_hooks.recheck("message.dispatch");
    } catch (error) {
      bb.log.warn(`Could not recheck held dispatches: ${errorMessage(error)}`);
    }
  }

  function isQueued(threadId: string): boolean {
    return queue.some((entry) => entry.threadId === threadId);
  }

  function refreshThread(thread: ThreadPayload): void {
    rememberProvider(caches, thread.id, thread.providerId);
  }

  function providerLabels(): Promise<Map<string, string>> {
    labelsPromise ??= bb.sdk.providers
      .list()
      .then((providers) => {
        const labels = new Map<string, string>();
        for (const provider of providers) {
          labels.set(provider.id, provider.displayName);
        }
        return labels;
      })
      .catch((error: unknown) => {
        labelsPromise = null;
        bb.log.warn(`Could not read the providers: ${errorMessage(error)}`);
        return new Map<string, string>();
      });
    return labelsPromise;
  }

  async function labelOf(providerId: string): Promise<string> {
    return (await providerLabels()).get(providerId) ?? providerId;
  }

  function limitOf(providerId: string): number {
    return limits[providerId] ?? DEFAULT_LIMIT;
  }

  async function decide(
    context: MessageDispatchHookContext,
  ): Promise<MessageDispatchHookDecision> {
    if (context.attempt === "join-turn") return PROCEED;
    const { thread } = context;
    if (thread.status !== "pending") {
      await releaseThreads([
        { id: thread.id, cause: `thread is ${thread.status}` },
      ]);
      return PROCEED;
    }

    const submission = context.experimental_submission;
    if (
      submission !== null &&
      submission.pluginId === bb.pluginId &&
      queueIntentSchema.safeParse(submission.data).success
    ) {
      await enqueue(thread.id, context.requestedExecution.providerId);
    }
    const entry = queue.find((candidate) => candidate.threadId === thread.id);
    if (entry === undefined) return PROCEED;

    const providerId = context.requestedExecution.providerId;
    if (entry.providerId !== providerId) {
      entry.providerId = providerId;
      await persist();
    }
    const exempt = await exemptThreadIds(bb, thread);
    const occ = await occupancyOf(bb, caches, providerId, exempt);
    const limit = limitOf(providerId);
    if (limit === 0) {
      return { action: "wait", reason: pausedReason(await labelOf(providerId)) };
    }
    const position = queue
      .filter((candidate) => candidate.providerId === providerId)
      .findIndex((candidate) => candidate.threadId === thread.id);
    const free = limit - occ.occupied;
    if (free > position) return PROCEED;
    return {
      action: "wait",
      reason: waitDecision(occ.occupied, await labelOf(providerId), limit),
    };
  }

  async function purgeStale(): Promise<void> {
    const outcomes = await Promise.all(
      queue.map(async (entry): Promise<ReleaseEntry | null> => {
        try {
          const reason = staleReason(
            await bb.sdk.threads.get({ threadId: entry.threadId }),
          );
          return reason === null ? null : { id: entry.threadId, cause: reason };
        } catch (error) {
          if (httpStatus(error) === 404) {
            return { id: entry.threadId, cause: "thread not found" };
          }
          bb.log.warn(
            `Could not check ${entry.threadId}: ${errorMessage(error)}`,
          );
          return null;
        }
      }),
    );
    await releaseThreads(
      outcomes.filter((entry): entry is ReleaseEntry => entry !== null),
    );
  }

  async function moveQueued(
    threadId: string,
    direction: Direction,
  ): Promise<void> {
    const index = queue.findIndex((entry) => entry.threadId === threadId);
    if (index < 0) throw new Error(`${threadId} is not queued`);
    const siblings = [...queue.entries()].filter(
      ([, entry]) => entry.providerId === queue[index].providerId,
    );
    const at = siblings.findIndex(([position]) => position === index);
    const offset = direction === "up" ? -1 : direction === "down" ? 1 : 0;
    const swapWith = offset === 0 ? undefined : siblings[at + offset];
    if (swapWith !== undefined) {
      const displaced = queue[swapWith[0]];
      queue[swapWith[0]] = queue[index];
      queue[index] = displaced;
    } else if (direction === "top" && at > 0) {
      const [entry] = queue.splice(index, 1);
      queue.splice(siblings[0][0], 0, entry);
    } else if (direction === "bottom" && at < siblings.length - 1) {
      const [entry] = queue.splice(index, 1);
      queue.splice(siblings[siblings.length - 1][0], 0, entry);
    } else {
      return;
    }
    await persist();
    await recheckDispatch();
    publish();
  }

  async function releaseQueued(threadId: string): Promise<void> {
    await releaseThreads([{ id: threadId, cause: "released by command" }]);
    await recheckDispatch();
  }

  async function setProviderLimit(
    providerId: string,
    limit: number,
  ): Promise<void> {
    const known = await bb.sdk.providers.list().then(
      (providers) => providers.some((provider) => provider.id === providerId),
      () => null,
    );
    if (known === false) throw new Error(`Unknown provider ${providerId}`);
    limits[providerId] = limit;
    await persist();
    await recheckDispatch();
    publish();
  }

  registerCli(bb, {
    isQueued,
    listViews: (providerFilter) => listViews(viewDeps, providerFilter),
    snapshot: () => snapshot(viewDeps),
    enqueue,
    moveQueued,
    releaseQueued,
    limits: () => limits,
    limitOf,
    setLimit: setProviderLimit,
    recheckDispatch,
  });

  bb.rpc.register(rpcContract, {
    snapshot: () => snapshot(viewDeps),
    move: async ({ threadId, direction }) => {
      await moveQueued(threadId, direction);
      return { ok: true as const };
    },
    release: async ({ threadId }) => {
      await releaseQueued(threadId);
      return { ok: true as const };
    },
    setLimit: async ({ providerId, limit }) => {
      await setProviderLimit(providerId, limit);
      return { ok: true as const };
    },
  });

  bb.background.service("queue-keeper", {
    async start(signal) {
      await purgeStale();
      await recheckDispatch();
      while (!signal.aborted) {
        await sleep(KEEPER_INTERVAL_MS, signal);
        if (signal.aborted || queue.length === 0) continue;
        await recheckDispatch();
      }
    },
  });

  bb.events.on("thread.created", ({ thread }) => {
    refreshThread(thread);
  });

  bb.events.on("thread.active", async ({ thread }) => {
    refreshThread(thread);
    await releaseThreads([{ id: thread.id, cause: "thread started" }]);
  });

  for (const event of ["thread.idle", "thread.failed"] as const) {
    bb.events.on(event, async ({ thread }) => {
      refreshThread(thread);
      await recheckDispatch();
    });
  }

  for (const event of ["thread.archived", "thread.deleted"] as const) {
    bb.events.on(event, async ({ thread }) => {
      refreshThread(thread);
      await releaseThreads([{ id: thread.id, cause: event }]);
      await recheckDispatch();
    });
  }

  bb.events.on("interaction.pending", async ({ thread }) => {
    refreshThread(thread);
    blockedCache.delete(thread.id);
    await recheckDispatch();
  });

  bb.events.on("message.cancelled", async ({ entry }) => {
    const threadId = entry.threadId;
    if (!isQueued(threadId)) return;
    try {
      const reason = staleReason(await bb.sdk.threads.get({ threadId }));
      if (reason !== null) {
        await releaseThreads([{ id: threadId, cause: reason }]);
        return;
      }
      const remaining = await bb.sdk.threads.queuedMessages.list({ threadId });
      if (remaining.length === 0) {
        await releaseThreads([
          { id: threadId, cause: "no queued messages left" },
        ]);
      }
    } catch (error) {
      if (httpStatus(error) === 404) {
        await releaseThreads([{ id: threadId, cause: "thread not found" }]);
        return;
      }
      bb.log.warn(
        `Could not check ${threadId} after a cancelled message: ${errorMessage(error)}`,
      );
    }
  });

  bb.experimental_hooks.on("message.dispatch", async (context) => {
    try {
      return await decide(context);
    } catch (error) {
      bb.log.error(
        `Could not decide ${context.thread.id}, letting it proceed: ${errorMessage(error)}`,
      );
      return PROCEED;
    }
  });
}
