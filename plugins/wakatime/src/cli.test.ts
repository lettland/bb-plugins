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

const OK: ExecResult = { exitCode: 0, signal: null, spawnError: null, stderr: "" };
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
  return { key, cliPath: cli, args: [`--time=${key}`], timeoutMs: HEARTBEAT_TIMEOUT_MS, ...overrides };
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
      { exitCode: 0, signal: null, spawnError: null, stderr: "" },
      { exitCode: 104, signal: null, spawnError: null, stderr: "bad" },
      { exitCode: null, signal: null, spawnError: "ENOENT", stderr: "" },
      { exitCode: null, signal: "SIGKILL", spawnError: null, stderr: "" },
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
  it("maps spawn errors, kills, exit codes and stderr to a kind", () => {
    const base = OK;
    expect(classify({ ...base, exitCode: null, spawnError: "ENOENT" })).toBe("missing-cli");
    expect(classify({ ...base, exitCode: null, spawnError: "EACCES" })).toBe("missing-cli");
    expect(classify({ ...base, exitCode: null, spawnError: "EPIPE" })).toBe("other");
    expect(classify({ ...base, exitCode: null, signal: "SIGKILL" })).toBe("timeout");
    expect(classify({ ...base, exitCode: 104 })).toBe("auth");
    expect(classify({ ...base, exitCode: 1, stderr: "Invalid API Key" })).toBe("auth");
    expect(classify({ ...base, exitCode: 1, stderr: "dial tcp: lookup api.wakatime.com: no such host" })).toBe("network");
    expect(classify({ ...base, exitCode: 1, stderr: "something odd" })).toBe("other");
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
    expect(runner.health().lastSuccessAt).not.toBeNull();
    expect(runner.health().cliPath).toBe(cli);
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
      expect(runner.health().lastError?.kind).toBe("missing-cli");
      writeFileSync(missing, "#!/bin/sh\n");
      chmodSync(missing, 0o755);
      expect(await runner.submit(job("a", { cliPath: missing }))).toBe("ok");
      expect(exec).toHaveBeenCalledTimes(1);
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
        expect(runner.health().cliPath).toBe(path.join(home, "cli"));
      } finally {
        spy.mockRestore();
        rmSync(home, { recursive: true, force: true });
      }
    });
  });

  describe("failure logs", () => {
    const leaky = (extra: Partial<ExecResult>): ExecResult => ({
      exitCode: 1,
      signal: null,
      spawnError: null,
      stderr: `key ${SECRET} id ${BARE_UUID} title "Fix the login bug" project "acme-app" failed`,
      ...extra,
    });

    it("logs only the exit code and kind, one case per kind", async () => {
      const cases: [ExecResult, string][] = [
        [leaky({ exitCode: null, spawnError: "ENOENT" }), "missing-cli"],
        [leaky({ exitCode: null, signal: "SIGKILL" }), "timeout"],
        [leaky({ exitCode: 104 }), "auth"],
        [leaky({ stderr: `dial tcp: no such host ${SECRET} ${BARE_UUID} Fix the login bug acme-app` }), "network"],
        [leaky({}), "other"],
      ];
      for (const [result, kind] of cases) {
        const log = fakeLog();
        const runner = createRunner({ exec: async () => result, log });
        // Pass the title and project in the argv the way a real heartbeat does.
        await runner.submit(job("a", { args: ["--entity=Fix the login bug", "--project=acme-app", `--plugin=${SECRET}`] }));
        expect(log.warn).toHaveBeenCalledTimes(1);
        const line = String(log.warn.mock.calls[0]![0]);
        expect(line).toBe(`wakatime-cli failed: kind=${kind} exit=${result.exitCode ?? "none"}`);
        for (const secret of [SECRET, BARE_UUID, "Fix the login bug", "acme-app", "--entity"]) {
          expect(line).not.toContain(secret);
        }
        expect(JSON.stringify(runner.health())).not.toContain(SECRET);
        expect(runner.health().lastError?.kind).toBe(kind);
      }
    });

    it("rate-limits an identical error and logs the first failure after a success", async () => {
      vi.useFakeTimers();
      const results: ExecResult[] = [leaky({}), leaky({}), leaky({})];
      const exec = vi.fn<Exec>(async () => results.shift()!);
      const log = fakeLog();
      const runner = createRunner({ exec, log });
      await runner.submit(job("a"));
      await runner.submit(job("a"));
      expect(log.warn).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(FAILURE_LOG_INTERVAL_MS + 1);
      await runner.submit(job("a"));
      expect(log.warn).toHaveBeenCalledTimes(2);

      exec.mockResolvedValueOnce(OK).mockResolvedValueOnce(leaky({}));
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
      expect(String(log.warn.mock.calls[0]![0])).toBe("wakatime-cli failed: kind=other exit=none");
    });
  });
});
