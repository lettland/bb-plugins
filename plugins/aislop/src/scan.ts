import { execFile } from "node:child_process";
import { PLUGIN_CLI_OUTPUT_MAX_BYTES } from "@get-bb/plugin-sdk";
import type { z } from "zod";
import type { hostContract } from "../contract.js";

export type ScanInput = z.infer<(typeof hostContract)["scan"]["input"]>;
export type ScanOutput = z.infer<(typeof hostContract)["scan"]["output"]>;

export interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type Exec = (
  command: string,
  args: string[],
  options: { cwd: string; timeoutMs: number; signal?: AbortSignal },
) => Promise<RunResult>;

/** Plain `execFile`, resolving (never rejecting) with the child's exit code. */
export const exec: Exec = (command, args, { cwd, timeoutMs, signal }) =>
  new Promise((resolve) => {
    execFile(
      command,
      args,
      {
        cwd,
        timeout: timeoutMs,
        signal,
        maxBuffer: 64 * 1024 * 1024,
        env: { ...process.env, NO_COLOR: "1" },
      },
      (error, stdout, stderr) => {
        if (error === null) {
          resolve({ exitCode: 0, stdout, stderr });
          return;
        }
        const code = (error as NodeJS.ErrnoException).code;
        if (typeof code === "number") {
          resolve({ exitCode: code, stdout, stderr });
          return;
        }
        const reason = (error as { killed?: boolean }).killed
          ? `${command} timed out after ${Math.round(timeoutMs / 1000)}s`
          : error.message;
        resolve({ exitCode: code === "ENOENT" ? 127 : 124, stdout, stderr: `${stderr}${reason}\n` });
      },
    );
  });

const GIT_TIMEOUT_MS = 30_000;

class ScanError extends Error {}

async function git(run: Exec, cwd: string, args: string[]): Promise<string | null> {
  const result = await run("git", args, { cwd, timeoutMs: GIT_TIMEOUT_MS });
  return result.exitCode === 0 ? result.stdout.trim() : null;
}

async function commitOf(run: Exec, cwd: string, ref: string): Promise<string | null> {
  return git(run, cwd, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
}

/**
 * The root ref to compare a branch against: bb's root branch when it named one,
 * then the repo's own guesses. The remote copy wins over the local one, so on
 * the root branch itself its unpushed commits still count as "my changes".
 */
async function resolveRootRef(run: Exec, cwd: string, rootBranch: string | null): Promise<string> {
  const originHead = await git(run, cwd, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
  const named = rootBranch === null ? [] : [`origin/${rootBranch}`, rootBranch];
  const candidates = [
    ...new Set([...named, originHead, "origin/main", "main", "origin/master", "master"]),
  ].filter((ref): ref is string => ref !== null && ref !== "");
  for (const ref of candidates) {
    if ((await commitOf(run, cwd, ref)) !== null) return ref;
  }
  throw new ScanError(
    `No root branch found (tried ${candidates.join(", ")}). Pass --base <ref> to name the branch to compare against.`,
  );
}

/**
 * The commit aislop diffs against. aislop's own `--base` diffs against the
 * ref's tip, which would also pull in whatever landed on the root after the
 * branch forked, so the branch scope hands it the merge-base instead.
 */
export async function resolveBase(
  run: Exec,
  input: Pick<ScanInput, "directory" | "scope" | "base" | "rootBranch">,
): Promise<ScanOutput["base"]> {
  const cwd = input.directory;
  if (input.scope === "staged" || input.scope === "all") return null;
  if (input.scope === "changes") {
    const sha = await commitOf(run, cwd, "HEAD");
    if (sha === null) throw new ScanError(`${cwd} is not a git checkout with a HEAD commit.`);
    return { ref: "HEAD", sha };
  }
  if ((await git(run, cwd, ["rev-parse", "--is-inside-work-tree"])) !== "true") {
    throw new ScanError(`${cwd} is not inside a git checkout.`);
  }
  const ref = input.base ?? (await resolveRootRef(run, cwd, input.rootBranch));
  if ((await commitOf(run, cwd, ref)) === null) throw new ScanError(`Unknown ref: ${ref}`);
  const sha = await git(run, cwd, ["merge-base", "HEAD", ref]);
  if (sha === null) throw new ScanError(`HEAD has no common ancestor with ${ref}.`);
  return { ref, sha };
}

export function aislopArgs(input: ScanInput, base: ScanOutput["base"]): string[] {
  const args = ["--yes", "aislop@latest", "scan"];
  if (base !== null) args.push("--changes", "--base", base.sha);
  if (input.scope === "staged") args.push("--staged");
  if (input.verbose) args.push("--verbose");
  if (input.json) args.push("--json");
  for (const pattern of input.include) args.push("--include", pattern);
  for (const pattern of input.exclude) args.push("--exclude", pattern);
  args.push(".");
  return args;
}

export async function scan(input: ScanInput, run: Exec = exec, signal?: AbortSignal): Promise<ScanOutput> {
  let base: ScanOutput["base"];
  try {
    base = await resolveBase(run, input);
  } catch (error) {
    if (!(error instanceof ScanError)) throw error;
    return { exitCode: 2, stdout: "", stderr: `${error.message}\n`, base: null };
  }
  const result = await run("npx", aislopArgs(input, base), {
    cwd: input.directory,
    timeoutMs: input.timeoutMs,
    signal,
  });
  const stderr = clip(result.stderr, STDERR_BUDGET);
  const stdout = clip(result.stdout, OUTPUT_BUDGET - Buffer.byteLength(stderr));
  return { exitCode: result.exitCode, stdout, stderr, base };
}

/** bb rejects (never clips) CLI output past this; keep room for the server's header line. */
const OUTPUT_BUDGET = PLUGIN_CLI_OUTPUT_MAX_BYTES - 16 * 1024;
const STDERR_BUDGET = 64 * 1024;

export function clip(text: string, maxBytes: number): string {
  const buffer = Buffer.from(text);
  if (buffer.byteLength <= maxBytes) return text;
  const note = `\n[output truncated at ${maxBytes} bytes; narrow the scan with --include or drop --verbose]\n`;
  return buffer.subarray(0, maxBytes - Buffer.byteLength(note)).toString() + note;
}
