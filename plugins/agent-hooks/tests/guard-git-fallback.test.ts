// guard-bash.sh git hook-bypass check: when python3 cannot give a verdict the
// whitespace fallback must still soft-block the bypass and still allow ordinary use.
//
// PATH is replaced by a dir of symlinks to exactly the tools guard-bash.sh uses.
// System dirs also hold python3, so a real PATH could not prove the fallback ran.
// The no-`command not found` assertion keeps a missing symlink from making the
// allow half pass vacuously.

import { afterAll, describe, expect, it } from "vitest";
import { accessSync, constants, mkdtempSync, symlinkSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { cleanup, runHook, SOFT, ALLOW } from "./run-hook.mjs";

// Every external command guard-bash.sh can reach on these paths.
const TOOLS = ["bash", "jq", "git", "date", "mkdir", "tr", "sed", "grep", "cat", "find", "head", "tail", "dirname", "basename", "rm", "mv", "env"];

/** First executable named `name` on the real PATH, found without a shell (so no
 *  shell function or alias can answer instead). */
function locate(name: string): string | null {
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, name);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // not here
    }
  }
  return null;
}

const dirs: string[] = [];

function toolDir(python?: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), "agent-hooks-fallback-"));
  dirs.push(dir);
  for (const tool of TOOLS) {
    const real = locate(tool);
    if (real) symlinkSync(real, path.join(dir, tool));
  }
  if (python !== undefined) {
    const shim = path.join(dir, "python3");
    writeFileSync(shim, `#!/bin/sh\n${python}\n`);
    chmodSync(shim, 0o755);
  }
  return dir;
}

afterAll(() => {
  for (const d of dirs) cleanup(d);
});

const SCENARIOS: [string, string | undefined][] = [
  ["no python3 on PATH", undefined],
  ["python3 exits 1 with no output", "exit 1"],
  ["python3 exits 0 and prints garbage", "cat > /dev/null; echo garbage"],
];

describe.each(SCENARIOS)("git bypass fallback: %s", (_name, python) => {
  const run = (cmd: string) => runHook("guard-bash.sh", { command: cmd }, { env: { PATH: toolDir(python) } });

  it("soft-blocks commit -n and says why the scan was quote-blind", async () => {
    const r = await run("git commit -n -m x");
    expect(r.stderr).not.toContain("command not found");
    expect(r.verdict).toBe(SOFT);
    expect(r.reason).toMatch(/^SOFT BLOCK:/);
    expect(r.stdout).toContain("Fallback scan");
  });

  it("soft-blocks --no-verify and a core.hooksPath override", async () => {
    for (const cmd of ["git commit --no-verify -m x", "git -c core.hooksPath=/dev/null commit -m x"]) {
      const r = await run(cmd);
      expect(r.stderr).not.toContain("command not found");
      expect(r.verdict).toBe(SOFT);
    }
  });

  it("allows git log -n 5", async () => {
    const r = await run("git log -n 5");
    expect(r.stderr).not.toContain("command not found");
    expect(r.verdict).toBe(ALLOW);
  });
});
