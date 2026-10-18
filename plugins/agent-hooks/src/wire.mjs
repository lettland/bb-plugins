// Merging hook entries into provider config files.
//
// Three differently-shaped targets, one shared set of safety rules:
//   ~/.claude/settings.json       hooks.* already holds the iterm2 cc-status entry
//                                 on ten events
//   ~/.claude-work/settings.json  has hooks.Stop with an EMPTY hooks array and no
//                                 PreToolUse key at all -- the merge must create
//                                 keys, never assume them
//   ~/.codex/hooks.json           carries auto-review-commit.sh,
//                                 deny-bgisolation-none.sh and zclean, all of
//                                 which must survive. Codex also keeps positional
//                                 trust for this file in config.toml; see
//                                 codex-trust.mjs
//
// Our entries are identified by their command-path prefix (~/.bb/agent-hooks/).
// Verified safe: all three configs store each hook as a single command string, and
// no existing neighbour uses that prefix.

import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync, copyFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";

export const INSTALL_DIR = path.join(os.homedir(), ".bb", "agent-hooks");

/**
 * Which hook runs on which event.
 *
 * Codex uses the SAME CamelCase event names and matcher shape as Claude Code in
 * hooks.json -- verified against the live file, where gitkraken and
 * deny-bgisolation-none.sh both sit under `PreToolUse` with a `matcher`. The
 * snake_case names (`pre_tool_use`, `session_start`) that appear in
 * config.toml's `[hooks.state."<plugin>:pre_tool_use:0:0"]` keys are a separate
 * state-tracking namespace, NOT hooks.json event names. Wiring snake_case here
 * produced entries that parsed fine and would never have fired.
 *
 * The only codex difference is that each command is wrapped in codex-shim.sh,
 * which synthesizes CLAUDE_PROJECT_DIR and sets the host marker.
 */
export const WIRING = [
  { script: "guard-bash.sh", events: [{ event: "PreToolUse", matcher: "Bash" }] },
  { script: "secret-scan.sh", events: [{ event: "PreToolUse", matcher: "Write|Edit|MultiEdit" }] },
  { script: "review-plan-before-exit.sh", events: [{ event: "PreToolUse", matcher: "ExitPlanMode" }] },
  { script: "verify-before-stop.sh", events: [{ event: "Stop" }, { event: "SubagentStop" }] },
  { script: "session-reset.sh", events: [{ event: "SessionStart" }] },
  { script: "context-nudge.sh", events: [{ event: "PostToolUse" }] },
];

export const PROVIDERS = {
  "claude-code": { kind: "claude", config: path.join(os.homedir(), ".claude", "settings.json") },
  "claude-work": { kind: "claude", config: path.join(os.homedir(), ".claude-work", "settings.json") },
  codex: { kind: "codex", config: path.join(os.homedir(), ".codex", "hooks.json") },
};

const isOurs = (cmd) => typeof cmd === "string" && cmd.includes("/.bb/agent-hooks/");

/** Read + parse, or throw with a message naming the file. Never "repair" it. */
export function readConfig(file) {
  if (!existsSync(file)) return { existed: false, data: {} };
  const raw = readFileSync(file, "utf8");
  if (raw.trim() === "") return { existed: true, data: {} };
  try {
    return { existed: true, data: JSON.parse(raw) };
  } catch (err) {
    // Refuse rather than merge into something already broken -- a "repaired"
    // write here could destroy a config we do not understand.
    throw new Error(
      `${file} is not valid JSON (${err.message}). Refusing to touch it. ` +
        `Fix or restore the file, then run install again.`,
    );
  }
}

/** Atomic: write a temp file in the same directory, then rename over the target.
 *  A crash mid-write would otherwise leave invalid JSON, which disables EVERY
 *  hook on that provider -- not just ours. */
export function writeConfigAtomic(file, data) {
  const dir = path.dirname(file);
  mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(file)}.agent-hooks.tmp`);
  const text = JSON.stringify(data, null, 2) + "\n";
  JSON.parse(text); // never emit something we cannot read back
  writeFileSync(tmp, text, { mode: 0o600 });
  renameSync(tmp, file);
}

/** Timestamped backup beside the config, taken before the first write. */
export function backupConfig(file) {
  if (!existsSync(file)) return null;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dest = `${file}.agent-hooks-backup-${stamp}`;
  copyFileSync(file, dest);
  return dest;
}

/** Remove only our entries, preserving every neighbour and every empty-array
 *  quirk we did not create. */
function stripOurs(hooks) {
  const out = {};
  for (const [event, groups] of Object.entries(hooks ?? {})) {
    if (!Array.isArray(groups)) {
      out[event] = groups;
      continue;
    }
    const hadOurs = groups.some((g) => Array.isArray(g?.hooks) && g.hooks.some((h) => isOurs(h?.command)));
    const kept = groups
      .map((g) => {
        if (!g || !Array.isArray(g.hooks)) return g;
        const inner = g.hooks.filter((h) => !isOurs(h?.command));
        if (inner.length === 0 && g.hooks.length > 0) return null; // was entirely ours
        return { ...g, hooks: inner };
      })
      .filter((g) => g !== null);

    // Drop an event key we emptied -- otherwise a rename of our event names (as
    // happened when codex was first wired under snake_case) leaves dead keys
    // behind forever. Only keys WE emptied: a pre-existing empty array, or the
    // `Stop: [{ matcher: "", hooks: [] }]` quirk in ~/.claude-work, is preserved.
    if (kept.length === 0 && hadOurs) continue;
    out[event] = kept;
  }
  return out;
}

function buildPlan(data, makeCommand) {
  const next = structuredClone(data ?? {});
  next.hooks = stripOurs(next.hooks);
  for (const { script, events } of WIRING) {
    for (const { event, matcher } of events) {
      if (!Array.isArray(next.hooks[event])) next.hooks[event] = []; // create, never assume
      const entry = { hooks: [{ type: "command", command: makeCommand(script) }] };
      if (matcher !== undefined) entry.matcher = matcher;
      next.hooks[event].push(entry);
    }
  }
  return next;
}

export function planClaude(data) {
  return buildPlan(data, (script) => path.join(INSTALL_DIR, script));
}

const codexCommand = (script) =>
  `'${path.join(INSTALL_DIR, "codex-shim.sh")}' '${path.join(INSTALL_DIR, script)}'`;

export function planCodex(data) {
  return buildPlan(data, codexCommand);
}

/** The exact command strings planCodex writes -- what Codex trust may auto-accept. */
export function codexCommands() {
  return new Set(WIRING.map((w) => codexCommand(w.script)));
}

export function planUninstall(data) {
  const next = structuredClone(data ?? {});
  next.hooks = stripOurs(next.hooks);
  return next;
}

export function plan(kind, data, { uninstall = false } = {}) {
  if (uninstall) return planUninstall(data);
  return kind === "codex" ? planCodex(data) : planClaude(data);
}

/** How many of our entries a config currently holds. */
export function countOurs(data) {
  let n = 0;
  for (const groups of Object.values(data?.hooks ?? {})) {
    if (!Array.isArray(groups)) continue;
    for (const g of groups) if (Array.isArray(g?.hooks)) for (const h of g.hooks) if (isOurs(h?.command)) n += 1;
  }
  return n;
}

/** Total entries we would install, for the status bar. */
export function expectedCount() {
  return WIRING.reduce((n, w) => n + w.events.length, 0);
}
