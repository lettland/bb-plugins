// Liveness probe for installed hooks.
//
// SAFETY CONTRACT, and the reason this file exists rather than a one-liner:
// the probe MUST spawn the hook script directly with a synthetic JSON envelope
// on stdin and a throwaway CLAUDE_PROJECT_DIR. It must NEVER hand a dangerous
// command to a real shell and rely on the hook to intercept it -- guard-bash is
// a PreToolUse hook, so any residual bug in it would mean the command actually
// runs. The probe is invoked before every uninstall step and after every
// install, so an unsafe implementation would be a repeated risk, not a one-off.
//
// Nothing here ever executes the probe command. It is a string on stdin.

import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { INSTALL_DIR } from "./wire.mjs";

/** One probe per hook. `expect: "deny"` means the hook must refuse the input;
 *  session-reset has no deny path at all, so it is checked for a clean no-op. */
export const PROBES = [
  {
    script: "guard-bash.sh",
    expect: "deny",
    toolName: "Bash",
    toolInput: { command: "rm -rf /etc" },
    note: "never executed -- passed as text on stdin",
  },
  {
    script: "secret-scan.sh",
    expect: "deny",
    toolName: "Write",
    toolInput: {
      file_path: "PROBE_DIR/src/probe.ts",
      content: 'const k = "' + "AKIA" + "IOSFODNN7EXAMPLE" + '";\n',
    },
  },
  {
    script: "review-plan-before-exit.sh",
    expect: "deny",
    toolName: "ExitPlanMode",
    toolInput: { plan: "probe plan" },
  },
  {
    script: "verify-before-stop.sh",
    expect: "any",
    toolName: "Stop",
    toolInput: {},
    note: "no synthetic transcript, so it correctly allows; presence + exit 0 is the check",
  },
  {
    script: "session-reset.sh",
    expect: "noop",
    toolName: "SessionStart",
    toolInput: {},
    note: "cleanup hook: exits 0 with no output by design",
  },
];

function runOne(scriptPath, probe, projectDir) {
  const toolInput = JSON.parse(
    JSON.stringify(probe.toolInput).replaceAll("PROBE_DIR", projectDir),
  );
  const envelope = JSON.stringify({
    session_id: "agent-hooks-probe",
    hook_event_name: probe.toolName === "Stop" ? "Stop" : "PreToolUse",
    tool_name: probe.toolName,
    tool_input: toolInput,
  });
  return new Promise((resolve) => {
    const child = spawn("bash", [scriptPath], {
      // review-plan-before-exit.sh stands down instead of denying when
      // BB_THREAD_ID names a thread auto-review's plan gate serves. Cleared
      // here so a probe run from inside a real (gated) bb thread still
      // exercises this hook's own deny, not auto-review's handoff.
      env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir, BB_THREAD_ID: "" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.on("error", () => resolve({ ok: false, detail: "could not spawn" }));
    child.on("close", (code) => {
      const text = stdout.trim();
      let denied = false;
      if (text !== "") {
        try {
          const parsed = JSON.parse(text);
          denied =
            parsed.hookSpecificOutput?.permissionDecision === "deny" ||
            parsed.decision === "block" ||
            parsed.continue === false;
        } catch {
          return resolve({ ok: false, detail: `unparseable output: ${text.slice(0, 80)}` });
        }
      }
      if (probe.expect === "deny") {
        return resolve(
          denied ? { ok: true, detail: "denied as expected" } : { ok: false, detail: "did NOT deny its known-bad input" },
        );
      }
      if (probe.expect === "noop") {
        return resolve(
          code === 0 && text === ""
            ? { ok: true, detail: "clean no-op" }
            : { ok: false, detail: `expected a silent exit 0, got code ${code}` },
        );
      }
      return resolve(code === 0 ? { ok: true, detail: "ran, exit 0" } : { ok: false, detail: `exit ${code}` });
    });
    child.stdin.end(envelope);
  });
}

export async function probeAll({ installDir = INSTALL_DIR } = {}) {
  const results = [];
  for (const probe of PROBES) {
    const scriptPath = path.join(installDir, probe.script);
    if (!existsSync(scriptPath)) {
      results.push({ script: probe.script, ok: false, detail: "not installed" });
      continue;
    }
    // A lost executable bit would make a hook silently never run while every
    // presence check still reported it installed.
    const mode = statSync(scriptPath).mode & 0o777;
    if ((mode & 0o100) === 0) {
      results.push({ script: probe.script, ok: false, detail: `not executable (mode ${mode.toString(8)})` });
      continue;
    }
    const dir = mkdtempSync(path.join(tmpdir(), "agent-hooks-probe-"));
    mkdirSync(path.join(dir, ".claude", "logs"), { recursive: true });
    try {
      const r = await runOne(scriptPath, probe, dir);
      results.push({ script: probe.script, ...r, note: probe.note });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  return results;
}
