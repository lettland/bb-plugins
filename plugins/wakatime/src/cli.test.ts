import { execFile } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  classify,
  createRunner,
  defaultExec,
  expandHome,
  FAILURE_LOG_INTERVAL_MS,
  HEARTBEAT_TIMEOUT_MS,
  MAX_CONCURRENT,
} from "./cli.js";
import type { Exec, ExecResult, Job } from "./cli.js";

const OK: ExecResult = { exitCode: 0, signal: null, spawnError: null };
// Built at run time so secret scanners do not flag the fixture.
const SECRET = ["waka", "0f8a1c52-9d3e-4b7a-8c61-5e2d7a9b4c13"].join("_");
const BARE_UUID = "7c9e6679-7425-40de-944b-e07fc1f90ae7";

function fakeLog() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

let dir: string;
let cli: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "waka-cli-"));
  cli = path.join(dir, "wakatime-cli");
  writeFileSync(cli, "#!/bin/sh\n");
  chmodSync(cli, 0o755);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.useRealTimers();
});

function job(key: string, overrides: Partial<Job> = {}): Job {
  return { key, kind: "heartbeat", cliPath: cli, args: [`--time=${key}`], timeoutMs: HEARTBEAT_TIMEOUT_MS, ...overrides };
}

/** An exec whose calls stay pending until the test settles them. */
function deferredExec() {
  const calls: { args: string[]; settle: (result: ExecResult) => void }[] = [];
  const exec: Exec = (_file, args) =>
    new Promise((resolve) => {
      calls.push({ args, settle: resolve });
    });
  return { exec, calls };
}

// Real timers: the path check goes through the real filesystem.
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 25));

describe("defaultExec", () => {
  it("guard: the real execFile is blocked under vitest", async () => {
    await expect(defaultExec("/bin/true", [], { timeoutMs: 1 })).rejects.toThrow("real execFile called under vitest");
  });

  it("maps a clean exit, an exit code, a spawn error and a kill", async () => {
    const run = vi.mocked(execFile) as unknown as ReturnType<typeof vi.fn>;
    run.mockClear();
    const callbacks: ((error: unknown, stdout: string, stderr: string) => void)[] = [];
    run.mockImplementation((_f: string, _a: string[], _o: unknown, cb: (e: unknown, o: string, s: string) => void) => {
      callbacks.push(cb);
    });
    const results = [1, 2, 3, 4].map(() => defaultExec("/x", ["--a=b"], { timeoutMs: 5 }));
    callbacks[0]!(null, "", "");
    callbacks[1]!(Object.assign(new Error("x"), { code: 104 }), "", "bad");
    callbacks[2]!(Object.assign(new Error("x"), { code: "ENOENT" }), "", "");
    callbacks[3]!(Object.assign(new Error("x"), { killed: true, signal: "SIGKILL" }), "", undefined as unknown as string);
    expect(await Promise.all(results)).toEqual([
      { exitCode: 0, signal: null, spawnError: null },
      { exitCode: 104, signal: null, spawnError: null },
      { exitCode: null, signal: null, spawnError: "ENOENT" },
      { exitCode: null, signal: "SIGKILL", spawnError: null },
    ]);
    const options = run.mock.calls[0]![2] as { timeout: number; killSignal: string };
    expect(options.timeout).toBe(5);
    expect(options.killSignal).toBe("SIGKILL");
    run.mockImplementation(() => {
      throw new Error("real execFile called under vitest");
    });
  });
});

describe("expandHome", () => {
  it("expands ~ and ~/ and leaves other paths alone", () => {
    expect(expandHome("~")).toBe(os.homedir());
    expect(expandHome("~/bin/x")).toBe(path.join(os.homedir(), "bin/x"));
    expect(expandHome(" /abs/x ")).toBe("/abs/x");
    expect(expandHome("~other/x")).toBe("~other/x");
  });
});

describe("classify", () => {
  it("maps spawn errors, kills and exit codes to a kind", () => {
    const base = OK;
    expect(classify({ ...base, exitCode: null, spawnError: "ENOENT" })).toBe("missing-cli");
    expect(classify({ ...base, exitCode: null, spawnError: "EACCES" })).toBe("missing-cli");
    expect(classify({ ...base, exitCode: null, spawnError: "EPIPE" })).toBe("other");
    expect(classify({ ...base, exitCode: null, signal: "SIGKILL" })).toBe("timeout");
    expect(classify({ ...base, exitCode: 104 })).toBe("auth");
    expect(classify({ ...base, exitCode: 102 })).toBe("network");
    expect(classify({ ...base, exitCode: 112 })).toBe("network");
    expect(classify({ ...base, exitCode: 103 })).toBe("config");
    expect(classify({ ...base, exitCode: 1 })).toBe("other");
  });
});

describe("runner", () => {
  it("runs a job and records the success", async () => {
    const { exec, calls } = deferredExec();
    const runner = createRunner({ exec, log: fakeLog() });
    const done = runner.submit(job("a"));
    await flush();
    expect(calls).toHaveLength(1);
    calls[0]!.settle(OK);
    expect(await done).toBe("ok");
    expect(runner.health().lastHeartbeatAt).not.toBeNull();
    expect(runner.health().lastSyncAt).toBeNull();
  });

  it("tracks sync and heartbeat successes separately", async () => {
    const runner = createRunner({ exec: vi.fn<Exec>().mockResolvedValue(OK), log: fakeLog() });
    await runner.submit(job("sync", { kind: "sync" }));
    expect(runner.health()).toMatchObject({ lastHeartbeatAt: null });
    expect(runner.health().lastSyncAt).not.toBeNull();
  });

  it("on dispose resolves queued jobs as skipped, refuses new ones and lets in-flight ones finish", async () => {
    const { exec, calls } = deferredExec();
    const runner = createRunner({ exec, log: fakeLog() });
    for (let i = 0; i < MAX_CONCURRENT; i++) void runner.submit(job(`busy${i}`));
    await flush();
    const queued = runner.submit(job("queued"));
    const running = runner.submit(job("busy0", { args: ["replacement"] }));
    runner.dispose();
    expect(await queued).toBe("skipped");
    expect(await running).toBe("skipped");
    expect(await runner.submit(job("late"))).toBe("skipped");
    calls[0]!.settle(OK);
    await flush();
    expect(calls).toHaveLength(MAX_CONCURRENT);
    expect(runner.health().lastHeartbeatAt).not.toBeNull();
  });

  it("passes the job's timeout to exec", async () => {
    const exec = vi.fn<Exec>().mockResolvedValue(OK);
    const runner = createRunner({ exec, log: fakeLog() });
    await runner.submit(job("a", { timeoutMs: 600_000 }));
    expect(exec).toHaveBeenCalledWith(cli, ["--time=a"], { timeoutMs: 600_000 });
  });

  it("allows one process per key and replaces a waiting job in place", async () => {
    const { exec, calls } = deferredExec();
    const runner = createRunner({ exec, log: fakeLog() });
    const first = runner.submit(job("a", { args: ["first"] }));
    await flush();
    const second = runner.submit(job("a", { args: ["second"] }));
    const third = runner.submit(job("a", { args: ["third"] }));
    await flush();
    expect(calls).toHaveLength(1);
    expect(await second).toBe("superseded");
    calls[0]!.settle(OK);
    await first;
    await flush();
    expect(calls).toHaveLength(2);
    expect(calls[1]!.args).toEqual(["third"]);
    calls[1]!.settle(OK);
    expect(await third).toBe("ok");
  });

  it("keeps the queue position when a waiting job is replaced", async () => {
    const { exec, calls } = deferredExec();
    const runner = createRunner({ exec, log: fakeLog() });
    for (let i = 0; i < MAX_CONCURRENT; i++) void runner.submit(job(`busy${i}`));
    await flush();
    void runner.submit(job("x", { args: ["x1"] }));
    void runner.submit(job("y", { args: ["y1"] }));
    void runner.submit(job("x", { args: ["x2"] }));
    calls[0]!.settle(OK);
    await flush();
    expect(calls[MAX_CONCURRENT]!.args).toEqual(["x2"]);
    calls[1]!.settle(OK);
    await flush();
    expect(calls[MAX_CONCURRENT + 1]!.args).toEqual(["y1"]);
  });

  it("caps concurrency at 4 and runs the rest first-in first-out", async () => {
    const { exec, calls } = deferredExec();
    const runner = createRunner({ exec, log: fakeLog() });
    for (let i = 0; i < 6; i++) void runner.submit(job(`k${i}`));
    await flush();
    expect(calls).toHaveLength(4);
    calls[2]!.settle(OK);
    await flush();
    // The first four start together; only their order among themselves is open.
    expect(calls.slice(0, 4).map((call) => call.args[0]).sort()).toEqual([
      "--time=k0", "--time=k1", "--time=k2", "--time=k3",
    ]);
    expect(calls[4]!.args[0]).toBe("--time=k4");
    calls[0]!.settle(OK);
    await flush();
    expect(calls[5]!.args[0]).toBe("--time=k5");
  });

  describe("cli path", () => {
    it("skips a missing cli with one warning per path, then recovers", async () => {
      const exec = vi.fn<Exec>().mockResolvedValue(OK);
      const log = fakeLog();
      const runner = createRunner({ exec, log });
      const missing = path.join(dir, "nope");
      expect(await runner.submit(job("a", { cliPath: missing }))).toBe("skipped");
      expect(await runner.submit(job("a", { cliPath: missing }))).toBe("skipped");
      expect(exec).not.toHaveBeenCalled();
      expect(log.warn).toHaveBeenCalledTimes(1);
      expect(runner.health().lastError).toMatchObject({ kind: "missing-cli", job: "heartbeat", problem: "not-found" });
      writeFileSync(missing, "#!/bin/sh\n");
      chmodSync(missing, 0o755);
      expect(await runner.submit(job("a", { cliPath: missing }))).toBe("ok");
      expect(exec).toHaveBeenCalledTimes(1);
      // A passing path check clears the missing-cli error.
      expect(runner.health().lastError).toBeNull();
    });

    it("verify re-checks the current path: it clears a missing-cli error once fixed and records one when broken", async () => {
      const exec = vi.fn<Exec>().mockResolvedValue(OK);
      const runner = createRunner({ exec, log: fakeLog() });
      const fixed = path.join(dir, "fixed-cli");
      await runner.verify(path.join(dir, "gone"));
      expect(runner.health().lastError).toMatchObject({ kind: "missing-cli", problem: "not-found" });
      writeFileSync(fixed, "#!/bin/sh\n");
      chmodSync(fixed, 0o755);
      await runner.verify(fixed);
      expect(runner.health().lastError).toBeNull();
      // A cached good path is checked again, so a deleted binary shows up at once.
      rmSync(fixed);
      await runner.verify(fixed);
      expect(runner.health().lastError).toMatchObject({ kind: "missing-cli", problem: "not-found" });
      expect(exec).not.toHaveBeenCalled();
    });

    it("verify keeps a missing-cli error from a real spawn failure on a passing path", async () => {
      const exec = vi.fn<Exec>().mockResolvedValue({ exitCode: null, signal: null, spawnError: "ENOENT" });
      const runner = createRunner({ exec, log: fakeLog() });
      // A wrapper script whose interpreter is missing: the path check passes, the spawn fails.
      await runner.submit(job("a"));
      expect(runner.health().lastError).toMatchObject({ kind: "missing-cli" });
      expect(runner.health().lastError?.problem).toBeUndefined();
      await runner.verify(cli);
      expect(runner.health().lastError).toMatchObject({ kind: "missing-cli", exitCode: null });
    });

    it("keeps the job and time of an identical path problem across verifies and jobs", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(1_000);
      const runner = createRunner({ exec: vi.fn<Exec>().mockResolvedValue(OK), log: fakeLog() });
      const missing = path.join(dir, "nope");
      await runner.submit(job("sync", { kind: "sync", cliPath: missing }));
      const first = runner.health().lastError;
      expect(first).toMatchObject({ job: "sync", at: 1_000, problem: "not-found" });
      vi.setSystemTime(9_000);
      await runner.verify(missing);
      await runner.submit(job("a", { cliPath: missing }));
      expect(runner.health().lastError).toEqual(first);
      // A different problem is a new error.
      await runner.verify(dir);
      expect(runner.health().lastError).toMatchObject({ job: "heartbeat", at: 9_000, problem: "not-a-file" });
    });

    it("verify keeps a non-path error", async () => {
      const runner = createRunner({ exec: vi.fn<Exec>().mockResolvedValue({ exitCode: 104, signal: null, spawnError: null }), log: fakeLog() });
      await runner.submit(job("a"));
      await runner.verify(cli);
      expect(runner.health().lastError?.kind).toBe("auth");
    });

    it("keeps a later failure when the path check passes", async () => {
      const exec = vi.fn<Exec>().mockResolvedValue({ exitCode: 104, signal: null, spawnError: null });
      const runner = createRunner({ exec, log: fakeLog() });
      await runner.submit(job("a"));
      await runner.submit(job("a"));
      expect(runner.health().lastError?.kind).toBe("auth");
    });

    it("records the problem for each way a path is rejected", async () => {
      const runner = createRunner({ exec: vi.fn<Exec>().mockResolvedValue(OK), log: fakeLog() });
      const plain = path.join(dir, "plain");
      writeFileSync(plain, "x");
      chmodSync(plain, 0o644);
      const expected: [string, string][] = [
        ["wakatime-cli", "not-absolute"],
        [dir, "not-a-file"],
        [plain, "not-executable"],
        [path.join(dir, "nope"), "not-found"],
      ];
      for (const [bad, problem] of expected) {
        await runner.submit(job("a", { cliPath: bad }));
        expect(runner.health().lastError?.problem).toBe(problem);
      }
    });

    it("logs the path as typed, never the expanded one", async () => {
      const home = mkdtempSync(path.join(os.tmpdir(), "waka-home-"));
      const spy = vi.spyOn(os, "homedir").mockReturnValue(home);
      const log = fakeLog();
      try {
        const runner = createRunner({ exec: vi.fn<Exec>().mockResolvedValue(OK), log });
        await runner.submit(job("a", { cliPath: "~/missing-cli" }));
        expect(String(log.warn.mock.calls[0]![0])).toContain("~/missing-cli");
        writeFileSync(path.join(home, "missing-cli"), "#!/bin/sh\n");
        chmodSync(path.join(home, "missing-cli"), 0o755);
        await runner.submit(job("a", { cliPath: "~/missing-cli" }));
        writeFileSync(path.join(home, "other-cli"), "#!/bin/sh\n");
        chmodSync(path.join(home, "other-cli"), 0o755);
        await runner.submit(job("a", { cliPath: "~/other-cli" }));
        const lines = [...log.warn.mock.calls, ...log.info.mock.calls].map((call) => String(call[0]));
        expect(lines.join("\n")).not.toContain(home);
        expect(log.info).toHaveBeenCalledTimes(1);
        expect(log.info).toHaveBeenCalledWith("wakatime-cli path changed to ~/other-cli");
      } finally {
        spy.mockRestore();
        rmSync(home, { recursive: true, force: true });
      }
    });

    it("does not log a path change for the first path", async () => {
      const log = fakeLog();
      const runner = createRunner({ exec: vi.fn<Exec>().mockResolvedValue(OK), log });
      await runner.submit(job("a"));
      expect(log.info).not.toHaveBeenCalled();
    });

    it("uses a changed cliPath on the next job", async () => {
      const exec = vi.fn<Exec>().mockResolvedValue(OK);
      const runner = createRunner({ exec, log: fakeLog() });
      const other = path.join(dir, "other-cli");
      writeFileSync(other, "#!/bin/sh\n");
      chmodSync(other, 0o755);
      await runner.submit(job("a"));
      await runner.submit(job("a", { cliPath: other }));
      expect(exec.mock.calls.map((call) => call[0])).toEqual([cli, other]);
    });

    it("re-checks the path after an ENOENT spawn error", async () => {
      const exec = vi
        .fn<Exec>()
        .mockResolvedValueOnce({ ...OK, exitCode: null, spawnError: "ENOENT" })
        .mockResolvedValue(OK);
      const log = fakeLog();
      const runner = createRunner({ exec, log });
      expect(await runner.submit(job("a"))).toBe("failed");
      rmSync(cli);
      expect(await runner.submit(job("a"))).toBe("skipped");
      writeFileSync(cli, "#!/bin/sh\n");
      chmodSync(cli, 0o755);
      expect(await runner.submit(job("a"))).toBe("ok");
    });

    it("rejects a relative path, a directory and a non-executable file without spawning", async () => {
      const exec = vi.fn<Exec>().mockResolvedValue(OK);
      const runner = createRunner({ exec, log: fakeLog() });
      const plain = path.join(dir, "plain");
      writeFileSync(plain, "x");
      chmodSync(plain, 0o644);
      for (const bad of ["wakatime-cli", "./wakatime-cli", dir, plain]) {
        expect(await runner.submit(job("a", { cliPath: bad }))).toBe("skipped");
      }
      expect(exec).not.toHaveBeenCalled();
    });

    it("expands ~ before the check", async () => {
      const exec = vi.fn<Exec>().mockResolvedValue(OK);
      const runner = createRunner({ exec, log: fakeLog() });
      const home = mkdtempSync(path.join(os.tmpdir(), "waka-home-"));
      const spy = vi.spyOn(os, "homedir").mockReturnValue(home);
      writeFileSync(path.join(home, "cli"), "#!/bin/sh\n");
      chmodSync(path.join(home, "cli"), 0o755);
      try {
        expect(await runner.submit(job("a", { cliPath: "~/cli" }))).toBe("ok");
        expect(exec.mock.calls[0]![0]).toBe(path.join(home, "cli"));
      } finally {
        spy.mockRestore();
        rmSync(home, { recursive: true, force: true });
      }
    });
  });

  describe("failure logs", () => {
    const failing = (extra: Partial<ExecResult>): ExecResult => ({
      exitCode: 1,
      signal: null,
      spawnError: null,
      ...extra,
    });

    it("logs only the exit code and kind, one case per kind", async () => {
      const cases: [ExecResult, string][] = [
        [failing({ exitCode: null, spawnError: "ENOENT" }), "missing-cli"],
        [failing({ exitCode: null, signal: "SIGKILL" }), "timeout"],
        [failing({ exitCode: 104 }), "auth"],
        [failing({ exitCode: 112 }), "network"],
        [failing({ exitCode: 102 }), "network"],
        [failing({ exitCode: 103 }), "config"],
        [failing({}), "other"],
      ];
      for (const [result, kind] of cases) {
        const log = fakeLog();
        const runner = createRunner({ exec: async () => result, log });
        // The title, project and key travel in argv the way a real heartbeat's do.
        await runner.submit(job("a", { args: ["--entity=Fix the login bug", "--project=acme-app", `--plugin=${SECRET}`] }));
        expect(log.warn).toHaveBeenCalledTimes(1);
        const line = String(log.warn.mock.calls[0]![0]);
        expect(line).toBe(
          `wakatime-cli failed: kind=${kind} exit=${result.exitCode ?? "none"}; see ~/.wakatime/wakatime.log`,
        );
        for (const secret of [SECRET, "Fix the login bug", "acme-app", "--entity", cli]) {
          expect(line).not.toContain(secret);
        }
        expect(JSON.stringify(runner.health())).not.toContain(SECRET);
        expect(runner.health().lastError).toMatchObject({ kind, job: "heartbeat" });
      }
    });

    it("rate-limits an identical error and logs the first failure after a success", async () => {
      vi.useFakeTimers();
      const results: ExecResult[] = [failing({}), failing({}), failing({})];
      const exec = vi.fn<Exec>(async () => results.shift()!);
      const log = fakeLog();
      const runner = createRunner({ exec, log });
      await runner.submit(job("a"));
      await runner.submit(job("a"));
      expect(log.warn).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(FAILURE_LOG_INTERVAL_MS + 1);
      await runner.submit(job("a"));
      expect(log.warn).toHaveBeenCalledTimes(2);

      exec.mockResolvedValueOnce(OK).mockResolvedValueOnce(failing({}));
      await runner.submit(job("a"));
      await runner.submit(job("a"));
      expect(log.warn).toHaveBeenCalledTimes(3);
    });

    it("frees its slot even if the logger throws", async () => {
      const log = fakeLog();
      log.warn.mockImplementation(() => {
        throw new Error("logger down");
      });
      const runner = createRunner({ exec: async () => ({ ...OK, exitCode: 1 }), log });
      expect(await runner.submit(job("a"))).toBe("failed");
      log.warn.mockImplementation(() => undefined);
      expect(await runner.submit(job("a"))).toBe("failed");
    });

    it("treats a throwing exec as an other failure", async () => {
      const log = fakeLog();
      const runner = createRunner({
        exec: async () => {
          throw new Error(`boom ${SECRET}`);
        },
        log,
      });
      expect(await runner.submit(job("a"))).toBe("failed");
      expect(String(log.warn.mock.calls[0]![0])).toBe(
        "wakatime-cli failed: kind=other exit=none; see ~/.wakatime/wakatime.log",
      );
    });
  });
});
