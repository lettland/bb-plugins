// Corpus runner for secret-scan.sh.
//
// Secret strings are ASSEMBLED AT RUNTIME from fragments rather than stored in
// cases.jsonl. A secret scanner's test corpus necessarily contains secret-shaped
// text, so a literal fixture file trips the very gate under test -- writing this
// corpus with real-looking literals was blocked by the installed hook. Keeping
// the fragments split means no file on disk ever matches the pattern.
//
//   node tests/secret-scan.mjs

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { makeProjectDir, makeGitRepo, cleanup, incidentLogDir, HOOKS_DIR } from "./run-hook.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

// Built by concatenation so the literal never appears in source or on disk.
const SECRETS = {
  anthropic: () => "sk-" + "ant-api" + "03-" + "A".repeat(46),
  aws: () => "AKIA" + "IOSFODNN7EXAMPLE",
  ghp: () => "ghp_" + "A".repeat(36),
  jwt: () => "eyJ" + "hbGci" + "A".repeat(60),
};

const FIXTURES = {
  "env-ignored": () => makeGitRepo({ ignored: [".env"] }),
  "env-not-ignored": () => makeGitRepo({}),
  "non-repo": () => makeProjectDir(),
};

function render(tpl, secretKind) {
  if (typeof tpl !== "string") return undefined;
  let out = tpl;
  if (out.includes("{{SECRET}}")) {
    const make = SECRETS[secretKind];
    if (!make) throw new Error(`case needs a known secret kind, got: ${secretKind}`);
    out = out.replaceAll("{{SECRET}}", make());
  }
  // Exercises the mktemp indirection: large enough that `echo "$CONTENT"` would
  // truncate on macOS, which would silently shorten what gets scanned.
  out = out.replaceAll("{{FILLER}}", "// filler\n".repeat(30000));
  return out;
}

function runSecretScan(toolInput, toolName, projectDir) {
  const envelope = JSON.stringify({
    session_id: "test-session",
    hook_event_name: "PreToolUse",
    tool_name: toolName,
    tool_input: toolInput,
  });
  return new Promise((resolve) => {
    const child = spawn("bash", [path.join(HOOKS_DIR, "secret-scan.sh")], {
      env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir, AGENT_HOOKS_LOG_DIR: incidentLogDir(projectDir) },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.on("close", () => {
      const text = stdout.trim();
      if (text === "") return resolve({ verdict: "allow", reason: null });
      try {
        const out = JSON.parse(text).hookSpecificOutput ?? {};
        if (out.permissionDecision === "deny") {
          return resolve({ verdict: "block", reason: out.permissionDecisionReason });
        }
        return resolve({ verdict: "allow", reason: null });
      } catch {
        return resolve({ verdict: "malformed", reason: text.slice(0, 200) });
      }
    });
    child.stdin.end(envelope);
  });
}

const cases = readFileSync(path.join(HERE, "secret-scan", "cases.jsonl"), "utf8")
  .split("\n")
  .map((l) => l.trim())
  .filter(Boolean)
  .map((l) => JSON.parse(l));

let failures = 0;
for (const c of cases) {
  const dir = FIXTURES[c.fixture]();
  try {
    const content = render(c.template, c.secret);
    const toolInput = { file_path: path.join(dir, c.file) };
    if (c.tool === "Edit") {
      toolInput.old_string = render(c.oldTemplate, c.secret);
      toolInput.new_string = content;
    } else {
      toolInput.content = content;
    }
    const r = await runSecretScan(toolInput, c.tool, dir);
    const ok = r.verdict === c.expect;
    if (!ok) {
      failures += 1;
      console.log(`  FAIL ${c.id.padEnd(32)} want ${c.expect}, got ${r.verdict}`);
      console.log(`       ${c.why}`);
    }
  } finally {
    cleanup(dir);
  }
}

console.log(`\n=== secret-scan corpus ===`);
console.log(`total ${cases.length}   pass ${cases.length - failures}   FAIL ${failures}`);
if (failures > 0) process.exit(1);
console.log("OK");
