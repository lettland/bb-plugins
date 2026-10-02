// Corpus harness for the PreToolUse hook scripts.
//
// The trap this exists to avoid: guard-bash.sh exits 0 immediately when
// CLAUDE_PROJECT_DIR is unset, BEFORE any of its logic runs. A runner that forgets
// to export it gets "allow" for every case and a green board that proves nothing.
// runHook always sets it, and assertEnvGuard() below fails loudly if that ever
// regresses.

import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const HOOKS_DIR = path.join(HERE, "..", "hooks");

/** Verdict vocabulary. `soft` and `hard` are both PreToolUse denies; they differ
 *  only by the prefix inside permissionDecisionReason, which is asserted
 *  explicitly so a future message reword cannot silently reclassify a case. */
export const ALLOW = "allow";
export const SOFT = "soft";
export const HARD = "hard";

export function makeProjectDir() {
  const dir = mkdtempSync(path.join(tmpdir(), "agent-hooks-"));
  mkdirSync(path.join(dir, ".claude", "logs"), { recursive: true });
  return dir;
}

export function cleanup(dir) {
  rmSync(dir, { recursive: true, force: true });
}

/** A throwaway git repo. `ignored` lists .gitignore entries; `tracked` are files
 *  committed into the tree. Used by the F5/secret-scan gitignore-gate cases. */
export function makeGitRepo({ ignored = [], tracked = [] } = {}) {
  const dir = makeProjectDir();
  const git = (...args) =>
    execFileSync("git", ["-C", dir, ...args], { stdio: "pipe" });
  git("init", "-q");
  git("config", "user.email", "test@example.invalid");
  git("config", "user.name", "test");
  if (ignored.length > 0) {
    writeFileSync(path.join(dir, ".gitignore"), ignored.join("\n") + "\n");
    git("add", ".gitignore");
  }
  for (const rel of tracked) {
    const abs = path.join(dir, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, "placeholder\n");
    git("add", "--", rel);
  }
  git("commit", "-q", "-m", "init", "--allow-empty");
  return dir;
}

/**
 * Run a hook script with a real event envelope on stdin.
 * Returns { exitCode, stdout, verdict, reason }.
 * @param {string} script
 * @param {unknown} toolInput
 * @param {{ projectDir?: string, env?: Record<string, string>, toolName?: string, permissionMode?: string }} [options]
 */
export function runHook(
  script,
  toolInput,
  { projectDir, env = {}, toolName = "Bash", permissionMode } = {},
) {
  const dir = projectDir ?? makeProjectDir();
  const owned = projectDir === undefined;
  const envelope = JSON.stringify({
    session_id: "test-session",
    transcript_path: path.join(dir, "transcript.jsonl"),
    hook_event_name: "PreToolUse",
    tool_name: toolName,
    tool_input: toolInput,
    ...(permissionMode === undefined ? {} : { permission_mode: permissionMode }),
  });

  return new Promise((resolve) => {
    const child = spawn("bash", [path.join(HOOKS_DIR, script)], {
      env: {
        ...process.env,
        // The whole point. Never the real checkout: guard-bash appends a LOW
        // incident-log entry for every allowed rm/mv.
        CLAUDE_PROJECT_DIR: dir,
        ...env,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (exitCode) => {
      if (owned) cleanup(dir);
      resolve({ exitCode, stdout, stderr, ...classify(stdout) });
    });
    child.stdin.end(envelope);
  });
}

/** Map raw hook stdout to a verdict. Asserts on the HARD/SOFT prefix explicitly. */
export function classify(stdout) {
  const text = stdout.trim();
  if (text === "") return { verdict: ALLOW, reason: null };
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { verdict: "malformed", reason: text.slice(0, 200) };
  }
  const out = parsed.hookSpecificOutput ?? {};
  if (out.permissionDecision !== "deny") return { verdict: ALLOW, reason: null };
  const reason = String(out.permissionDecisionReason ?? "");
  if (reason.startsWith("HARD BLOCK")) return { verdict: HARD, reason };
  if (reason.startsWith("SOFT BLOCK")) return { verdict: SOFT, reason };
  return { verdict: "deny-unclassified", reason };
}

/** Guards the harness itself: proves the hook really does no-op without
 *  CLAUDE_PROJECT_DIR, so a green board can never come from an unset variable. */
export function runWithoutProjectDir(script, toolInput) {
  const envelope = JSON.stringify({ tool_name: "Bash", tool_input: toolInput });
  return new Promise((resolve) => {
    const env = { ...process.env };
    delete env.CLAUDE_PROJECT_DIR;
    const child = spawn("bash", [path.join(HOOKS_DIR, script)], { env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.on("close", (exitCode) => resolve({ exitCode, stdout, ...classify(stdout) }));
    child.stdin.end(envelope);
  });
}
