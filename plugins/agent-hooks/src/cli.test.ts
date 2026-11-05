import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import path from "node:path";

// PROVIDERS and INSTALL_DIR are derived from os.homedir() at import time, so HOME
// must point at a throwaway directory before cli.mjs loads. Every provider config
// and the install dir then live under it -- the real ~/.claude, ~/.claude-work,
// ~/.codex and ~/.bb are never touched.
const { fakeHome, realHome } = await vi.hoisted(async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const p = await import("node:path");
  const realHome = process.env.HOME;
  const fakeHome = fs.mkdtempSync(p.join(os.tmpdir(), "cli-test-home-"));
  process.env.HOME = fakeHome;
  return { fakeHome, realHome };
});

// Real implementations by default; wrapped only so single tests can force the
// integrity check or the probe to fail.
vi.mock("./sync.mjs", async (importOriginal) => {
  const real = await importOriginal<Record<string, (...a: unknown[]) => unknown>>();
  return { ...real, verifyChecksums: vi.fn(real.verifyChecksums) };
});
vi.mock("./probe.mjs", async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>();
  return { ...real, probeAll: vi.fn(real.probeAll as (...a: unknown[]) => unknown) };
});
// Never spawn a real `codex app-server` from tests: it would read the real
// ~/.codex. Skipped by default; single tests script a trust result.
vi.mock("./codex-trust.mjs", () => ({
  syncCodexTrust: vi.fn(async () => ({ status: "skipped", reason: "stubbed in tests" })),
}));

import { runAgentHooksCli } from "./cli.mjs";
import { syncCodexTrust } from "./codex-trust.mjs";
import { verifyChecksums, hookScripts } from "./sync.mjs";
import { probeAll } from "./probe.mjs";
import { INSTALL_DIR, PROVIDERS, WIRING, countOurs, expectedCount } from "./wire.mjs";

const WIRING_SCRIPTS = () => WIRING.map((w) => w.script);

type Cli = { exitCode: number; stdout: string; stderr?: string };
const run = (...argv: string[]): Promise<Cli> => runAgentHooksCli(argv);

const cfg = {
  claude: path.join(fakeHome, ".claude", "settings.json"),
  work: path.join(fakeHome, ".claude-work", "settings.json"),
  codex: path.join(fakeHome, ".codex", "hooks.json"),
};
const readJson = (f: string) => JSON.parse(readFileSync(f, "utf8"));
const put = (f: string, text: string) => {
  mkdirSync(path.dirname(f), { recursive: true });
  writeFileSync(f, text);
};
const backupsOf = (f: string) =>
  readdirSync(path.dirname(f)).filter((n) => n.startsWith(`${path.basename(f)}.agent-hooks-backup-`));

const hasJq = (() => {
  try {
    execFileSync("jq", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

beforeEach(() => {
  if (!INSTALL_DIR.startsWith(fakeHome) || !Object.values(PROVIDERS).every((p: any) => p.config.startsWith(fakeHome))) {
    throw new Error("provider paths escaped the fake HOME");
  }
  // A clean fake HOME per test.
  rmSync(fakeHome, { recursive: true, force: true });
  mkdirSync(fakeHome, { recursive: true });
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(() => {
  rmSync(fakeHome, { recursive: true, force: true });
  process.env.HOME = realHome;
});

describe("codex trust", () => {
  const trust = vi.mocked(syncCodexTrust);

  it("re-keys after writing hooks.json and reports what Codex now trusts", async () => {
    trust.mockResolvedValueOnce({
      status: "ok",
      bin: "codex",
      changed: true,
      backup: "/x/config.toml.agent-hooks-backup-1",
      ours: expectedCount(),
      oursTrusted: expectedCount(),
      untrusted: ["hooks.json:stop:9:0"],
    });
    const r = await run("install", "--provider", "codex");
    expect(r.exitCode).toBe(0);
    expect(trust).toHaveBeenLastCalledWith(expect.objectContaining({ sourcePath: cfg.codex, readOnly: false }));
    const arg = trust.mock.lastCall?.[0] as unknown as { ourCommands: Set<string> };
    expect(arg.ourCommands.size).toBe(new Set(WIRING_SCRIPTS()).size);
    expect(r.stdout).toContain(
      `    codex trust: ${expectedCount()}/${expectedCount()} agent-hooks trusted  (re-keyed; backup: config.toml.agent-hooks-backup-1)`,
    );
    expect(r.stdout).toContain("    left untrusted (never trusted before): hooks.json:stop:9:0");
  });

  it("fails install when Codex still does not trust our hooks, or the rewrite is refused", async () => {
    trust.mockResolvedValueOnce({ status: "ok", bin: "codex", changed: true, backup: "/x/b", untrusted: [], ours: 6, oursTrusted: 5 });
    expect((await run("install", "--provider", "codex")).exitCode).toBe(1);
    trust.mockResolvedValueOnce({ status: "refused", reason: "unexpected hook state" });
    const r = await run("install", "--provider", "codex");
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain("codex trust: REFUSED -- unexpected hook state; config.toml left untouched");
  });

  it("treats a missing Codex as skipped, not failed", async () => {
    const r = await run("install", "--provider", "codex");
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("    codex trust: skipped -- stubbed in tests");
  });

  it("dry run never touches trust", async () => {
    trust.mockClear();
    const r = await run("install", "--provider", "codex", "--dry-run");
    expect(r.stdout).toContain("would re-key hook trust in ~/.codex/config.toml");
    expect(trust).not.toHaveBeenCalled();
  });

  it("status reads trust without writing and flags untrusted gates", async () => {
    await run("install", "--provider", "codex");
    trust.mockResolvedValueOnce({ status: "ok", bin: "codex", ours: 6, oursTrusted: 0 });
    const r = await run("status", "--provider", "codex");
    expect(trust).toHaveBeenLastCalledWith(expect.objectContaining({ readOnly: true }));
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain("    codex trust: 0/6 agent-hooks trusted");
  });

  it("uninstall re-keys the neighbours that shifted", async () => {
    await run("install", "--provider", "codex");
    trust.mockClear();
    await run("uninstall", "--provider", "codex");
    expect(trust).toHaveBeenCalledWith(expect.objectContaining({ sourcePath: cfg.codex, readOnly: false }));
  });
});

describe("PROVIDERS isolation", () => {
  it("points every provider config into the fake HOME", () => {
    expect(PROVIDERS["claude-code"].config).toBe(cfg.claude);
    expect(PROVIDERS["claude-work"].config).toBe(cfg.work);
    expect(PROVIDERS.codex.config).toBe(cfg.codex);
  });
});

describe("install", () => {
  it("syncs the scripts and wires every provider, creating missing configs", async () => {
    const r = await run("install");
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain(`synced ${hookScripts().length} script(s) -> ${INSTALL_DIR}`);
    expect(r.stdout).not.toContain("overwrote modified");
    expect(r.stdout).toContain(`claude-code  0 -> ${expectedCount()} agent-hooks entries`);
    expect(r.stdout).not.toContain("backup:"); // nothing existed to back up
    for (const f of Object.values(cfg)) expect(countOurs(readJson(f))).toBe(expectedCount());
    const codexCmds = JSON.stringify(readJson(cfg.codex));
    expect(codexCmds).toContain("codex-shim.sh");
    expect(JSON.stringify(readJson(cfg.claude))).not.toContain("codex-shim.sh");
    for (const s of hookScripts()) expect(existsSync(path.join(INSTALL_DIR, s))).toBe(true);
  });

  it("backs up an existing config and preserves its neighbours", async () => {
    const neighbour = { hooks: [{ type: "command", command: "/x/.config/iterm2/cc-status" }] };
    put(cfg.claude, JSON.stringify({ theme: "dark", hooks: { PreToolUse: [neighbour] } }));
    const r = await run("install", "--provider", "claude-code");
    expect(r.exitCode).toBe(0);
    const [backup] = backupsOf(cfg.claude);
    expect(backup).toBeDefined();
    expect(r.stdout).toContain(`(backup: ${backup})`);
    expect(readJson(path.join(path.dirname(cfg.claude), backup))).toEqual({
      theme: "dark",
      hooks: { PreToolUse: [neighbour] },
    });
    const after = readJson(cfg.claude);
    expect(after.theme).toBe("dark");
    expect(after.hooks.PreToolUse[0]).toEqual(neighbour);
    // --provider narrows the write to one config.
    expect(existsSync(cfg.work)).toBe(false);
    expect(existsSync(cfg.codex)).toBe(false);
  });

  it("is idempotent and quiet about scripts already current", async () => {
    await run("install");
    const r = await run("install");
    expect(r.exitCode).toBe(0);
    expect(r.stdout).not.toContain("synced");
    expect(r.stdout).toContain(`${expectedCount()} -> ${expectedCount()} agent-hooks entries`);
    for (const f of Object.values(cfg)) expect(countOurs(readJson(f))).toBe(expectedCount());
  });

  it("names a hand-edited install copy it overwrites", async () => {
    await run("install");
    writeFileSync(path.join(INSTALL_DIR, "guard-bash.sh"), "# debugging\n");
    const r = await run("install");
    expect(r.stdout).toContain("synced 1 script(s)");
    expect(r.stdout).toContain("  overwrote modified: guard-bash.sh");
  });

  it("--dry-run reports the plan and writes nothing", async () => {
    const r = await run("install", "--dry-run");
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain(`  claude-code  ${cfg.claude}`);
    expect(r.stdout).toContain(`    would write: 0 -> ${expectedCount()} agent-hooks entries`);
    expect(r.stdout).toContain("dry run: nothing was written.");
    expect(existsSync(INSTALL_DIR)).toBe(false);
    for (const f of Object.values(cfg)) expect(existsSync(f)).toBe(false);
  });

  it("refuses to install anything when the hook integrity check fails", async () => {
    vi.mocked(verifyChecksums).mockImplementationOnce(() => {
      throw new Error("Hook integrity check failed:\n  guard-bash.sh: digest mismatch");
    });
    const r = await run("install");
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toMatch(/^refusing to install: Hook integrity check failed/);
    expect(existsSync(INSTALL_DIR)).toBe(false);
    for (const f of Object.values(cfg)) expect(existsSync(f)).toBe(false);
  });

  it("skips a malformed config, still wires the rest, and exits non-zero", async () => {
    put(cfg.work, "{ broken");
    const r = await run("install");
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toMatch(/claude-work: .*settings\.json is not valid JSON/);
    expect(readFileSync(cfg.work, "utf8")).toBe("{ broken");
    expect(backupsOf(cfg.work)).toEqual([]);
    expect(countOurs(readJson(cfg.claude))).toBe(expectedCount());
    expect(countOurs(readJson(cfg.codex))).toBe(expectedCount());
  });

  it("rejects an unknown provider without touching anything", async () => {
    const r = await run("install", "--provider", "cursor");
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toBe("error: unknown provider 'cursor'. Known: claude-code, claude-work, codex");
    expect(existsSync(INSTALL_DIR)).toBe(false);
  });

  it("treats a --provider with no value (or a flag after it) as all providers", async () => {
    const r = await run("install", "--provider", "--dry-run");
    expect(r.exitCode).toBe(0);
    for (const id of ["claude-code", "claude-work", "codex"]) expect(r.stdout).toContain(`  ${id}  `);
    expect(r.stdout).toContain("dry run");
  });
});

describe("status", () => {
  it("reports everything missing before install and exits non-zero", async () => {
    const r = await run("status");
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain(`  claude-code  0/${expectedCount()}  not installed`);
    for (const s of hookScripts()) expect(r.stdout).toContain(`  DRIFT ${s} (missing)`);
    expect(r.stdout).toContain("run with --probe");
    expect(probeAll).not.toHaveBeenCalled();
  });

  it("is the default subcommand", async () => {
    const r = await runAgentHooksCli([]);
    expect(r.stdout.startsWith("providers:")).toBe(true);
  });

  it("is clean after install", async () => {
    await run("install");
    const r = await run("status");
    expect(r.exitCode).toBe(0);
    for (const id of ["claude-code", "claude-work", "codex"]) {
      expect(r.stdout).toContain(`  ${id.padEnd(12)} ${expectedCount()}/${expectedCount()}  ok`);
    }
    expect(r.stdout).toContain(`install dir: ${INSTALL_DIR}\n  scripts current`);
  });

  it("flags a partial install, script drift and a malformed config", async () => {
    await run("install");
    const claude = readJson(cfg.claude);
    delete claude.hooks.SessionStart;
    put(cfg.claude, JSON.stringify(claude));
    put(cfg.codex, "nope");
    writeFileSync(path.join(INSTALL_DIR, "secret-scan.sh"), "# edited\n");

    const r = await run("status");
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain(`  claude-code  ${expectedCount() - 1}/${expectedCount()}  partial`);
    expect(r.stdout).toContain(`  claude-work  ${expectedCount()}/${expectedCount()}  ok`);
    expect(r.stdout).toMatch(/ {2}codex {8}ERROR {2}.*hooks\.json is not valid JSON/);
    expect(r.stdout).toContain("  DRIFT secret-scan.sh (differs) — run 'bb agent-hooks install'");
  });

  it("--provider narrows the report to one config", async () => {
    const r = await run("status", "--provider", "codex");
    expect(r.stdout).toContain("  codex ");
    expect(r.stdout).not.toContain("claude-code");
  });

  it("--probe fails and names the hooks that do not respond", async () => {
    await run("install");
    vi.mocked(probeAll).mockResolvedValueOnce([
      { script: "guard-bash.sh", ok: true, detail: "denied as expected" },
      { script: "secret-scan.sh", ok: false, detail: "did NOT deny its known-bad input" },
      { script: "session-reset.sh", ok: false, detail: "exit 1" },
    ]);
    const r = await run("status", "--probe");
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain("probe (synthetic stdin; no command is ever executed):");
    expect(r.stdout).toContain(`  ok   ${"guard-bash.sh".padEnd(28)} denied as expected`);
    expect(r.stdout).toContain(`  FAIL ${"secret-scan.sh".padEnd(28)} did NOT deny its known-bad input`);
    expect(r.stdout).toContain("  1/2 gate hooks responding, session-reset FAILING");
    expect(r.stdout).not.toContain("run with --probe");
  });

  it("--probe reports FAILING when session-reset is absent from the results", async () => {
    await run("install");
    vi.mocked(probeAll).mockResolvedValueOnce([{ script: "guard-bash.sh", ok: true, detail: "denied as expected" }]);
    const r = await run("status", "--probe");
    expect(r.stdout).toContain("1/1 gate hooks responding, session-reset FAILING");
  });

  it.skipIf(!hasJq)("--probe passes end to end against the installed real hooks", async () => {
    await run("install");
    const r = await run("status", "--probe");
    expect(r.stdout).toContain("4/4 gate hooks responding, session-reset clean");
    expect(r.stdout).not.toContain("FAIL");
    expect(r.exitCode).toBe(0);
  });
});

describe("uninstall", () => {
  it("removes only our entries, backs up, and leaves the scripts in place", async () => {
    const neighbour = { hooks: [{ type: "command", command: "/x/.config/iterm2/cc-status" }] };
    put(cfg.claude, JSON.stringify({ hooks: { Stop: [neighbour] } }));
    await run("install");
    const r = await run("uninstall");
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain(`claude-code  ${expectedCount()} -> 0 agent-hooks entries`);
    expect(r.stdout).toContain(`Scripts left in place at ${INSTALL_DIR}`);
    expect(readJson(cfg.claude)).toEqual({ hooks: { Stop: [neighbour] } });
    for (const f of Object.values(cfg)) expect(countOurs(readJson(f))).toBe(0);
    expect(backupsOf(cfg.claude).length).toBeGreaterThanOrEqual(2); // one from install, one from uninstall
    expect(existsSync(path.join(INSTALL_DIR, "guard-bash.sh"))).toBe(true);
  });

  it("skips a malformed config without failing the others", async () => {
    await run("install");
    put(cfg.codex, "{");
    const r = await run("uninstall");
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/codex: .*hooks\.json is not valid JSON/);
    expect(readFileSync(cfg.codex, "utf8")).toBe("{");
    expect(countOurs(readJson(cfg.claude))).toBe(0);
  });

  it("on a machine that never installed, writes empty configs without backups", async () => {
    const r = await run("uninstall", "--provider", "claude-work");
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("claude-work  0 -> 0 agent-hooks entries");
    expect(r.stdout).not.toContain("backup:");
    expect(readJson(cfg.work)).toEqual({ hooks: {} });
    expect(existsSync(cfg.claude)).toBe(false);
  });
});

describe("log", () => {
  let project: string;
  beforeEach(() => {
    project = mkdtempSync(path.join(tmpdir(), "cli-test-project-"));
    vi.spyOn(process, "cwd").mockReturnValue(project);
    vi.stubEnv("AGENT_HOOKS_LOG_DIR", ""); // empty means unset: default dir under the fake HOME
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(project, { recursive: true, force: true });
  });

  // The log lives outside the project: <log dir>/<project dir, "/" -> "-">.md
  const defaultLogDir = () => path.join(fakeHome, ".bb", "logs", "agent-hooks");
  const keyOf = (dir: string) => `${dir.replaceAll("/", "-")}.md`;
  const writeLog = (lines: string[], logDir = defaultLogDir()) => {
    const f = path.join(logDir, keyOf(project));
    put(f, lines.join("\n") + "\n\n");
    return f;
  };

  it("explains where logs live when the project has none", async () => {
    const r = await run("log");
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe(
      `no incident log for the current project — hooks write to ${defaultLogDir()}/<project dir with / replaced by ->.md`,
    );
  });

  it("does not read an incident-log.md left inside the project by an older version", async () => {
    put(path.join(project, ".claude", "logs", "incident-log.md"), "old entry\n");
    const r = await run("log");
    expect(r.stdout).toMatch(/^no incident log for the current project/);
  });

  it("reads the log from AGENT_HOOKS_LOG_DIR when it is set", async () => {
    const custom = path.join(fakeHome, "custom-logs");
    vi.stubEnv("AGENT_HOOKS_LOG_DIR", custom);
    const f = writeLog(["from custom dir"], custom);
    writeLog(["from default dir"]);
    const r = await run("log");
    expect(r.stdout.split("\n")).toEqual([`${f}  (last 1 of 1)`, "  from custom dir"]);
  });

  it("names the overridden directory when the project has no log there", async () => {
    const custom = path.join(fakeHome, "custom-logs");
    vi.stubEnv("AGENT_HOOKS_LOG_DIR", custom);
    const r = await run("log");
    expect(r.stdout).toBe(
      `no incident log for the current project — hooks write to ${custom}/<project dir with / replaced by ->.md`,
    );
  });

  it("prints the last 20 entries by default, skipping blank lines", async () => {
    const lines = Array.from({ length: 25 }, (_, i) => `entry ${i + 1}`);
    const f = writeLog(lines);
    const r = await run("log");
    const out = r.stdout.split("\n");
    expect(out[0]).toBe(`${f}  (last 20 of 25)`);
    expect(out.slice(1)).toEqual(lines.slice(-20).map((l) => `  ${l}`));
  });

  it("honours --limit", async () => {
    writeLog(["a", "", "b", "c"]);
    const r = await run("log", "--limit", "2");
    expect(r.stdout.split("\n")).toEqual([expect.stringContaining("(last 2 of 3)"), "  b", "  c"]);
  });
});

describe("dispatch", () => {
  it("rejects an unknown subcommand", async () => {
    const r = await run("frobnicate");
    expect(r).toEqual({ exitCode: 1, stdout: "unknown subcommand 'frobnicate'. Try: install | status | uninstall | log" });
  });

  it("returns partial output plus stderr when a subcommand throws", async () => {
    // An install dir blocked by a regular file makes the copy step throw after
    // the integrity check has already printed nothing and passed.
    put(path.join(fakeHome, ".bb"), "not a directory");
    const r = await run("install");
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch(/^error: .*(ENOTDIR|EEXIST)/);
    expect(r.stdout).toBe("");
  });
});
