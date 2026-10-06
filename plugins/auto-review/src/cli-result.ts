import type { PluginCliResult } from "@get-bb/plugin-sdk";

export function json(value: unknown, exitCode = 0): PluginCliResult {
  return { exitCode, stdout: `${JSON.stringify(value, null, 2)}\n` };
}
