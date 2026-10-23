import {
  type BbPluginApi,
  type MessageDispatchHookContext,
  type MessageDispatchHookDecision,
} from "@get-bb/plugin-sdk";
import { registerCli } from "./src/cli.js";
import {
  KEEPER_INTERVAL_MS,
  MAX_ANCESTOR_DEPTH,
  MAX_PROJECT_CACHE,
  PROCEED,
  QUEUED_KEY,
  errorMessage,
  httpStatus,
  queuedIdsSchema,
  queueIntentSchema,
  sleep,
  staleReason,
  waitDecision,
  type QueuedThreadRef,
  type QueuedView,
  type ReleaseEntry,
} from "./src/shared.js";

export { MAX_REASON_LENGTH } from "./src/shared.js";

export default async function projectQueuePlugin(
  bb: BbPluginApi,
): Promise<void> {
  const storedIds = queuedIdsSchema.safeParse(
    await bb.storage.kv.get<unknown>(QUEUED_KEY),
  );
  const queued = new Set<string>(storedIds.success ? storedIds.data : []);
  const projectByThread = new Map<string, string>();
  let writeChain: Promise<void> = Promise.resolve();

  function persist(): Promise<void> {
    const write = writeChain.then(() =>
      bb.storage.kv.set(QUEUED_KEY, [...queued]),
    );
    writeChain = write.catch((error: unknown) => {
      bb.log.warn(
        `Could not save the queued thread ids: ${errorMessage(error)}`,
      );
    });
    return writeChain;
  }

  async function releaseThreads(
    entries: readonly ReleaseEntry[],
  ): Promise<void> {
    let changed = false;
    for (const { id, cause } of entries) {
      if (!queued.delete(id)) continue;
      projectByThread.delete(id);
      bb.log.info(`Released ${id}: ${cause}`);
      changed = true;
    }
    if (changed) await persist();
  }

  async function enqueue(threadId: string): Promise<void> {
    if (queued.has(threadId)) return;
    queued.add(threadId);
    bb.log.info(`Queued ${threadId}`);
    await persist();
  }

  async function recheckDispatch(): Promise<void> {
    try {
      await bb.experimental_hooks.recheck("message.dispatch");
    } catch (error) {
      bb.log.warn(`Could not recheck held dispatches: ${errorMessage(error)}`);
    }
  }

  function rememberProject(threadId: string, projectId: string): void {
    if (projectByThread.size >= MAX_PROJECT_CACHE) projectByThread.clear();
    projectByThread.set(threadId, projectId);
  }

  async function projectIdOf(threadId: string): Promise<string | null> {
    const cached = projectByThread.get(threadId);
    if (cached !== undefined) return cached;
    try {
      const { projectId } = await bb.sdk.threads.get({ threadId });
      rememberProject(threadId, projectId);
      return projectId;
    } catch (error) {
      bb.log.warn(
        `Could not read the project of ${threadId}: ${errorMessage(error)}`,
      );
      return null;
    }
  }

  async function exemptThreadIds(
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

  async function blockersOf(thread: QueuedThreadRef): Promise<string[]> {
    const [running, exempt] = await Promise.all([
      bb.sdk.threads.listRunning(),
      exemptThreadIds(thread),
    ]);
    const candidates = running.filter(({ id }) => !exempt.has(id));
    const projectIds = await Promise.all(
      candidates.map(({ id }) => projectIdOf(id)),
    );
    return candidates
      .filter((_, index) => projectIds[index] === thread.projectId)
      .map(({ id }) => id);
  }

  async function decide(
    context: MessageDispatchHookContext,
  ): Promise<MessageDispatchHookDecision> {
    const { thread, project } = context;
    if (thread.status !== "pending") {
      await releaseThreads([
        { id: thread.id, cause: `thread is ${thread.status}` },
      ]);
      return PROCEED;
    }
    if (project.kind === "personal") return PROCEED;

    const submission = context.experimental_submission;
    if (
      submission !== null &&
      submission.pluginId === bb.pluginId &&
      queueIntentSchema.safeParse(submission.data).success
    ) {
      await enqueue(thread.id);
    }
    if (!queued.has(thread.id)) return PROCEED;

    const blockers = await blockersOf(thread);
    if (blockers.length === 0) return PROCEED;
    return waitDecision(blockers.length, project.name);
  }

  async function purgeStale(): Promise<void> {
    const outcomes = await Promise.all(
      [...queued].map(async (id): Promise<ReleaseEntry | null> => {
        try {
          const reason = staleReason(
            await bb.sdk.threads.get({ threadId: id }),
          );
          return reason === null ? null : { id, cause: reason };
        } catch (error) {
          if (httpStatus(error) === 404) {
            return { id, cause: "thread not found" };
          }
          bb.log.warn(`Could not check ${id}: ${errorMessage(error)}`);
          return null;
        }
      }),
    );
    await releaseThreads(
      outcomes.filter((entry): entry is ReleaseEntry => entry !== null),
    );
  }

  async function listViews(projectFilter: string | undefined) {
    const projectNames = new Map<string, Promise<string>>();
    function projectName(projectId: string): Promise<string> {
      let name = projectNames.get(projectId);
      if (name === undefined) {
        name = bb.sdk.projects.get({ projectId }).then(
          (project) => project.name,
          (error: unknown) => {
            bb.log.warn(
              `Could not read project ${projectId}: ${errorMessage(error)}`,
            );
            return projectId;
          },
        );
        projectNames.set(projectId, name);
      }
      return name;
    }

    const views = await Promise.all(
      [...queued].map(async (id): Promise<QueuedView | null> => {
        try {
          const thread = await bb.sdk.threads.get({ threadId: id });
          if (
            projectFilter !== undefined &&
            thread.projectId !== projectFilter
          ) {
            return null;
          }
          const reason = staleReason(thread);
          if (reason !== null) return { id, state: "stale", reason };
          const [blockers, project] = await Promise.all([
            blockersOf(thread),
            projectName(thread.projectId),
          ]);
          return {
            id,
            state: "queued",
            title: thread.title ?? thread.titleFallback,
            projectId: thread.projectId,
            project,
            blockers,
          };
        } catch (error) {
          if (httpStatus(error) === 404) {
            return { id, state: "stale", reason: "thread not found" };
          }
          return { id, state: "unknown", error: errorMessage(error) };
        }
      }),
    );
    const present = views.filter((view): view is QueuedView => view !== null);
    await releaseThreads(
      present.flatMap((view) =>
        view.state === "stale" ? [{ id: view.id, cause: view.reason }] : [],
      ),
    );
    return present;
  }

  registerCli(bb, { queued, listViews, releaseThreads, recheckDispatch });

  bb.background.service("queue-keeper", {
    async start(signal) {
      await purgeStale();
      await recheckDispatch();
      while (!signal.aborted) {
        await sleep(KEEPER_INTERVAL_MS, signal);
        if (signal.aborted || queued.size === 0) continue;
        await recheckDispatch();
      }
    },
  });

  bb.events.on("thread.active", async ({ thread }) => {
    await releaseThreads([{ id: thread.id, cause: "thread started" }]);
  });

  for (const event of ["thread.archived", "thread.deleted"] as const) {
    bb.events.on(event, async ({ thread }) => {
      await releaseThreads([{ id: thread.id, cause: event }]);
      await recheckDispatch();
    });
  }

  for (const event of ["thread.idle", "thread.failed"] as const) {
    bb.events.on(event, async () => {
      await recheckDispatch();
    });
  }

  bb.events.on("message.cancelled", async ({ entry }) => {
    const threadId = entry.threadId;
    if (!queued.has(threadId)) return;
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
