import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import path from "node:path";

// INSTALL_DIR is derived from os.homedir() at import time; redirect HOME first so
// nothing here can ever reach the real ~/.bb/agent-hooks. The spawned hooks
// inherit this HOME too.
const { fakeHome, realHome } = await vi.hoisted(async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const p = await import("node:path");
  const realHome = process.env.HOME;
  const fakeHome = fs.mkdtempSync(p.join(os.tmpdir(), "probe-test-home-"));
  process.env.HOME = fakeHome;
  return { fakeHome, realHome };
});

import { PROBES, probeAll } from "./probe.mjs";
import { sync } from "./sync.mjs";
import { INSTALL_DIR } from "./wire.mjs";

type Result = { script: string; ok: boolean; detail: string; note?: string };

// Split like probe.mjs does, so this file does not trip the secret scanner.
const FAKE_KEY = "AKIA" + "IOSFODNN7EXAMPLE";

const dirs: string[] = [];
const scratch = () => {
  const d = mkdtempSync(path.join(tmpdir(), "probe-test-"));
  dirs.push(d);
  return d;
};

const DENY_JSON = `{"hookSpecificOutput":{"permissionDecision":"deny"}}`;

/** Bodies for a full set of well-behaved fake hooks. */
const GOOD: Record<string, string> = {
  "guard-bash.sh": `cat >/dev/null; echo '${DENY_JSON}'`,
  "secret-scan.sh": `cat >/dev/null; echo '{"decision":"block"}'`,
  "review-plan-before-exit.sh": `cat >/dev/null; echo '{"continue":false}'`,
  "verify-before-stop.sh": `cat >/dev/null; exit 0`,
  "session-reset.sh": `cat >/dev/null; exit 0`,
  "context-nudge.sh": `cat >/dev/null; exit 0`,
};

function install(dir: string, bodies: Record<string, string>, mode = 0o700) {
  for (const [name, body] of Object.entries(bodies)) {
    const file = path.join(dir, name);
    writeFileSync(file, `#!/usr/bin/env bash\n${body}\n`);
    chmodSync(file, mode); // writeFileSync's mode only applies on create
  }
}

const byScript = (results: Result[], name: string) => results.find((r) => r.script === name)!;

beforeEach(() => {
  if (!INSTALL_DIR.startsWith(fakeHome)) throw new Error(`INSTALL_DIR escaped the fake HOME: ${INSTALL_DIR}`);
});

afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  rmSync(fakeHome, { recursive: true, force: true });
  process.env.HOME = realHome;
});

describe("PROBES", () => {
  it("covers every wired hook exactly once, in a stable order", () => {
    expect(PROBES.map((p: { script: string }) => p.script)).toEqual([
      "guard-bash.sh",
      "secret-scan.sh",
      "review-plan-before-exit.sh",
      "verify-before-stop.sh",
      "session-reset.sh",
      "context-nudge.sh",
    ]);
  });

  it("never carries the literal AWS example key in source (assembled at runtime)", () => {
    const src = readFileSync(path.join(import.meta.dirname, "probe.mjs"), "utf8");
    expect(src).not.toContain(FAKE_KEY);
    const secret = PROBES.find((p: { script: string }) => p.script === "secret-scan.sh");
    expect(secret!.toolInput.content).toContain(FAKE_KEY);
  });
});

describe("probeAll with fake hooks", () => {
  it("reports every hook as not installed in an empty install dir", async () => {
    const results: Result[] = await probeAll({ installDir: scratch() });
    expect(results).toHaveLength(PROBES.length);
    for (const r of results) expect(r).toEqual({ script: r.script, ok: false, detail: "not installed" });
  });

  it("passes a well-behaved set, accepting each of the three deny shapes", async () => {
    const dir = scratch();
    install(dir, GOOD);
    const results: Result[] = await probeAll({ installDir: dir });
    expect(results.map((r) => [r.script, r.ok, r.detail])).toEqual([
      ["guard-bash.sh", true, "denied as expected"],
      ["secret-scan.sh", true, "denied as expected"],
      ["review-plan-before-exit.sh", true, "denied as expected"],
      ["verify-before-stop.sh", true, "ran, exit 0"],
      ["session-reset.sh", true, "clean no-op"],
      ["context-nudge.sh", true, "clean no-op"],
    ]);
    expect(byScript(results, "guard-bash.sh").note).toMatch(/never executed/);
    expect(byScript(results, "secret-scan.sh").note).toBeUndefined();
  });

  it("flags a script that lost its executable bit instead of running it", async () => {
    const dir = scratch();
    install(dir, GOOD);
    install(dir, { "guard-bash.sh": `touch '${path.join(dir, "ran")}'; echo '${DENY_JSON}'` }, 0o644);
    const results: Result[] = await probeAll({ installDir: dir });
    expect(byScript(results, "guard-bash.sh")).toEqual({
      script: "guard-bash.sh",
      ok: false,
      detail: "not executable (mode 644)",
    });
    expect(existsSync(path.join(dir, "ran"))).toBe(false);
  });

  it("fails a gate that allows its known-bad input", async () => {
    const dir = scratch();
    install(dir, { ...GOOD, "guard-bash.sh": "cat >/dev/null; exit 0", "secret-scan.sh": `echo '{"decision":"approve"}'` });
    const results: Result[] = await probeAll({ installDir: dir });
    expect(byScript(results, "guard-bash.sh")).toMatchObject({ ok: false, detail: "did NOT deny its known-bad input" });
    expect(byScript(results, "secret-scan.sh")).toMatchObject({ ok: false, detail: "did NOT deny its known-bad input" });
  });

  it("fails on unparseable output and truncates it in the detail", async () => {
    const dir = scratch();
    const noise = "x".repeat(200);
    install(dir, { ...GOOD, "review-plan-before-exit.sh": `cat >/dev/null; echo 'not json ${noise}'` });
    const r = byScript(await probeAll({ installDir: dir }), "review-plan-before-exit.sh");
    expect(r.ok).toBe(false);
    expect(r.detail.startsWith("unparseable output: not json x")).toBe(true);
    expect(r.detail.length).toBe("unparseable output: ".length + 80);
  });

  it("fails a no-op hook that prints output or exits non-zero", async () => {
    const dir = scratch();
    install(dir, { ...GOOD, "session-reset.sh": `cat >/dev/null; echo '{}'` });
    expect(byScript(await probeAll({ installDir: dir }), "session-reset.sh")).toMatchObject({
      ok: false,
      detail: "expected a silent exit 0, got code 0",
    });
    install(dir, { "session-reset.sh": "cat >/dev/null; exit 3" });
    expect(byScript(await probeAll({ installDir: dir }), "session-reset.sh")).toMatchObject({
      ok: false,
      detail: "expected a silent exit 0, got code 3",
    });
  });

  it("fails an 'any' hook that exits non-zero", async () => {
    const dir = scratch();
    install(dir, { ...GOOD, "verify-before-stop.sh": "cat >/dev/null; exit 2" });
    expect(byScript(await probeAll({ installDir: dir }), "verify-before-stop.sh")).toMatchObject({
      ok: false,
      detail: "exit 2",
    });
  });

  it("feeds a synthetic envelope on stdin with a throwaway project dir that is removed afterwards", async () => {
    const dir = scratch();
    const rec = scratch();
    const recorder = (name: string, tail: string) =>
      `cat > '${rec}/${name}.json'; printf '%s' "$CLAUDE_PROJECT_DIR" > '${rec}/${name}.dir'; ` +
      `[ -d "$CLAUDE_PROJECT_DIR/.claude/logs" ] && touch '${rec}/${name}.logs'; ${tail}`;
    install(dir, {
      "guard-bash.sh": recorder("guard", `echo '${DENY_JSON}'`),
      "secret-scan.sh": recorder("secret", `echo '${DENY_JSON}'`),
      "review-plan-before-exit.sh": recorder("plan", `echo '${DENY_JSON}'`),
      "verify-before-stop.sh": recorder("stop", "exit 0"),
      "session-reset.sh": recorder("reset", "exit 0"),
      "context-nudge.sh": recorder("nudge", "exit 0"),
    });
    const results: Result[] = await probeAll({ installDir: dir });
    expect(results.every((r) => r.ok)).toBe(true);

    const guard = JSON.parse(readFileSync(path.join(rec, "guard.json"), "utf8"));
    expect(guard).toEqual({
      session_id: "agent-hooks-probe",
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "rm -rf /etc" },
    });
    const stop = JSON.parse(readFileSync(path.join(rec, "stop.json"), "utf8"));
    expect(stop.hook_event_name).toBe("Stop");
    expect(JSON.parse(readFileSync(path.join(rec, "reset.json"), "utf8")).hook_event_name).toBe("PreToolUse");

    // PROBE_DIR in the secret-scan input is rewritten to the per-probe project dir.
    const secret = JSON.parse(readFileSync(path.join(rec, "secret.json"), "utf8"));
    const secretDir = readFileSync(path.join(rec, "secret.dir"), "utf8");
    expect(secret.tool_input.file_path).toBe(path.join(secretDir, "src", "probe.ts"));
    expect(secret.tool_input.content).toContain(FAKE_KEY);

    const projectDirs = ["guard", "secret", "plan", "stop", "reset", "nudge"].map((n) => {
      expect(existsSync(path.join(rec, `${n}.logs`))).toBe(true); // .claude/logs pre-created
      return readFileSync(path.join(rec, `${n}.dir`), "utf8");
    });
    expect(new Set(projectDirs).size).toBe(projectDirs.length); // fresh dir per probe
    for (const d of projectDirs) {
      expect(path.basename(d)).toMatch(/^agent-hooks-probe-/);
      expect(existsSync(d)).toBe(false); // cleaned up
    }
  });

  describe("when bash cannot be spawned", () => {
    const savedPath = process.env.PATH;
    afterEach(() => {
      process.env.PATH = savedPath;
    });

    it("reports 'could not spawn' rather than hanging or throwing", async () => {
      const dir = scratch();
      install(dir, GOOD);
      process.env.PATH = path.join(dir, "no-such-bin");
      const results: Result[] = await probeAll({ installDir: dir });
      process.env.PATH = savedPath;
      expect(results).toHaveLength(PROBES.length);
      for (const r of results) expect(r).toMatchObject({ ok: false, detail: "could not spawn" });
    });
  });
});

const hasJq = (() => {
  try {
    execFileSync("jq", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

describe("probeAll against the shipped hooks", () => {
  // The hooks are fail-soft without jq (they allow everything), so the gate
  // probes can only pass where jq exists.
  it.skipIf(!hasJq)("every real hook responds as its probe expects", async () => {
    const dir = path.join(scratch(), "install");
    sync({ targetDir: dir });
    const results: Result[] = await probeAll({ installDir: dir });
    expect(results.filter((r) => !r.ok)).toEqual([]);
    expect(results.map((r) => r.detail)).toEqual([
      "denied as expected",
      "denied as expected",
      "denied as expected",
      "ran, exit 0",
      "clean no-op",
      "clean no-op",
    ]);
  });

  it("defaults to the install dir under HOME", async () => {
    const results: Result[] = await probeAll();
    // Nothing has been synced into the fake HOME.
    expect(results.every((r) => r.detail === "not installed")).toBe(true);
  });
});
