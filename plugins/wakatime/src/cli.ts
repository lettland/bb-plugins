import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { PluginLogger } from "@get-bb/plugin-sdk";
import type { ErrorKind } from "./rpc-contract.js";

/** Above the CLI's own 120 s API timeout, leaving room for its offline-queue sync. */
export const HEARTBEAT_TIMEOUT_MS = 150_000;
export const SYNC_TIMEOUT_MS = 10 * 60_000;
export const MAX_CONCURRENT = 4;
export const FAILURE_LOG_INTERVAL_MS = 10 * 60_000;

export interface ExecResult {
  exitCode: number | null;
  /** Set when the process was killed, which here means the timeout fired. */
  signal: string | null;
  /** A spawn failure code such as ENOENT; null when the process ran. */
  spawnError: string | null;
  stderr: string;
}

export type Exec = (file: string, args: string[], options: { timeoutMs: number }) => Promise<ExecResult>;

/** No shell: every argument reaches the process as one argv entry. */
export const defaultExec: Exec = (file, args, { timeoutMs }) =>
  new Promise((resolve) => {
    execFile(
      file,
      args,
      { timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: 1024 * 1024, windowsHide: true },
      (error, _stdout, stderr) => {
        if (!error) {
          resolve({ exitCode: 0, signal: null, spawnError: null, stderr: String(stderr) });
          return;
        }
        const code = error.code;
        resolve({
          exitCode: typeof code === "number" ? code : null,
          signal: error.signal ?? null,
          spawnError: typeof code === "string" ? code : null,
          stderr: String(stderr ?? ""),
        });
      },
    );
  });

export interface Job {
  /** At most one job per key runs at a time; a newer queued job replaces an older one. */
  key: string;
  cliPath: string;
  args: string[];
  timeoutMs: number;
}

export type JobOutcome = "ok" | "failed" | "skipped" | "superseded";

export interface RunnerHealth {
  cliPath: string | null;
  lastSuccessAt: number | null;
  lastError: { kind: ErrorKind; exitCode: number | null; at: number } | null;
}

export interface Runner {
  submit(job: Job): Promise<JobOutcome>;
  health(): RunnerHealth;
}

export function expandHome(raw: string): string {
  const value = raw.trim();
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  return value;
}

type PathProblem = "not-absolute" | "not-found" | "not-a-file" | "not-executable";

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

// Plain substring checks on lowercased stderr: no regex, so nothing to backtrack.
const AUTH_MARKERS = ["api key", "unauthorized", "401"];
const NETWORK_MARKERS = [
  "dial tcp",
  "no such host",
  "connection refused",
  "connection reset",
  "i/o timeout",
  "deadline exceeded",
  "tls",
  "network",
  "unreachable",
];
const STDERR_SCAN_LIMIT = 64 * 1024;
const EXIT_AUTH = 104;

export function classify(result: ExecResult): ErrorKind {
  if (result.spawnError === "ENOENT" || result.spawnError === "EACCES") return "missing-cli";
  if (result.spawnError !== null) return "other";
  if (result.signal !== null) return "timeout";
  if (result.exitCode === EXIT_AUTH) return "auth";
  const text = result.stderr.slice(0, STDERR_SCAN_LIMIT).toLowerCase();
  if (AUTH_MARKERS.some((marker) => text.includes(marker))) return "auth";
  if (NETWORK_MARKERS.some((marker) => text.includes(marker))) return "network";
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
  const state: RunnerHealth = { cliPath: null, lastSuccessAt: null, lastError: null };
  // The last path that passed the check; cleared by a spawn error so it is re-checked.
  let verifiedPath: string | null = null;
  let running = 0;

  async function ensureUsable(file: string): Promise<boolean> {
    if (verifiedPath === file) return true;
    const problem = await checkCli(file);
    if (problem === null) {
      verifiedPath = file;
      warnedPaths.delete(file);
      return true;
    }
    verifiedPath = null;
    state.lastError = { kind: "missing-cli", exitCode: null, at: Date.now() };
    if (!warnedPaths.has(file)) {
      warnedPaths.add(file);
      log.warn(`wakatime-cli is not usable at ${file} (${problem}); heartbeats are skipped until it is`);
    }
    return false;
  }

  function recordFailure(kind: ErrorKind, exitCode: number | null): void {
    const now = Date.now();
    state.lastError = { kind, exitCode, at: now };
    const last = lastLoggedAt.get(kind);
    if (last !== undefined && now - last < FAILURE_LOG_INTERVAL_MS) return;
    lastLoggedAt.set(kind, now);
    log.warn(`wakatime-cli failed: kind=${kind} exit=${exitCode ?? "none"}`);
  }

  async function execute(job: Job): Promise<JobOutcome> {
    const file = expandHome(job.cliPath);
    state.cliPath = file;
    if (!(await ensureUsable(file))) return "skipped";
    let result: ExecResult;
    try {
      result = await exec(file, job.args, { timeoutMs: job.timeoutMs });
    } catch {
      result = { exitCode: null, signal: null, spawnError: "EXEC_FAILED", stderr: "" };
    }
    if (result.spawnError === null && result.signal === null && result.exitCode === 0) {
      state.lastSuccessAt = Date.now();
      lastLoggedAt.clear();
      return "ok";
    }
    const kind = classify(result);
    if (kind === "missing-cli") verifiedPath = null;
    recordFailure(kind, result.exitCode);
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
    health: () => ({ ...state }),
  };
}
