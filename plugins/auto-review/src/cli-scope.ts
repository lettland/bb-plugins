import type { BbPluginApi, PluginCliContext, PluginCliResult } from "@get-bb/plugin-sdk";
import { json } from "./cli-result.js";
import { defineAutoReviewSettings, writeProjectConfig } from "./config.js";

export type SettingsHandle = ReturnType<typeof defineAutoReviewSettings>;

export async function resolveProjectId(
  bb: BbPluginApi,
  context: PluginCliContext,
): Promise<string | null> {
  if (context.threadId === undefined || context.threadId === null) {
    return null;
  }
  const thread = await bb.sdk.threads.get({ threadId: context.threadId });
  return thread.projectId;
}

export async function setScope(
  bb: BbPluginApi,
  settings: SettingsHandle,
  context: PluginCliContext,
  args: { projectFlag: string | true | undefined; global: boolean; wantsJson: boolean },
  enabled: boolean,
): Promise<PluginCliResult> {
  const wantsJson = args.wantsJson;
  const projectFlag = args.projectFlag;
  if (args.global && projectFlag !== undefined) {
    return {
      exitCode: 2,
      stderr: "Specify only one of --global or --project <id>.\n",
    };
  }
  const global = args.global || projectFlag === undefined;

  if (global) {
    await settings.experimental_set({ enabled });
    const payload = { ok: true, scope: "global", enabled };
    return wantsJson
      ? json(payload)
      : {
          exitCode: 0,
          stdout: `Auto-review ${enabled ? "enabled" : "disabled"} globally.\n`,
        };
  }

  const projectId =
    typeof projectFlag === "string"
      ? projectFlag
      : await resolveProjectId(bb, context);
  if (projectId === null) {
    return {
      exitCode: 2,
      stderr: "A project id is required: pass --project <id> or run inside a thread.\n",
    };
  }
  await writeProjectConfig(bb, projectId, { enabled });
  const payload = { ok: true, scope: "project", projectId, enabled };
  return wantsJson
    ? json(payload)
    : {
        exitCode: 0,
        stdout: `Auto-review ${enabled ? "enabled" : "disabled"} for project ${projectId}.\n`,
      };
}
