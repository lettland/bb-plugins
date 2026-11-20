import { execFile } from "node:child_process";
import {
  PLUGIN_CLI_OUTPUT_MAX_BYTES,
  PluginCliError,
  cliCommand,
  defineCli,
  type BbPluginApi,
} from "@get-bb/plugin-sdk";
import { catalogErrors, catalogSchema, rpcContract } from "./contract.js";

function readCatalog(json: boolean, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "margrave",
      ["list", "--skills", ...(json ? ["--json"] : [])],
      { maxBuffer: PLUGIN_CLI_OUTPUT_MAX_BYTES, signal },
      (error, stdout) => {
        if (error) {
          const missing = "code" in error && error.code === "ENOENT";
          reject(
            new PluginCliError(
              missing ? catalogErrors.missing : catalogErrors.failed,
              {
                code: missing ? "margrave_missing" : "margrave_failed",
              },
            ),
          );
          return;
        }
        resolve(stdout);
      },
    );
  });
}

export default function plugin(bb: BbPluginApi) {
  bb.cli.register(
    defineCli({
      name: "margrave",
      summary: "List the skills installed in Margrave",
      commands: {
        list: cliCommand({
          summary: "List the skills installed in Margrave",
          options: { json: { type: "boolean", description: "Output JSON" } },
          async run(input, context) {
            return {
              exitCode: 0,
              stdout: await readCatalog(
                input.options.json === true,
                context.signal,
              ),
            };
          },
        }),
      },
    }),
  );
  bb.rpc.register(rpcContract, {
    async listSkills(_input, context) {
      let output: string;
      try {
        output = await readCatalog(true, context.experimental_signal);
      } catch (error) {
        return {
          ok: false as const,
          error:
            error instanceof PluginCliError && error.code === "margrave_missing"
              ? ("missing" as const)
              : ("failed" as const),
        };
      }
      let value: unknown;
      try {
        value = JSON.parse(output);
      } catch {
        return { ok: false as const, error: "invalid" as const };
      }
      const parsed = catalogSchema.safeParse(value);
      if (!parsed.success) {
        return { ok: false as const, error: "invalid" as const };
      }
      return { ok: true as const, skills: parsed.data.skills };
    },
  });
}
