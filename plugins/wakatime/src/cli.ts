import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { PluginLogger } from "@get-bb/plugin-sdk";
import type { ErrorKind, PathProblem } from "./rpc-contract.js";

/** Above the CLI's own 120 s API timeout, leaving room for its offline-queue sync. */
export const HEARTBEAT_TIMEOUT_MS = 150_000;
export const SYNC_TIMEOUT_MS = 10 * 60_000;
export const MAX_CONCURRENT = 4;
export const FAILURE_LOG_INTERVAL_MS = 10 * 60_000;

// wakatime-cli always leaves stderr empty and logs to ~/.wakatime/wakatime.log,
// so a failure is classified from the exit code alone.
const EXIT_API = 102;
const EXIT_CONFIG = 103;
const EXIT_AUTH = 104;
const EXIT_BACKOFF = 112;

export interface ExecResult {
  exitCode: number | null;
  /** Set when the process was killed, which here means the timeout fired. */
  signal: string | null;
  /** A spawn failure code such as ENOENT; null when the process ran. */
  spawnError: string | null;
}

export type Exec = (file: string, args: string[], options: { timeoutMs: number }) => Promise<ExecResult>;

/** No shell: every argument reaches the process as one argv entry. */
export const defaultExec: Exec = (file, args, { timeoutMs }) =>
  new Promise((resolve) => {
    execFile(
      file,
      args,
      { timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: 1024 * 1024, windowsHide: true },
      (error) => {
        if (!error) {
          resolve({ exitCode: 0, signal: null, spawnError: null });
          return;
        }
        const code = error.code;
        resolve({
          exitCode: typeof code === "number" ? code : null,
          signal: error.signal ?? null,
          spawnError: typeof code === "string" ? code : null,
        });
      },
    );
  });

export interface Job {
  /** At most one job per key runs at a time; a newer queued job replaces an older one. */
  key: string;
  kind: "heartbeat" | "sync";
  /** The `cliPath` setting as typed; logs show this, never the expanded path. */
  cliPath: string;
  args: string[];
  timeoutMs: number;
}

export type JobOutcome = "ok" | "failed" | "skipped" | "superseded";

export interface RunnerHealth {
  lastHeartbeatAt: number | null;
  lastSyncAt: number | null;
  lastError: {
    kind: ErrorKind;
    job: Job["kind"];
    exitCode: number | null;
    at: number;
    problem?: PathProblem;
  } | null;
}

export interface Runner {
  submit(job: Job): Promise<JobOutcome>;
  /**
   * Run the path check for `cliPath` now, updating the health state the way a
   * job would: a passing check clears a `missing-cli` error, a failing one
   * records the problem.
   */
  verify(cliPath: string): Promise<void>;
  health(): RunnerHealth;
  /** Resolves queued jobs as skipped and refuses new ones; in-flight jobs finish. */
  dispose(): void;
}

export function expandHome(raw: string): string {
  const value = raw.trim();
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  return value;
}

async function checkCli(file: string): Promise<PathProblem | null> {
  if (!path.isAbsolute(file)) return "not-absolute";
  try {
    if (!(await stat(file)).isFile()) return "not-a-file";
  } catch {
    return "not-found";
  }
  try {
    await access(file, constants.X_OK);
  } catch {
    return "not-executable";
  }
  return null;
}

export function classify(result: ExecResult): ErrorKind {
  if (result.spawnError === "ENOENT" || result.spawnError === "EACCES") return "missing-cli";
  if (result.spawnError !== null) return "other";
  if (result.signal !== null) return "timeout";
  if (result.exitCode === EXIT_AUTH) return "auth";
  if (result.exitCode === EXIT_API || result.exitCode === EXIT_BACKOFF) return "network";
  if (result.exitCode === EXIT_CONFIG) return "config";
  return "other";
}

interface Entry {
  job: Job;
  resolve: (outcome: JobOutcome) => void;
}

export function createRunner(options: { exec?: Exec; log: PluginLogger }): Runner {
  const exec = options.exec ?? defaultExec;
  const { log } = options;
  const queue: Entry[] = [];
  const inFlightKeys = new Set<string>();
  const lastLoggedAt = new Map<ErrorKind, number>();
  const warnedPaths = new Set<string>();
  const state: RunnerHealth = { lastHeartbeatAt: null, lastSyncAt: null, lastError: null };
  // The last path that passed the check; cleared by a spawn error so it is re-checked.
  let verifiedPath: string | null = null;
  // The last path reported as usable, to log a change once.
  let reportedPath: string | null = null;
  let running = 0;
  let disposed = false;

  async function ensureUsable(
    file: string,
    job: Pick<Job, "cliPath" | "kind">,
    recheck = false,
  ): Promise<boolean> {
    if (!recheck && verifiedPath === file) return true;
    const problem = await checkCli(file);
    if (problem === null) {
      verifiedPath = file;
      warnedPaths.delete(file);
      // Only a path-check error: one from a real spawn failure (no `problem`)
      // stays until a job succeeds.
      if (state.lastError?.kind === "missing-cli" && state.lastError.problem !== undefined) state.lastError = null;
      if (reportedPath !== null && reportedPath !== file) {
        log.info(`wakatime-cli path changed to ${job.cliPath.trim()}`);
      }
      reportedPath = file;
      return true;
    }
    verifiedPath = null;
    // The same problem again keeps its job and time, so reading the status does not move them.
    const last = state.lastError;
    if (last?.kind !== "missing-cli" || last.problem !== problem) {
      state.lastError = { kind: "missing-cli", job: job.kind, exitCode: null, at: Date.now(), problem };
    }
    if (!warnedPaths.has(file)) {
      warnedPaths.add(file);
      log.warn(
        `wakatime-cli is not usable at ${job.cliPath.trim()} (${problem}); heartbeats are skipped until it is`,
      );
    }
    return false;
  }

  function recordFailure(job: Job, kind: ErrorKind, exitCode: number | null): void {
    const now = Date.now();
    state.lastError = { kind, job: job.kind, exitCode, at: now };
    const last = lastLoggedAt.get(kind);
    if (last !== undefined && now - last < FAILURE_LOG_INTERVAL_MS) return;
    lastLoggedAt.set(kind, now);
    log.warn(`wakatime-cli failed: kind=${kind} exit=${exitCode ?? "none"}; see ~/.wakatime/wakatime.log`);
  }

  async function execute(job: Job): Promise<JobOutcome> {
    const file = expandHome(job.cliPath);
    if (!(await ensureUsable(file, job))) return "skipped";
    let result: ExecResult;
    try {
      result = await exec(file, job.args, { timeoutMs: job.timeoutMs });
    } catch {
      result = { exitCode: null, signal: null, spawnError: "EXEC_FAILED" };
    }
    if (result.spawnError === null && result.signal === null && result.exitCode === 0) {
      if (job.kind === "sync") state.lastSyncAt = Date.now();
      else state.lastHeartbeatAt = Date.now();
      lastLoggedAt.clear();
      return "ok";
    }
    const kind = classify(result);
    if (kind === "missing-cli") verifiedPath = null;
    recordFailure(job, kind, result.exitCode);
    return "failed";
  }

  function pump(): void {
    let index = 0;
    while (index < queue.length && running < MAX_CONCURRENT) {
      const entry = queue[index]!;
      if (inFlightKeys.has(entry.job.key)) {
        index += 1;
        continue;
      }
      queue.splice(index, 1);
      running += 1;
      inFlightKeys.add(entry.job.key);
      void execute(entry.job)
        .catch((): JobOutcome => "failed")
        .then((outcome) => {
          running -= 1;
          inFlightKeys.delete(entry.job.key);
          entry.resolve(outcome);
          pump();
        });
    }
  }

  return {
    submit(job) {
      if (disposed) return Promise.resolve("skipped");
      const waiting = queue.find((entry) => entry.job.key === job.key);
      if (waiting !== undefined) {
        // Replace in place so the key keeps its queue position.
        waiting.resolve("superseded");
        waiting.job = job;
        return new Promise((resolve) => {
          waiting.resolve = resolve;
        });
      }
      return new Promise((resolve) => {
        queue.push({ job, resolve });
        pump();
      });
    },
    async verify(cliPath) {
      await ensureUsable(expandHome(cliPath), { cliPath, kind: "heartbeat" }, true);
    },
    health: () => ({ ...state }),
    dispose() {
      disposed = true;
      for (const entry of queue.splice(0)) entry.resolve("skipped");
    },
  };
}
