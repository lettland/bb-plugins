import type { BbPluginApi, MessageDispatchHookContext } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { decide } from "./src/client.js";
import { registerDecideTool } from "./src/tool.js";
import {
  TriageStore,
  TRIAGE_QUESTIONS,
  TRIAGE_TIMEOUT_MS,
  buildTriageEntry,
  triageState,
} from "./src/triage.js";

const skipProjectsSchema = z.array(z.string().trim().min(1));

export function parseSkipProjects(json: string): string[] {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (error) {
    throw new Error(
      `not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const parsed = skipProjectsSchema.safeParse(raw);
  if (!parsed.success) throw new Error(z.prettifyError(parsed.error));
  return parsed.data;
}

/** Validates the setting on write so a broken value never gets stored. */
export const skipProjectsSettingSchema = z.string().superRefine((json, ctx) => {
  try {
    parseSkipProjects(json);
  } catch (error) {
    ctx.addIssue({
      code: "custom",
      message: error instanceof Error ? error.message : String(error),
    });
  }
});

function globToRegExp(glob: string): RegExp {
  const escaped = glob
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`);
}

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    apiKey: {
      type: "string",
      label: "API key",
      description:
        "TypeSafe API key. Falls back to the TYPESAFE_API_KEY environment variable when unset.",
      secret: true,
    },
    model: {
      type: "string",
      label: "Model",
      description: "Pinned Jev model id, so classification does not drift.",
      default: "jev-1.14.0",
    },
    triage: {
      type: "boolean",
      label: "Opening-request triage",
      description:
        "Classify each top-level thread's opening request with Jev and add one advisory line to its instructions.",
      default: true,
    },
    skipProjects: {
      type: "string",
      label: "Skip projects",
      description:
        'JSON array of project-name globs that get neither triage nor the typesafe_decide tool, e.g. ["sandbox-*"]. * is the only special character.',
      experimental_multiline: true,
      experimental_schema: skipProjectsSettingSchema,
      default: "[]",
    },
  });

  interface Config {
    apiKey: string | null;
    model: string;
    triage: boolean;
    skipProjects: string[];
  }

  function loadConfig(next: {
    apiKey?: string;
    model: string;
    triage: boolean;
    skipProjects: string;
  }): Config {
    let skipProjects: string[];
    try {
      skipProjects = parseSkipProjects(next.skipProjects);
    } catch (error) {
      bb.log.warn(
        `skipProjects setting ignored: ${error instanceof Error ? error.message : String(error)}`,
      );
      skipProjects = [];
    }
    return { apiKey: next.apiKey ?? null, model: next.model, triage: next.triage, skipProjects };
  }

  let config = loadConfig(await settings.get());
  settings.onChange((next) => {
    config = loadConfig(next);
  });

  const effectiveApiKey = () => config.apiKey || process.env.TYPESAFE_API_KEY || null;
  const log = (line: string) => bb.log.info(line);

  if (effectiveApiKey() === null) {
    bb.status.needsConfiguration("no TypeSafe key: triage and tool inactive");
  }

  const store = new TriageStore();

  registerDecideTool(bb, {
    getApiKey: effectiveApiKey,
    getModel: () => config.model,
    log,
  });

  const skipped = (projectName: string) =>
    config.skipProjects.some((glob) => globToRegExp(glob).test(projectName));

  bb.agents.configure((ctx) => ({
    tools: ctx.origin.kind === "fork" || skipped(ctx.project.name) ? [] : ["typesafe_decide"],
    skills: [],
  }));

  bb.experimental_hooks.on("message.dispatch", async (ctx) => {
    try {
      await triage(ctx);
    } catch (error) {
      bb.log.warn(`triage skipped: ${error instanceof Error ? error.message : String(error)}`);
    }
    return { action: "proceed" };
  });

  bb.agents.contributeInstructions(({ threadId }) => store.line(threadId));

  async function triage(ctx: MessageDispatchHookContext): Promise<void> {
    if (!config.triage || skipped(ctx.project.name)) return;
    if (ctx.initiator !== "user") return;
    if (ctx.attempt !== "start-turn") return;
    if (ctx.parentThreadId !== null) return;
    if (ctx.thread.status !== "pending") return;
    if (ctx.queuedMessages.length !== 0) return;
    const threadId = ctx.thread.id;
    if (store.has(threadId)) return;
    const outcome = await decide(
      {
        state: triageState(ctx.input.text),
        questions: TRIAGE_QUESTIONS,
        model: config.model,
        apiKey: effectiveApiKey(),
        timeoutMs: TRIAGE_TIMEOUT_MS,
      },
      { log },
    );
    if (outcome.kind !== "ok") return;
    const entry = buildTriageEntry(outcome.value.answers);
    if (entry === null) return;
    store.set(threadId, entry);
  }
}
