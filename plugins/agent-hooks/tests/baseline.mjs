// Baseline recorder. Runs the corpus against guard-bash.sh AS IT STANDS and prints
// which cases already disagree with the target verdict.
//
// This must be run BEFORE any fix. The resulting disagreement list is the control:
// every fix has to move a line from wrong to right, and move none the other way.
//
//   node tests/baseline.mjs            # human-readable
//   node tests/baseline.mjs --json     # machine-readable, for diffing across runs

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runHook, makeProjectDir, makeGitRepo, cleanup } from "./run-hook.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

const FIXTURES = {
  "env-ignored": () => makeGitRepo({ ignored: [".env"] }),
  "env-not-ignored": () => makeGitRepo({ tracked: [] }),
  "tracked-config": () => makeGitRepo({ ignored: [".env"], tracked: ["config/settings.yml"] }),
  "non-repo": () => makeProjectDir(),
};

export function loadCases() {
  const raw = readFileSync(path.join(HERE, "guard-bash", "cases.jsonl"), "utf8");
  return raw
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l));
}

export async function runCase(c) {
  let dir;
  let owned = false;
  if (c.fixture) {
    const make = FIXTURES[c.fixture];
    if (!make) throw new Error(`unknown fixture: ${c.fixture}`);
    dir = make();
    owned = true;
  }
  try {
    // An optional "mode" on a case is sent as the envelope's permission_mode.
    const r = await runHook("guard-bash.sh", { command: c.cmd }, { projectDir: dir, permissionMode: c.mode });
    return { ...c, actual: r.verdict, reason: r.reason };
  } finally {
    if (owned && dir) cleanup(dir);
  }
}

export async function runAll() {
  const cases = loadCases();
  const results = [];
  for (const c of cases) results.push(await runCase(c));
  return results;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const results = await runAll();
  const wrong = results.filter((r) => r.actual !== r.expect);
  if (process.argv.includes("--json")) {
    const out = path.join(HERE, "guard-bash", "baseline.json");
    writeFileSync(out, JSON.stringify(results, null, 2) + "\n");
    console.log(`wrote ${out}`);
  }
  console.log(`\n=== BASELINE: unmodified guard-bash.sh ===`);
  console.log(`total ${results.length}   agree ${results.length - wrong.length}   DISAGREE ${wrong.length}\n`);
  for (const r of wrong) {
    console.log(`  ${r.expect.padEnd(5)} <- got ${String(r.actual).padEnd(18)} ${r.id}`);
    console.log(`        $ ${r.cmd.replace(/\n/g, "\\n")}`);
  }
  const malformed = results.filter((r) => r.actual === "malformed" || r.actual === "deny-unclassified");
  if (malformed.length > 0) {
    console.log(`\n!! ${malformed.length} case(s) produced unparseable or unclassified output`);
  }
}
