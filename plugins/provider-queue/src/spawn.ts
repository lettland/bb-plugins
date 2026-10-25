import {
  PluginCliError,
  cliCommand,
  type BbPluginApi,
  type PluginCliOption,
  type PluginCliResult,
} from "@get-bb/plugin-sdk";
import {
  JSON_OPTION,
  PERMISSION_MODES,
  REASONING_LEVELS,
} from "./shared.js";

const SPAWN_OPTIONS = {
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
    description: "Project id; defaults to the calling thread's project",
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
    description: "Existing environment id; omit to use the project default",
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
} as const satisfies Record<string, PluginCliOption>;

export function spawnCommand(
  bb: BbPluginApi,
  isQueued: (threadId: string) => boolean,
) {
  return cliCommand({
    summary: "Spawn a thread that waits until its provider has a free slot",
    description:
      "Supports a small subset of `bb thread spawn` flags. The parent link is opt-in: a parent and its ancestors never block the child. Without a parent link the calling thread does block it, so do not `bb thread wait` on the child from a thread that is not its ancestor.",
    options: SPAWN_OPTIONS,
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
          throw new PluginCliError("--parent-self needs a calling thread", {
            code: "missing_thread",
            hint: "pass --parent-thread <id>",
          });
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
      const held = thread.status === "pending" && isQueued(thread.id);
      return {
        exitCode: 0,
        stdout: options.json
          ? JSON.stringify({ thread, queued: held })
          : held
            ? `Thread ${thread.id} queued; it starts when its provider has a free slot.`
            : `Thread ${thread.id} spawned (${thread.status}).`,
      };
    },
  });
}
