import {
  PluginCliError,
  cliCommand,
  defineCli,
  type BbPluginApi,
  type PluginCliResult,
} from "@get-bb/plugin-sdk";
import {
  DEFAULT_LIMIT,
  DIRECTIONS,
  JSON_OPTION,
  type Direction,
  type ProviderSummary,
  type QueuedView,
} from "./shared.js";
import { spawnCommand } from "./spawn.js";

interface QueueAccess {
  isQueued(threadId: string): boolean;
  listViews(providerFilter: string | undefined): Promise<QueuedView[]>;
  snapshot(): Promise<{ providers: ProviderSummary[]; queueOrder: string[] }>;
  enqueue(threadId: string, providerId: string): Promise<void>;
  moveQueued(threadId: string, direction: Direction): Promise<void>;
  releaseQueued(threadId: string): Promise<void>;
  limits(): Readonly<Record<string, number>>;
  limitOf(providerId: string): number;
  setLimit(providerId: string, limit: number): Promise<void>;
  recheckDispatch(): Promise<void>;
}

function printableLine(line: string): string {
  return line.replace(
    /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/gu,
    " ",
  );
}

function formatView(view: QueuedView): string {
  if (view.state === "stale") {
    return `${view.threadId}  stale (${view.reason}), removed from the queue`;
  }
  if (view.state === "unknown") {
    return `${view.threadId}  could not be read: ${view.error}`;
  }
  const status =
    view.waiting === null
      ? "  starts on the next recheck"
      : `  waiting: ${view.waiting}`;
  return `${view.threadId}  ${view.title ?? "(untitled)"}  ${view.provider}${status}`;
}

function requireQueued(threadId: string, queue: QueueAccess): void {
  if (!queue.isQueued(threadId)) {
    throw new PluginCliError(`${threadId} is not queued`, {
      code: "not_queued",
      hint: "Run `bb provider-queue list` for the queued thread ids.",
    });
  }
}

const THREAD_ID_POSITIONAL = {
  name: "thread-id",
  description: "Queued thread id, as `list` prints it",
  required: true,
} as const;

const PENDING_THREAD_ID_POSITIONAL = {
  name: "thread-id",
  description: "Pending thread id",
  required: true,
} as const;

export function registerCli(bb: BbPluginApi, queue: QueueAccess): void {
  bb.cli.register(
    defineCli({
      name: "provider-queue",
      summary: "Start queued threads only when their provider has a free slot",
      description:
        "A queued thread waits until fewer than its provider's limit of threads are running on that provider, then starts. Only a thread's first message is queued; follow-ups are never held. A thread waiting on the user does not count toward the limit. The thread's own ancestors never block it.",
      commands: {
        spawn: spawnCommand(bb, (threadId) => queue.isQueued(threadId)),
        add: addCommand(bb, queue),
        list: listCommand(queue),
        move: moveCommand(queue),
        release: releaseCommand(queue),
        limit: limitCommand(queue),
      },
    }),
  );
}

function addCommand(bb: BbPluginApi, queue: QueueAccess) {
  return cliCommand({
    summary: "Queue an existing pending thread",
    description:
      "Queues a thread that was started without the queue intent, on the provider it is currently set to.",
    positionals: [PENDING_THREAD_ID_POSITIONAL],
    options: { json: JSON_OPTION },
    async run(input): Promise<PluginCliResult> {
      const threadId = input.positionals["thread-id"];
      const thread = await bb.sdk.threads.get({ threadId });
      if (thread.status !== "pending") {
        throw new PluginCliError(`${threadId} is not pending`, {
          code: "not_pending",
          hint: "Only a pending thread can be queued.",
        });
      }
      if (queue.isQueued(threadId)) {
        throw new PluginCliError(`${threadId} is already queued`, {
          code: "already_queued",
        });
      }
      await queue.enqueue(threadId, thread.providerId);
      await queue.recheckDispatch();
      return {
        exitCode: 0,
        stdout: input.options.json
          ? JSON.stringify({
              threadId,
              providerId: thread.providerId,
              queued: true,
            })
          : `Added ${threadId} to the queue; it starts when its provider has a free slot.`,
      };
    },
  });
}

function listCommand(queue: QueueAccess) {
  return cliCommand({
    summary: "List queued threads and what each waits on",
    description:
      "Ids whose thread is missing or no longer pending are shown as stale and removed.",
    options: {
      provider: {
        type: "string",
        placeholder: "id",
        description: "Only list threads queued for this provider",
      },
      json: JSON_OPTION,
    },
    async run(input): Promise<PluginCliResult> {
      const providerFilter = input.options.provider;
      const views = await queue.listViews(providerFilter);
      const state = await queue.snapshot();
      const providers = state.providers.filter(
        (summary) =>
          summary.running.length +
            summary.awaiting.length +
            summary.queue.length >
            0 &&
          (providerFilter === undefined ||
            summary.providerId === providerFilter),
      );
      let queuedCount = 0;
      const lines = views.map((view) => {
        if (view.state !== "queued") return printableLine(formatView(view));
        queuedCount += 1;
        return printableLine(`${queuedCount}. ${formatView(view)}`);
      });
      if (lines.length === 0) lines.push("No queued threads.");
      if (providers.length > 0) {
        lines.push("");
        for (const summary of providers) {
          lines.push(
            printableLine(
              `${summary.label}: ${summary.running.length} running + ${summary.awaiting.length} awaiting you, limit ${summary.limit}`,
            ),
          );
        }
      }
      return {
        exitCode: 0,
        stdout: input.options.json
          ? JSON.stringify({ queued: views, providers })
          : lines.join("\n"),
      };
    },
  });
}

function moveCommand(queue: QueueAccess) {
  return cliCommand({
    summary: "Move a queued thread within the queue order",
    description:
      "up and down swap with the neighboring row; top and bottom move to the ends of the queue.",
    positionals: [
      {
        name: "thread-id",
        description: "Queued thread id, as `list` prints it",
        required: true,
      },
      {
        name: "direction",
        description: `Where to move it: ${DIRECTIONS.join(", ")}`,
        required: true,
      },
    ],
    options: { json: JSON_OPTION },
    async run(input): Promise<PluginCliResult> {
      const threadId = input.positionals["thread-id"];
      const direction = input.positionals.direction;
      requireQueued(threadId, queue);
      if (!(DIRECTIONS as readonly string[]).includes(direction)) {
        throw new PluginCliError(`Unknown direction ${direction}`, {
          code: "invalid_value",
        });
      }
      await queue.moveQueued(threadId, direction as Direction);
      return {
        exitCode: 0,
        stdout: input.options.json
          ? JSON.stringify({ threadId, direction, moved: true })
          : `Moved ${threadId} ${direction}.`,
      };
    },
  });
}

function releaseCommand(queue: QueueAccess) {
  return cliCommand({
    summary: "Stop holding a queued thread",
    description:
      "Removes the thread from the queue and rechecks. Unlike Send now, it still respects other plugins such as concurrency-limit.",
    positionals: [THREAD_ID_POSITIONAL],
    options: { json: JSON_OPTION },
    async run(input): Promise<PluginCliResult> {
      const threadId = input.positionals["thread-id"];
      requireQueued(threadId, queue);
      await queue.releaseQueued(threadId);
      return {
        exitCode: 0,
        stdout: input.options.json
          ? JSON.stringify({ threadId, released: true })
          : `Released ${threadId}; it starts once other plugins and core allow it.`,
      };
    },
  });
}

function limitCommand(queue: QueueAccess) {
  return cliCommand({
    summary: "Show or set how many threads may run per provider",
    description:
      "With no arguments, prints every configured limit and the default. A limit of 0 pauses the provider: every queued thread on it is held.",
    positionals: [
      {
        name: "provider",
        description: "Provider id",
      },
      {
        name: "limit",
        description: "New limit; 0 holds every queued thread on the provider",
      },
    ],
    options: { json: JSON_OPTION },
    async run(input): Promise<PluginCliResult> {
      const providerId = input.positionals.provider;
      const limit = input.positionals.limit;
      if (providerId === undefined) {
        return {
          exitCode: 0,
          stdout: input.options.json
            ? JSON.stringify({
                limits: queue.limits(),
                defaultLimit: DEFAULT_LIMIT,
              })
            : [
                ...Object.entries(queue.limits()).map(
                  ([id, value]) => `${id}: ${value}`,
                ),
                `(default ${DEFAULT_LIMIT} for every other provider)`,
              ].join("\n"),
        };
      }
      if (limit === undefined) {
        const configured = queue.limits()[providerId];
        return {
          exitCode: 0,
          stdout: input.options.json
            ? JSON.stringify({
                providerId,
                limit: configured ?? DEFAULT_LIMIT,
                default: configured === undefined,
              })
            : `${providerId}: ${
                configured === undefined ? `default ${DEFAULT_LIMIT}` : configured
              }`,
        };
      }
      const value = Number(limit);
      if (!Number.isInteger(value) || value < 0) {
        throw new PluginCliError(
          `The limit must be a whole number of 0 or more, not ${limit}`,
          { code: "invalid_value" },
        );
      }
      await queue.setLimit(providerId, value);
      const lines = [`Set ${providerId} limit to ${value}.`];
      if (value === 0) {
        lines.push(
          `${providerId} is now paused: every queued thread on it is held until the limit is raised.`,
        );
      }
      return {
        exitCode: 0,
        stdout: input.options.json
          ? JSON.stringify({ providerId, limit: value })
          : lines.join("\n"),
      };
    },
  });
}
