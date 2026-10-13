import type { PluginCliResult } from "@get-bb/plugin-sdk";

export function json(value: unknown, exitCode = 0): PluginCliResult {
  return { exitCode, stdout: `${JSON.stringify(value, null, 2)}\n` };
}

/** A failed command: the message on stderr, or the `{ ok: false }` shape under `--json`. */
export function commandError(
  command: string,
  message: string,
  wantsJson: boolean,
  extra: Record<string, unknown> = {},
): PluginCliResult {
  return wantsJson
    ? json({ ok: false, command, ...extra, error: message }, 2)
    : { exitCode: 2, stderr: `${message}\n` };
}
