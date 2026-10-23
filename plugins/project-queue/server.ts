import {
  PluginCliError,
  cliCommand,
  defineCli,
  type BbPluginApi,
  type MessageDispatchHookContext,
  type MessageDispatchHookDecision,
  type PluginCliResult,
} from "@get-bb/plugin-sdk";
import { z } from "zod";

const QUEUED_KEY = "queued-thread-ids";
const KEEPER_INTERVAL_MS = 30_000;
const MAX_ANCESTOR_DEPTH = 64;
const MAX_PROJECT_CACHE = 5_000;
export const MAX_REASON_LENGTH = 200;

const REASONING_LEVELS = [
  "none",
  "low",
  "medium",
  "high",
  "xhigh",
  "ultracode",
  "max",
  "ultra",
] as const;
const PERMISSION_MODES = ["accept-edits", "auto", "full"] as const;

const JSON_OPTION = {
  type: "boolean",
  description: "Emit machine-readable JSON",
} as const;

const queuedIdsSchema = z.array(z.string().min(1));
const queueIntentSchema = z.object({ queue: z.literal(true) });

const PROCEED: MessageDispatchHookDecision = { action: "proceed" };

interface ReleaseEntry {
  id: string;
  cause: string;
}

interface QueuedThreadRef {
  id: string;
  projectId: string;
  parentThreadId: string | null;
}

interface ThreadState {
  status: string;
  archivedAt: number | null;
  deletedAt: number | null;
}

type QueuedView =
  | {
      id: string;
      state: "queued";
      title: string | null;
      projectId: string;
      project: string;
      blockers: string[];
    }
  | { id: string; state: "stale"; reason: string }
  | { id: string; state: "unknown"; error: string };

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function httpStatus(error: unknown): number | null {
  if (typeof error !== "object" || error === null || !("status" in error)) {
    return null;
  }
  return typeof error.status === "number" ? error.status : null;
}

function staleReason(thread: ThreadState): string | null {
  if (thread.status !== "pending") return `thread is ${thread.status}`;
  if (thread.deletedAt !== null) return "thread was deleted";
  if (thread.archivedAt !== null) return "thread was archived";
  return null;
}

function waitDecision(
  blockerCount: number,
  projectName: string,
): MessageDispatchHookDecision {
  const reason = `${blockerCount} other thread${blockerCount === 1 ? "" : "s"} running in ${projectName}`;
  if (reason.length <= MAX_REASON_LENGTH) {
    return { action: "wait", reason };
  }
  let truncated = reason.slice(0, MAX_REASON_LENGTH - 1);
  const last = truncated.charCodeAt(truncated.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) {
    truncated = truncated.slice(0, -1);
  }
  return { action: "wait", reason: `${truncated}…` };
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolveSleep) => {
    if (signal.aborted) {
      resolveSleep();
      return;
    }
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolveSleep();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

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

  function formatView(view: QueuedView): string {
    if (view.state === "stale") {
      return `${view.id}  stale (${view.reason}), removed from the queue`;
    }
    if (view.state === "unknown") {
      return `${view.id}  could not be read: ${view.error}`;
    }
    const status =
      view.blockers.length === 0
        ? "no blockers, starts on the next recheck"
        : `blocked by ${view.blockers.join(", ")}`;
    return `${view.id}  ${view.title ?? "(untitled)"}  ${view.project}  ${status}`;
  }

  function printableLine(line: string): string {
    return line.replace(
      /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/gu,
      " ",
    );
  }

  bb.cli.register(
    defineCli({
      name: "project-queue",
      summary: "Start new threads only when their project is idle",
      description:
        "A queued thread waits until no other thread in its project is running, then starts. Only a thread's first message is queued; follow-ups are never held. The thread's own ancestors never block it.",
      commands: {
        spawn: cliCommand({
          summary: "Spawn a thread that waits until its project is idle",
          description:
            "Supports a small subset of `bb thread spawn` flags. The parent link is opt-in: a parent and its ancestors never block the child. Without a parent link the calling thread does block it, so do not `bb thread wait` on the child from a thread that is not its ancestor.",
          options: {
            prompt: {
              type: "string",
              placeholder: "text",
              required: true,
              description:
                'Initial prompt; for a file on this machine pass "$(cat <path>)"',
            },
            project: {
              type: "string",
              placeholder: "id",
              description:
                "Project id; defaults to the calling thread's project",
            },
            provider: {
              type: "string",
              placeholder: "id",
              description: "Provider id",
            },
            model: {
              type: "string",
              placeholder: "model",
              description: "Model id the provider accepts",
            },
            "reasoning-level": {
              type: "enum",
              values: REASONING_LEVELS,
              description: "Reasoning level (provider-dependent)",
            },
            "permission-mode": {
              type: "enum",
              values: PERMISSION_MODES,
              description: "Permission mode",
            },
            environment: {
              type: "string",
              placeholder: "id",
              description:
                "Existing environment id; omit to use the project default",
            },
            title: {
              type: "string",
              placeholder: "title",
              description: "Thread title",
            },
            "parent-thread": {
              type: "string",
              placeholder: "id",
              description:
                "Parent thread id; the parent and its ancestors never block this thread",
            },
            "parent-self": {
              type: "boolean",
              description:
                "Parent the new thread to the calling thread, which then never blocks it",
            },
            json: JSON_OPTION,
          },
          constraints: [
            { kind: "at-most-one", options: ["parent-thread", "parent-self"] },
          ],
          async run(input, ctx): Promise<PluginCliResult> {
            const { options } = input;
            const prompt = options.prompt;
            if (prompt.trim() === "") {
              throw new PluginCliError("The prompt is empty", {
                code: "invalid_value",
              });
            }
            const projectId = options.project ?? ctx.projectId;
            if (projectId === undefined) {
              throw new PluginCliError("No project to start the thread in", {
                code: "missing_project",
                hint: "pass --project <id>",
              });
            }
            let parentThreadId = options["parent-thread"];
            if (options["parent-self"]) {
              if (ctx.threadId === undefined) {
                throw new PluginCliError(
                  "--parent-self needs a calling thread",
                  {
                    code: "missing_thread",
                    hint: "pass --parent-thread <id>",
                  },
                );
              }
              parentThreadId = ctx.threadId;
            }
            const environmentId = options.environment;
            const thread = await bb.sdk.threads.spawn({
              projectId,
              prompt,
              environment:
                environmentId === undefined
                  ? { type: "project-default" }
                  : { type: "reuse", environmentId },
              ...(options.provider === undefined
                ? {}
                : { providerId: options.provider }),
              ...(options.model === undefined ? {} : { model: options.model }),
              ...(options["reasoning-level"] === undefined
                ? {}
                : { reasoningLevel: options["reasoning-level"] }),
              ...(options["permission-mode"] === undefined
                ? {}
                : { permissionMode: options["permission-mode"] }),
              ...(options.title === undefined ? {} : { title: options.title }),
              ...(parentThreadId === undefined ? {} : { parentThreadId }),
              pluginSubmission: {
                pluginId: bb.pluginId,
                data: { queue: true },
              },
            });
            const held = thread.status === "pending" && queued.has(thread.id);
            return {
              exitCode: 0,
              stdout: options.json
                ? JSON.stringify({ thread, queued: held })
                : held
                  ? `Thread ${thread.id} queued; it starts when no other thread in the project is running.`
                  : `Thread ${thread.id} spawned (${thread.status}).`,
            };
          },
        }),
        list: cliCommand({
          summary: "List queued threads and what blocks each",
          description:
            "Ids whose thread is missing or no longer pending are shown as stale and removed.",
          options: {
            project: {
              type: "string",
              placeholder: "id",
              description: "Only list threads in this project",
            },
            json: JSON_OPTION,
          },
          async run(input): Promise<PluginCliResult> {
            const views = await listViews(input.options.project);
            return {
              exitCode: 0,
              stdout: input.options.json
                ? JSON.stringify({ queued: views })
                : views.length === 0
                  ? "No queued threads."
                  : views
                      .map((view) => printableLine(formatView(view)))
                      .join("\n"),
            };
          },
        }),
        release: cliCommand({
          summary: "Stop holding a queued thread",
          description:
            "Removes the thread from the queue and rechecks. Unlike Send now, it still respects other plugins such as concurrency-limit.",
          positionals: [
            {
              name: "thread-id",
              description: "Queued thread id, as `list` prints it",
              required: true,
            },
          ],
          options: { json: JSON_OPTION },
          async run(input): Promise<PluginCliResult> {
            const threadId = input.positionals["thread-id"];
            if (!queued.has(threadId)) {
              throw new PluginCliError(`${threadId} is not queued`, {
                code: "not_queued",
                hint: "Run `bb project-queue list` for the queued thread ids.",
              });
            }
            await releaseThreads([
              { id: threadId, cause: "released by command" },
            ]);
            await recheckDispatch();
            return {
              exitCode: 0,
              stdout: input.options.json
                ? JSON.stringify({ threadId, released: true })
                : `Released ${threadId}; it starts once other plugins and core allow it.`,
            };
          },
        }),
      },
    }),
  );

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
