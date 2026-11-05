// guard-bash.sh tree-wipe cases that depend on the RUN's values and so cannot sit in
// cases.jsonl: the literal $CLAUDE_PROJECT_DIR and the AGENT_HOOKS_LOG_DIR value.
// The static cases (., *, .git, $PWD, find ...) live in tests/guard-bash/cases.jsonl.

import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync } from "node:fs";
import path from "node:path";
import { cleanup, runHook, ALLOW, HARD } from "./run-hook.mjs";

const scratch: string[] = [];
afterEach(() => {
  while (scratch.length) cleanup(scratch.pop() as string);
});
// Under /tmp, not os.tmpdir(): on macOS that is /var/folders/..., and the system-path
// rule already hard-blocks any delete naming a path under /var, which would hide
// the tree-wipe rule these tests are about.
const project = () => {
  const dir = mkdtempSync("/tmp/agent-hooks-wipe-");
  mkdirSync(path.join(dir, ".claude", "logs"), { recursive: true });
  scratch.push(dir);
  return dir;
};
const FULL = "bypassPermissions";

describe("tree wipe: the project root by its literal value", () => {
  for (const suffix of ["", "/", "/*", "/.*", "/.??*", "/.git"]) {
    for (const mode of [undefined, FULL]) {
      it(`hard-blocks rm -rf <root>${suffix}${mode ? " (full access)" : ""}`, async () => {
        const dir = project();
        const r = await runHook("guard-bash.sh", { command: `rm -rf ${dir}${suffix}` }, { projectDir: dir, permissionMode: mode });
        expect(r.verdict).toBe(HARD);
        expect(r.reason).toContain("tree wipe");
      });
    }
  }

  it("hard-blocks the quoted root and a root reached through a trailing slash in CLAUDE_PROJECT_DIR", async () => {
    const dir = project();
    const quoted = await runHook("guard-bash.sh", { command: `rm -rf "${dir}"` }, { projectDir: dir, permissionMode: FULL });
    expect(quoted.verdict).toBe(HARD);
    const trailing = await runHook("guard-bash.sh", { command: `rm -rf ${dir}/*` }, { projectDir: `${dir}/`, permissionMode: FULL });
    expect(trailing.verdict).toBe(HARD);
  });

  it("does not block a subdirectory of the root, or a recursive rm elsewhere, in full access", async () => {
    const dir = project();
    for (const cmd of [`rm -rf ${dir}/dist`, `rm -rf ${dir}/dist/*`, `rm -rf ${dir}-sibling`, `rm -rf ${dir}/.cache`]) {
      const r = await runHook("guard-bash.sh", { command: cmd }, { projectDir: dir, permissionMode: FULL });
      expect(r.verdict, cmd).toBe(ALLOW);
    }
  });

  it("does not glob-expand a bare * against the hook's own cwd before comparing it", async () => {
    // The hook inherits this process's cwd, which is full of files; a token scan that
    // expanded * would see file names and let the wipe through.
    const dir = project();
    const r = await runHook("guard-bash.sh", { command: "rm -rf *" }, { projectDir: dir, permissionMode: FULL });
    expect(r.verdict).toBe(HARD);
  });

  it("a single command containing a wipe clause is blocked wherever the clause sits", async () => {
    const dir = project();
    for (const cmd of ["ls && rm -rf .", "ls; rm -rf .; ls", "true_cmd || rm -rf .", "echo a | rm -rf ."]) {
      const r = await runHook("guard-bash.sh", { command: cmd }, { projectDir: dir, permissionMode: FULL });
      expect(r.verdict, cmd).toBe(HARD);
    }
  });
});

describe("tree wipe: the incident log by its configured value", () => {
  it("hard-blocks rm and chflags naming AGENT_HOOKS_LOG_DIR's value, but not an unrelated path", async () => {
    const dir = project();
    const logs = mkdtempSync("/tmp/agent-hooks-guarded-logs-");
    scratch.push(logs);
    const env = { AGENT_HOOKS_LOG_DIR: logs };
    for (const cmd of [`rm -rf ${logs}`, `rm -f ${logs}/-x-y.md`, `chflags -R nouappnd ${logs}`, `chflags nouappnd ${logs}/-x-y.md`]) {
      const r = await runHook("guard-bash.sh", { command: cmd }, { projectDir: dir, env, permissionMode: FULL });
      expect(r.verdict, cmd).toBe(HARD);
    }
    for (const cmd of [`rm -f ${dir}/a.log`, `chflags nouappnd ${dir}/a.log`]) {
      const r = await runHook("guard-bash.sh", { command: cmd }, { projectDir: dir, env, permissionMode: FULL });
      expect(r.verdict, cmd).toBe(ALLOW);
    }
  });
});
