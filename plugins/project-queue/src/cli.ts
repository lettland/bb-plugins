import {
  PluginCliError,
  cliCommand,
  defineCli,
  type BbPluginApi,
  type PluginCliResult,
} from "@get-bb/plugin-sdk";
import {
  JSON_OPTION,
  PERMISSION_MODES,
  REASONING_LEVELS,
  type QueuedView,
  type ReleaseEntry,
} from "./shared.js";

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

interface QueueAccess {
  queued: ReadonlySet<string>;
  listViews(projectFilter: string | undefined): Promise<QueuedView[]>;
  releaseThreads(entries: readonly ReleaseEntry[]): Promise<void>;
  recheckDispatch(): Promise<void>;
}

export function registerCli(bb: BbPluginApi, queue: QueueAccess): void {
  const { queued, listViews, releaseThreads, recheckDispatch } = queue;
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
}
