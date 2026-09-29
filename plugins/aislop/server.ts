import path from "node:path";
import { PluginCliError, cliCommand, defineCli, type BbPluginApi, type PluginCliContext } from "@get-bb/plugin-sdk";
import { SCOPES, hostContract } from "./contract.js";

const MINUTE_MS = 60_000;
/** Host RPC calls are capped at 30 minutes; keep the scan's own timeout under that. */
const MAX_TIMEOUT_MS = 25 * MINUTE_MS;
const HOST_CALL_GRACE_MS = MINUTE_MS;

interface Target {
  hostId: string;
  directory: string;
  rootBranch: string | null;
}

/**
 * Where to scan. Inside a thread the checkout lives on the thread's host and bb
 * knows its root branch; from a plain terminal it is the server's own machine.
 */
async function resolveTarget(
  bb: BbPluginApi,
  ctx: PluginCliContext,
  directoryArg: string | undefined,
): Promise<Target> {
  let hostId: string | null = null;
  let cwd = ctx.cwd ?? null;
  let envPath: string | null = null;
  let envRootBranch: string | null = null;
  if (ctx.threadId !== undefined) {
    const thread = await bb.sdk.threads.get({ threadId: ctx.threadId });
    if (thread.environmentId !== null) {
      const env = await bb.sdk.environments.get({ environmentId: thread.environmentId });
      hostId = env.hostId;
      envPath = env.path;
      cwd ??= env.path;
      envRootBranch = env.mergeBaseBranch ?? env.defaultBranch;
    }
  }
  hostId ??= (await bb.sdk.system.config()).primaryHostId;
  if (hostId === null) {
    throw new PluginCliError("No machine to run the scan on: this bb server has no local host.", {
      code: "no_host",
      hint: "Run `bb aislop scan` from a thread whose environment is on an enrolled machine.",
    });
  }
  let directory = cwd;
  if (directoryArg !== undefined) {
    directory = path.isAbsolute(directoryArg) ? directoryArg : cwd === null ? null : path.resolve(cwd, directoryArg);
  }
  if (directory === null) {
    throw new PluginCliError("No working directory to scan.", {
      code: "no_directory",
      hint: "Pass an absolute path: `bb aislop scan /path/to/repo`.",
    });
  }
  // bb's root branch belongs to the thread's checkout, not to some other repo scanned from it.
  const fromCheckout = envPath === null ? null : path.relative(envPath, directory);
  const inCheckout = fromCheckout !== null && !fromCheckout.startsWith("..") && !path.isAbsolute(fromCheckout);
  return { hostId, directory, rootBranch: inCheckout ? envRootBranch : null };
}

/** Null when the host could not resolve a diff base; its stderr says why. */
function describeScope(scope: string, base: { ref: string; sha: string } | null): string | null {
  if (scope === "staged") return "staged changes";
  if (scope === "all") return "the whole directory";
  if (base === null) return null;
  if (scope === "changes") return "uncommitted changes against HEAD";
  return `changes since ${base.sha.slice(0, 10)} (merge-base of HEAD and ${base.ref}), committed or not`;
}

export default async function plugin(bb: BbPluginApi) {
  const host = bb.hosts.experimental_client({ contract: hostContract });

  bb.cli.register(
    defineCli({
      name: "aislop",
      summary: "Run the aislop quality scan on this checkout, by default only on what the branch changed",
      commands: {
        scan: cliCommand({
          summary: "Score changed code with aislop (default: this branch against its root branch)",
          description:
            "Runs `npx aislop@latest scan` in the checkout on the thread's machine. The default --scope branch " +
            "scans every file changed since the branch forked from its root (committed, staged, unstaged, and " +
            "untracked), so work the root gained since does not show up. Exit code is aislop's own.",
          positionals: [
            {
              name: "directory",
              description: "Directory to scan, relative to the current directory (default: the current directory)",
            },
          ],
          options: {
            scope: {
              type: "enum",
              values: SCOPES,
              default: "branch",
              description:
                "branch: changes since the merge-base with the root branch; changes: uncommitted changes vs HEAD; " +
                "staged: staged changes only; all: the whole directory",
            },
            base: {
              type: "string",
              placeholder: "ref",
              description:
                "Compare against this ref instead of the root branch (merge-base is still used). Only with --scope branch",
            },
            include: {
              type: "string",
              repeatable: true,
              split: ",",
              placeholder: "pattern",
              description: "Only scan paths matching this pattern; accepts a comma-separated list",
            },
            exclude: {
              type: "string",
              repeatable: true,
              split: ",",
              placeholder: "pattern",
              description: "Skip paths matching this pattern; accepts a comma-separated list",
            },
            verbose: { type: "boolean", short: "d", description: "Show file details per rule" },
            json: { type: "boolean", description: "Print aislop's JSON report on stdout" },
            timeout: {
              type: "duration",
              defaultUnit: "m",
              min: 10_000,
              max: MAX_TIMEOUT_MS,
              default: 15 * MINUTE_MS,
              description: "Give up after this long, e.g. 90s or 20m (default 15m, max 25m)",
            },
          },
          async run(input, ctx) {
            const { scope, base, include, exclude, verbose, json, timeout } = input.options;
            if (base !== undefined && scope !== "branch") {
              throw new PluginCliError(`--base only applies to --scope branch, not --scope ${scope}.`, {
                code: "base_needs_branch_scope",
                hint: "Drop --base, or use --scope branch.",
              });
            }
            const target = await resolveTarget(bb, ctx, input.positionals.directory);
            const result = await host.call(
              "scan",
              {
                directory: target.directory,
                scope,
                base: base ?? null,
                rootBranch: target.rootBranch,
                verbose,
                json,
                include,
                exclude,
                timeoutMs: timeout,
              },
              { hostId: target.hostId, signal: ctx.signal, timeoutMs: timeout + HOST_CALL_GRACE_MS },
            );
            const described = describeScope(scope, result.base);
            const header = described === null ? "" : `aislop: scanning ${described} in ${target.directory}\n`;
            return { exitCode: result.exitCode, stdout: result.stdout, stderr: header + result.stderr };
          },
        }),
      },
    }),
  );
}
