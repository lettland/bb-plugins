// `bb agent-hooks` — install | status | uninstall | log
//
// Ordering rule enforced here: uninstalling k0d3 (or anything else) while these
// hooks are not actually firing leaves the machine unguarded. `status --probe` is
// the evidence for that, and it checks behaviour, not just file presence.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  PROVIDERS,
  INSTALL_DIR,
  readConfig,
  writeConfigAtomic,
  backupConfig,
  plan,
  countOurs,
  expectedCount,
  codexCommands,
} from "./wire.mjs";
import { syncCodexTrust } from "./codex-trust.mjs";
import { sync, syncDrift, verifyChecksums } from "./sync.mjs";
import { probeAll } from "./probe.mjs";

const pick = (argv, flag) => {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("-") ? argv[i + 1] : undefined;
};
const has = (argv, flag) => argv.includes(flag);

function targets(argv) {
  const only = pick(argv, "--provider");
  if (!only) return Object.entries(PROVIDERS);
  const entry = PROVIDERS[only];
  if (!entry) {
    throw new Error(`unknown provider '${only}'. Known: ${Object.keys(PROVIDERS).join(", ")}`);
  }
  return [[only, entry]];
}

// Codex only runs hooks.json entries it has trusted, keyed by position -- so every
// write to that file has to be followed by re-keying the trust (codex-trust.mjs).
async function codexTrust(provider, out, { readOnly = false } = {}) {
  const r = await syncCodexTrust({ sourcePath: provider.config, ourCommands: codexCommands(), readOnly });
  if (r.status === "skipped") {
    out(`    codex trust: skipped -- ${r.reason}`);
    return true;
  }
  if (r.status === "refused") {
    out(`    codex trust: REFUSED -- ${r.reason}; config.toml left untouched`);
    return false;
  }
  const note = r.changed ? `  (re-keyed; backup: ${path.basename(r.backup)})` : "";
  out(`    codex trust: ${r.oursTrusted}/${r.ours} agent-hooks trusted${note}`);
  if (r.untrusted?.length) out(`    left untrusted (never trusted before): ${r.untrusted.join(", ")}`);
  return r.oursTrusted === r.ours;
}

function diffSummary(before, after) {
  return `${countOurs(before)} -> ${countOurs(after)} agent-hooks entr${countOurs(after) === 1 ? "y" : "ies"}`;
}

async function cmdInstall(argv, out) {
  const dry = has(argv, "--dry-run");
  const list = targets(argv);

  try {
    verifyChecksums();
  } catch (err) {
    out(`refusing to install: ${err.message}`);
    return 1;
  }

  if (!dry) {
    const changed = sync();
    if (changed.length > 0) {
      const overwritten = changed.filter((c) => c.overwrote).map((c) => c.name);
      out(`synced ${changed.length} script(s) -> ${INSTALL_DIR}`);
      if (overwritten.length > 0) out(`  overwrote modified: ${overwritten.join(", ")}`);
    }
  }

  let failures = 0;
  for (const [id, provider] of list) {
    let current;
    try {
      current = readConfig(provider.config);
    } catch (err) {
      out(`  ${id}: ${err.message}`);
      failures += 1;
      continue;
    }
    const next = plan(provider.kind, current.data);
    if (dry) {
      out(`  ${id}  ${provider.config}`);
      out(`    would write: ${diffSummary(current.data, next)}`);
      if (provider.kind === "codex") out("    would re-key hook trust in ~/.codex/config.toml");
      continue;
    }
    const backup = current.existed ? backupConfig(provider.config) : null;
    writeConfigAtomic(provider.config, next);
    out(`  ${id}  ${diffSummary(current.data, next)}${backup ? `  (backup: ${path.basename(backup)})` : ""}`);
    if (provider.kind === "codex" && !(await codexTrust(provider, out))) failures += 1;
  }
  if (dry) out("\ndry run: nothing was written.");
  return failures > 0 ? 1 : 0;
}

async function cmdStatus(argv, out) {
  const list = targets(argv);
  let bad = 0;

  out("providers:");
  for (const [id, provider] of list) {
    let current;
    try {
      current = readConfig(provider.config);
    } catch (err) {
      out(`  ${id.padEnd(12)} ERROR  ${err.message}`);
      bad += 1;
      continue;
    }
    const found = countOurs(current.data);
    const want = expectedCount();
    const state = found === want ? "ok" : found === 0 ? "not installed" : "partial";
    if (found !== want) bad += 1;
    out(`  ${id.padEnd(12)} ${String(found)}/${want}  ${state}`);
    if (provider.kind === "codex" && found > 0 && !(await codexTrust(provider, out, { readOnly: true }))) bad += 1;
  }

  const drift = syncDrift();
  out(`\ninstall dir: ${INSTALL_DIR}`);
  if (drift.length === 0) out("  scripts current");
  else {
    bad += 1;
    for (const d of drift) out(`  DRIFT ${d.name} (${d.reason}) — run 'bb agent-hooks install'`);
  }

  if (has(argv, "--probe")) {
    out("\nprobe (synthetic stdin; no command is ever executed):");
    const results = await probeAll();
    for (const r of results) {
      if (!r.ok) bad += 1;
      out(`  ${r.ok ? "ok  " : "FAIL"} ${r.script.padEnd(28)} ${r.detail}`);
    }
    const gates = results.filter((r) => r.script !== "session-reset.sh");
    const denied = gates.filter((r) => r.ok).length;
    out(`\n  ${denied}/${gates.length} gate hooks responding, session-reset ${
      results.find((r) => r.script === "session-reset.sh")?.ok ? "clean" : "FAILING"
    }`);
  } else {
    out("\n(run with --probe to verify the hooks actually respond, not just that they are listed)");
  }

  return bad > 0 ? 1 : 0;
}

async function cmdUninstall(argv, out) {
  const list = targets(argv);
  for (const [id, provider] of list) {
    let current;
    try {
      current = readConfig(provider.config);
    } catch (err) {
      out(`  ${id}: ${err.message}`);
      continue;
    }
    const next = plan(provider.kind, current.data, { uninstall: true });
    const backup = current.existed ? backupConfig(provider.config) : null;
    writeConfigAtomic(provider.config, next);
    out(`  ${id}  ${diffSummary(current.data, next)}${backup ? `  (backup: ${path.basename(backup)})` : ""}`);
    if (provider.kind === "codex") await codexTrust(provider, out); // re-key the neighbours that shifted
  }
  out(`\nScripts left in place at ${INSTALL_DIR}; remove that directory by hand if you want them gone.`);
  return 0;
}

function cmdLog(argv, out) {
  // Hooks append to the per-project incident log; there is no central store.
  const limit = Number(pick(argv, "--limit") ?? 20);
  const roots = [process.cwd()];
  let found = 0;
  for (const root of roots) {
    const file = path.join(root, ".claude", "logs", "incident-log.md");
    if (!existsSync(file)) continue;
    const lines = readFileSync(file, "utf8").trim().split("\n").filter(Boolean);
    const tail = lines.slice(-limit);
    out(`${file}  (last ${tail.length} of ${lines.length})`);
    for (const l of tail) out(`  ${l}`);
    found += 1;
  }
  if (found === 0) {
    out("no incident log in the current project — hooks write to <project>/.claude/logs/incident-log.md");
  }
  return 0;
}

/** bb's CLI contract: run() must resolve to { exitCode, stdout?, stderr? }. */
export async function runAgentHooksCli(argv) {
  const lines = [];
  const out = (s) => lines.push(s);
  const [sub, ...rest] = argv;
  let exitCode = 0;
  try {
    switch (sub) {
      case "install":
        exitCode = await cmdInstall(rest, out);
        break;
      case "status":
      case undefined:
        exitCode = await cmdStatus(rest, out);
        break;
      case "uninstall":
        exitCode = await cmdUninstall(rest, out);
        break;
      case "log":
        exitCode = cmdLog(rest, out);
        break;
      default:
        out(`unknown subcommand '${sub}'. Try: install | status | uninstall | log`);
        exitCode = 1;
    }
  } catch (err) {
    return { exitCode: 1, stdout: lines.join("\n"), stderr: `error: ${err.message}` };
  }
  return { exitCode, stdout: lines.join("\n") };
}
