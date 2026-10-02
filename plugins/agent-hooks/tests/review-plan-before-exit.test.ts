// Ownership-handoff tests for review-plan-before-exit.sh: in a bb `claude-code`
// thread auto-review owns the first plan review (its own gate), so this hook
// must stand down there instead of also reviewing. Everywhere else (auto-review
// absent, disabled, or serving a different thread) it must behave exactly as
// before. A fake `bb` executable (via BB_CLI) stands in for the real CLI.

import { afterEach, describe, expect, it } from "vitest";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { cleanup, makeProjectDir, runHook } from "./run-hook.mjs";

const PLAN = "do the thing";
const GATE_REL = path.join(".claude", "logs", ".plan-review-gate-test-session");
const LOG_REL = path.join(".claude", "logs", "incident-log.md");

let scratch: string[] = [];

afterEach(() => {
  for (const dir of scratch) cleanup(dir);
  scratch = [];
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  scratch.push(dir);
  return dir;
}

function project(): string {
  const dir = makeProjectDir();
  scratch.push(dir);
  return dir;
}

/** A fake `bb` executable. Touches `marker` before running `body`, so a test
 *  can prove it was (or was not) invoked at all. */
function fakeBb(marker: string, body: string): string {
  const dir = tempDir("agent-hooks-fakebb-");
  const bin = path.join(dir, "bb");
  writeFileSync(bin, `#!/usr/bin/env bash\ntouch "${marker}"\n${body}\n`);
  chmodSync(bin, 0o755);
  return bin;
}

function markerPath(): string {
  return path.join(tempDir("agent-hooks-marker-"), "invoked");
}

function gatePath(projectDir: string): string {
  return path.join(projectDir, GATE_REL);
}

function incidentLog(projectDir: string): string {
  return readFileSync(path.join(projectDir, LOG_REL), "utf8");
}

function isDeny(stdout: string): boolean {
  const parsed = JSON.parse(stdout);
  return parsed?.hookSpecificOutput?.permissionDecision === "deny";
}

describe("review-plan-before-exit.sh — auto-review handoff", () => {
  it("stands down when auto-review's planGate serves this thread", async () => {
    const marker = markerPath();
    const bb = fakeBb(marker, "echo '{\"planGate\": true}'");
    const projectDir = project();

    const result = await runHook(
      "review-plan-before-exit.sh",
      { plan: PLAN },
      { projectDir, toolName: "ExitPlanMode", env: { BB_CLI: bb, BB_THREAD_ID: "thr_1" } },
    );

    expect(result.verdict).toBe("allow");
    expect(existsSync(marker)).toBe(true);
    expect(existsSync(gatePath(projectDir))).toBe(false);
    expect(incidentLog(projectDir)).toContain(
      "PLAN-REVIEW | SKIP | auto-review gates this thread (thr_1)",
    );
  });

  it("denies and arms when auto-review's planGate does not serve this thread", async () => {
    const marker = markerPath();
    const bb = fakeBb(marker, "echo '{\"planGate\": false}'");
    const projectDir = project();

    const result = await runHook(
      "review-plan-before-exit.sh",
      { plan: PLAN },
      { projectDir, toolName: "ExitPlanMode", env: { BB_CLI: bb, BB_THREAD_ID: "thr_1" } },
    );

    expect(existsSync(marker)).toBe(true);
    expect(isDeny(result.stdout)).toBe(true);
    expect(existsSync(gatePath(projectDir))).toBe(true);
  });

  it("falls back to deny+arm when bb exits non-zero", async () => {
    const marker = markerPath();
    const bb = fakeBb(marker, "echo '{\"planGate\": true}'; exit 1");
    const projectDir = project();

    const result = await runHook(
      "review-plan-before-exit.sh",
      { plan: PLAN },
      { projectDir, toolName: "ExitPlanMode", env: { BB_CLI: bb, BB_THREAD_ID: "thr_1" } },
    );

    expect(isDeny(result.stdout)).toBe(true);
    expect(existsSync(gatePath(projectDir))).toBe(true);
  });

  it("falls back to deny+arm when bb prints garbage instead of JSON", async () => {
    const marker = markerPath();
    const bb = fakeBb(marker, "echo 'not json at all'");
    const projectDir = project();

    const result = await runHook(
      "review-plan-before-exit.sh",
      { plan: PLAN },
      { projectDir, toolName: "ExitPlanMode", env: { BB_CLI: bb, BB_THREAD_ID: "thr_1" } },
    );

    expect(isDeny(result.stdout)).toBe(true);
    expect(existsSync(gatePath(projectDir))).toBe(true);
  });

  it("denies and arms without invoking bb when BB_THREAD_ID is unset", async () => {
    const marker = markerPath();
    const bb = fakeBb(marker, "echo '{\"planGate\": true}'");
    const projectDir = project();

    const result = await runHook(
      "review-plan-before-exit.sh",
      { plan: PLAN },
      // Force-clear BB_THREAD_ID: this hook itself may be running inside bb,
      // so the host's own env could otherwise leak a real thread id in.
      { projectDir, toolName: "ExitPlanMode", env: { BB_CLI: bb, BB_THREAD_ID: "" } },
    );

    expect(isDeny(result.stdout)).toBe(true);
    expect(existsSync(gatePath(projectDir))).toBe(true);
    expect(existsSync(marker)).toBe(false);
  });

  it("consumes an already-armed gate and allows without invoking bb", async () => {
    const marker = markerPath();
    const bb = fakeBb(marker, "echo '{\"planGate\": false}'");
    const projectDir = project();
    const gate = gatePath(projectDir);
    writeFileSync(gate, "");

    const result = await runHook(
      "review-plan-before-exit.sh",
      { plan: PLAN },
      { projectDir, toolName: "ExitPlanMode", env: { BB_CLI: bb, BB_THREAD_ID: "thr_1" } },
    );

    expect(result.verdict).toBe("allow");
    expect(existsSync(gate)).toBe(false);
    expect(existsSync(marker)).toBe(false);
  });

  it("still skips a commit-plan without consulting auto-review", async () => {
    const marker = markerPath();
    const bb = fakeBb(marker, "echo '{\"planGate\": false}'");
    const projectDir = project();
    const plan = "Some plan\n<!-- agent-hooks:commit-plan -->\nmore text\n";

    const result = await runHook(
      "review-plan-before-exit.sh",
      { plan },
      { projectDir, toolName: "ExitPlanMode", env: { BB_CLI: bb, BB_THREAD_ID: "thr_1" } },
    );

    expect(result.verdict).toBe("allow");
    expect(existsSync(gatePath(projectDir))).toBe(false);
    expect(existsSync(marker)).toBe(false);
  });
});
