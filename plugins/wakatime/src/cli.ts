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

export class CliRunner implements Runner {
  private readonly exec: Exec;
  private readonly log: PluginLogger;
  private readonly queue: Entry[] = [];
  private readonly inFlightKeys = new Set<string>();
  private readonly lastLoggedAt = new Map<ErrorKind, number>();
  private readonly warnedPaths = new Set<string>();
  private readonly state: RunnerHealth = { lastHeartbeatAt: null, lastSyncAt: null, lastError: null };
  // The last path that passed the check; cleared by a spawn error so it is re-checked.
  private verifiedPath: string | null = null;
  // The last path reported as usable, to log a change once.
  private reportedPath: string | null = null;
  private running = 0;
  private disposed = false;

  constructor(options: { exec?: Exec; log: PluginLogger }) {
    this.exec = options.exec ?? defaultExec;
    this.log = options.log;
  }

  private async ensureUsable(
    file: string,
    job: Pick<Job, "cliPath" | "kind">,
    recheck = false,
  ): Promise<boolean> {
    if (!recheck && this.verifiedPath === file) return true;
    const problem = await checkCli(file);
    if (problem === null) {
      this.verifiedPath = file;
      this.warnedPaths.delete(file);
      // Only a path-check error: one from a real spawn failure (no `problem`)
      // stays until a job succeeds.
      if (this.state.lastError?.kind === "missing-cli" && this.state.lastError.problem !== undefined) {
        this.state.lastError = null;
      }
      if (this.reportedPath !== null && this.reportedPath !== file) {
        this.log.info(`wakatime-cli path changed to ${job.cliPath.trim()}`);
      }
      this.reportedPath = file;
      return true;
    }
    this.verifiedPath = null;
    // The same problem again keeps its job and time, so reading the status does not move them.
    const last = this.state.lastError;
    if (last?.kind !== "missing-cli" || last.problem !== problem) {
      this.state.lastError = { kind: "missing-cli", job: job.kind, exitCode: null, at: Date.now(), problem };
    }
    if (!this.warnedPaths.has(file)) {
      this.warnedPaths.add(file);
      this.log.warn(
        `wakatime-cli is not usable at ${job.cliPath.trim()} (${problem}); heartbeats are skipped until it is`,
      );
    }
    return false;
  }

  private recordFailure(job: Job, kind: ErrorKind, exitCode: number | null): void {
    const now = Date.now();
    this.state.lastError = { kind, job: job.kind, exitCode, at: now };
    const last = this.lastLoggedAt.get(kind);
    if (last !== undefined && now - last < FAILURE_LOG_INTERVAL_MS) return;
    this.lastLoggedAt.set(kind, now);
    this.log.warn(`wakatime-cli failed: kind=${kind} exit=${exitCode ?? "none"}; see ~/.wakatime/wakatime.log`);
  }

  private async execute(job: Job): Promise<JobOutcome> {
    const file = expandHome(job.cliPath);
    if (!(await this.ensureUsable(file, job))) return "skipped";
    let result: ExecResult;
    try {
      result = await this.exec(file, job.args, { timeoutMs: job.timeoutMs });
    } catch {
      result = { exitCode: null, signal: null, spawnError: "EXEC_FAILED" };
    }
    if (result.spawnError === null && result.signal === null && result.exitCode === 0) {
      if (job.kind === "sync") this.state.lastSyncAt = Date.now();
      else this.state.lastHeartbeatAt = Date.now();
      this.lastLoggedAt.clear();
      return "ok";
    }
    const kind = classify(result);
    if (kind === "missing-cli") this.verifiedPath = null;
    this.recordFailure(job, kind, result.exitCode);
    return "failed";
  }

  private pump(): void {
    let index = 0;
    while (index < this.queue.length && this.running < MAX_CONCURRENT) {
      const entry = this.queue[index]!;
      if (this.inFlightKeys.has(entry.job.key)) {
        index += 1;
        continue;
      }
      this.queue.splice(index, 1);
      this.running += 1;
      this.inFlightKeys.add(entry.job.key);
      void this.execute(entry.job)
        .catch((): JobOutcome => "failed")
        .then((outcome) => {
          this.running -= 1;
          this.inFlightKeys.delete(entry.job.key);
          entry.resolve(outcome);
          this.pump();
        });
    }
  }

  submit(job: Job): Promise<JobOutcome> {
    if (this.disposed) return Promise.resolve("skipped");
    const waiting = this.queue.find((entry) => entry.job.key === job.key);
    if (waiting !== undefined) {
      // Replace in place so the key keeps its queue position.
      waiting.resolve("superseded");
      waiting.job = job;
      return new Promise((resolve) => {
        waiting.resolve = resolve;
      });
    }
    return new Promise((resolve) => {
      this.queue.push({ job, resolve });
      this.pump();
    });
  }

  async verify(cliPath: string): Promise<void> {
    await this.ensureUsable(expandHome(cliPath), { cliPath, kind: "heartbeat" }, true);
  }

  health(): RunnerHealth {
    return { ...this.state };
  }

  dispose(): void {
    this.disposed = true;
    for (const entry of this.queue.splice(0)) entry.resolve("skipped");
  }
}

export function createRunner(options: { exec?: Exec; log: PluginLogger }): Runner {
  return new CliRunner(options);
}
