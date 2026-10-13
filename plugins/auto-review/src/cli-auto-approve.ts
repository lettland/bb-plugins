import type { BbPluginApi, PluginCliContext, PluginCliResult } from "@get-bb/plugin-sdk";
import { commandError, json } from "./cli-result.js";
import { setAutoApprovePlans } from "./config.js";

const AUTO_APPROVE_USAGE = "Usage: bb auto-review auto-approve <on|off> --project <id> [--json]\n";

/** A failed `auto-approve`. */
function autoApproveError(
  message: string,
  wantsJson: boolean,
  extra: Record<string, unknown> = {},
): PluginCliResult {
  return commandError("auto-approve", message, wantsJson, extra);
}

/**
 * Removes the human checkpoint on plans, so the project is never implied from
 * the thread or a global scope: it is always named, and it must exist. Turning
 * it on is refused from inside a thread, a guard against an agent doing so by
 * accident. It keys off the thread context, which an agent could strip, so it
 * is not a security boundary.
 */
export async function setAutoApprove(
  bb: BbPluginApi,
  context: PluginCliContext,
  args: {
    value: string | undefined;
    projectId: string | true | undefined;
    global: boolean;
    wantsJson: boolean;
  },
): Promise<PluginCliResult> {
  const { value, projectId, wantsJson } = args;
  if ((value !== "on" && value !== "off") || args.global) {
    return { exitCode: 2, stderr: AUTO_APPROVE_USAGE };
  }
  if (typeof projectId !== "string") {
    return autoApproveError(
      "--project <id> is required for auto-approve (it is never inferred from the thread).",
      wantsJson,
    );
  }
  const threadId = context.threadId ?? null;
  if (value === "on" && threadId !== null) {
    return autoApproveError(
      "Turning plan auto-approve on is only allowed from the settings page (Tools → Auto review → Plan auto-approve) or a terminal outside a bb thread.",
      wantsJson,
      { projectId },
    );
  }
  const projects = await bb.sdk.projects.list({ includePersonal: true });
  if (!projects.some((project) => project.id === projectId)) {
    return autoApproveError(`Project ${projectId} not found.`, wantsJson, { projectId });
  }
  const autoApprovePlans = value === "on";
  await setAutoApprovePlans(
    bb,
    projectId,
    autoApprovePlans,
    `cli (${threadId === null ? "terminal" : `thread ${threadId}`})`,
  );
  return wantsJson
    ? json({ ok: true, scope: "project", projectId, autoApprovePlans })
    : { exitCode: 0, stdout: `Plan auto-approve ${value} for project ${projectId}.\n` };
}
