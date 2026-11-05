// guard-bash.sh tree-wipe cases that depend on the RUN's values and so cannot sit in
// cases.jsonl: the literal $CLAUDE_PROJECT_DIR and the AGENT_HOOKS_LOG_DIR value.
// The static cases (., *, .git, $PWD, find ...) live in tests/guard-bash/cases.jsonl.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
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

describe("tree wipe: chflags on the log dir or any ancestor of it", () => {
  // The hook still logs the denied command, so the (fake) home and the relocated log
  // dir must be real dirs that get cleaned up (cleanup() clears the append-only flag).
  let home = "";
  let elsewhere = "";
  beforeEach(() => {
    const base = mkdtempSync("/tmp/agent-hooks-chflags-");
    scratch.push(base);
    home = `${base}/user`;
    elsewhere = `${base}/elsewhere`;
  });
  const run = (cmd: string, env: Record<string, string> = {}) =>
    runHook("guard-bash.sh", { command: cmd }, { projectDir: project(), env: { HOME: home, AGENT_HOOKS_LOG_DIR: "", ...env }, permissionMode: FULL });

  it("blocks every ancestor of the default log dir, up to /", async () => {
    for (const target of [
      `${home}/.bb/logs/agent-hooks`,
      `${home}/.bb/logs`,
      `${home}/.bb`,
      home,
      path.dirname(home), // the parent of home (/Users on macOS)
      "/tmp",
      "/",
      "~/.bb/logs",
      "~",
      "$HOME",
      "${HOME}/.bb/",
      "~/.bb/*",
    ]) {
      const r = await run(`chflags -R nouappnd ${target}`);
      expect(r.verdict, target).toBe(HARD);
    }
  });

  it("blocks the ancestors of a relocated log dir (AGENT_HOOKS_LOG_DIR), and still the default one", async () => {
    const env = { AGENT_HOOKS_LOG_DIR: `${elsewhere}/deep/logs` };
    for (const target of [`${elsewhere}/deep/logs`, `${elsewhere}/deep`, elsewhere, `${home}/.bb/logs`]) {
      const r = await run(`chflags -R nouappnd ${target}`, env);
      expect(r.verdict, target).toBe(HARD);
    }
  });

  it("allows chflags on a sibling, a child of an ancestor that is not on the path, and a relative path", async () => {
    for (const target of [`${home}/projects/x`, `${home}/.bb/other`, `${elsewhere}2`, "build/out", "-h"]) {
      const r = await run(`chflags nouappnd ${target}`);
      expect(r.verdict, target).toBe(ALLOW);
    }
  });

  it("ignores a relative AGENT_HOOKS_LOG_DIR instead of looping on it", async () => {
    const r = await run("chflags -R nouappnd /tmp/x", { AGENT_HOOKS_LOG_DIR: "relative/logs" });
    expect(r.verdict).toBe(ALLOW);
  });
});

describe("tree wipe: command position", () => {
  const run = (cmd: string) => runHook("guard-bash.sh", { command: cmd }, { projectDir: project(), permissionMode: FULL });

  it("a pipeline stage, a keyword or a nested command is still a command", async () => {
    for (const cmd of ["ls | sudo rm -rf .", "if true; then rm -rf .; fi", "x=$(rm -rf ./*)", "time -p rm -rf .", "exec rm -rf .", "nohup rm -rf ./* &"]) {
      expect((await run(cmd)).verdict, cmd).toBe(HARD);
    }
  });

  it("rm, find and chflags as arguments or inside quotes are not commands", async () => {
    for (const cmd of ["ls rm -rf .", "grep -r 'rm -rf .' src", "man find", "printf '%s\\n' 'find . -delete' | cat", "git log --grep=rm"]) {
      expect((await run(cmd)).verdict, cmd).toBe(ALLOW);
    }
  });

  it("a quoted string stays in play when it has no whitespace or separator", async () => {
    expect((await run("rm -rf './.??*'")).verdict).toBe(HARD);
    expect((await run('find "." -delete')).verdict).toBe(HARD);
  });

  it("an unterminated quote does not hide a later command", async () => {
    expect((await run("echo it's; rm -rf .")).verdict).toBe(HARD);
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
