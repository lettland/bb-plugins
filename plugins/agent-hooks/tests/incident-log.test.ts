// Where the hooks write their incident log, and how it is protected.
//
// The log used to live in <project>/.claude/logs/incident-log.md, so a process that
// emptied the project dir took the log with it. It now lives outside the project, in
// ${AGENT_HOOKS_LOG_DIR:-~/.bb/logs/agent-hooks}/<key>.md (<key> = project dir with
// "/" replaced by "-"), and on macOS/BSD the hooks set the user append-only flag.
// Every test points AGENT_HOOKS_LOG_DIR or HOME at a throwaway dir; the real
// ~/.bb/logs is never touched.

import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { cleanup, incidentLogDir, incidentLogFile, makeProjectDir, runHook, ALLOW, HARD } from "./run-hook.mjs";

const hasChflags = (() => {
  try {
    execFileSync("chflags", ["-h"], { stdio: "ignore" });
    return true;
  } catch (e: any) {
    return e.code !== "ENOENT"; // chflags prints usage and exits non-zero when it exists
  }
})();
const flagged = hasChflags ? it : it.skip;

const scratch: string[] = [];
afterEach(() => {
  while (scratch.length) cleanup(scratch.pop() as string);
});
const project = () => {
  const dir = makeProjectDir();
  scratch.push(dir);
  return dir;
};
const tmp = (prefix: string) => {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  scratch.push(dir);
  return dir;
};
const flagsOf = (p: string) => execFileSync("stat", ["-f", "%Sf", p], { encoding: "utf8" }).trim();

// Any logged, denied command works as the writer; this one is a HARD BLOCK that logs.
const LOGGED = "git reset --hard";

describe("guard-bash.sh incident log location", () => {
  it("writes <log dir>/<key>.md, with / in the project dir replaced by -, and nothing inside the project", async () => {
    const dir = project();
    const r = await runHook("guard-bash.sh", { command: LOGGED }, { projectDir: dir });
    expect(r.verdict).toBe(HARD);

    const file = incidentLogFile(dir);
    expect(path.basename(file)).toBe(`${dir.replaceAll("/", "-")}.md`);
    expect(path.basename(file)).not.toContain("/");
    expect(readFileSync(file, "utf8")).toMatch(/^- `[\d-]+ [\d:]+` \| GUARD \| HIGH \| BLOCKED: git reset --hard: git reset --hard\n$/);
    expect(existsSync(path.join(dir, ".claude", "logs", "incident-log.md"))).toBe(false);
  });

  it("defaults to ~/.bb/logs/agent-hooks when AGENT_HOOKS_LOG_DIR is unset or empty", async () => {
    const dir = project();
    const home = tmp("agent-hooks-home-");
    await runHook("guard-bash.sh", { command: LOGGED }, { projectDir: dir, env: { HOME: home, AGENT_HOOKS_LOG_DIR: "" } });
    const file = path.join(home, ".bb", "logs", "agent-hooks", `${dir.replaceAll("/", "-")}.md`);
    expect(readFileSync(file, "utf8")).toContain("BLOCKED: git reset --hard");
    expect(existsSync(incidentLogDir(dir))).toBe(false);
  });

  it("keeps one file per project in the same log dir", async () => {
    const a = project();
    const b = project();
    const shared = tmp("agent-hooks-shared-logs-");
    await runHook("guard-bash.sh", { command: LOGGED }, { projectDir: a, env: { AGENT_HOOKS_LOG_DIR: shared } });
    await runHook("guard-bash.sh", { command: LOGGED }, { projectDir: b, env: { AGENT_HOOKS_LOG_DIR: shared } });
    expect(existsSync(path.join(shared, `${a.replaceAll("/", "-")}.md`))).toBe(true);
    expect(existsSync(path.join(shared, `${b.replaceAll("/", "-")}.md`))).toBe(true);
  });

  it("does not create the project's .claude/logs for the incident log", async () => {
    const dir = tmp("agent-hooks-nologs-"); // no .claude/logs here
    await runHook("guard-bash.sh", { command: LOGGED }, { projectDir: dir });
    expect(existsSync(path.join(dir, ".claude"))).toBe(false);
    expect(existsSync(incidentLogFile(dir))).toBe(true);
  });
});

describe("the other incident-log writers use the same location", () => {
  it("secret-scan.sh", async () => {
    const dir = project();
    const secret = "ghp_" + "A".repeat(36); // assembled at runtime: no literal secret on disk
    const r = await runHook(
      "secret-scan.sh",
      { file_path: path.join(dir, "src", "a.ts"), content: `const t = "${secret}";\n` },
      { projectDir: dir, toolName: "Write" },
    );
    expect(r.verdict).not.toBe(ALLOW);
    expect(readFileSync(incidentLogFile(dir), "utf8")).toContain("| SECRET-SCAN | HIGH | BLOCKED:");
    expect(existsSync(path.join(dir, ".claude", "logs", "incident-log.md"))).toBe(false);
  });

  it("verify-before-stop.sh", async () => {
    const dir = project();
    const transcript = path.join(dir, "transcript.jsonl");
    writeFileSync(
      transcript,
      [
        { type: "user", message: { role: "user", content: "run it" } },
        { type: "user", message: { role: "user", content: [{ type: "tool_result", content: "zsh: command not found: nope" }] } },
      ]
        .map((e) => JSON.stringify(e))
        .join("\n") + "\n",
    );
    const r = await runHook("verify-before-stop.sh", {}, { projectDir: dir, envelope: { hook_event_name: "Stop", transcript_path: transcript } });
    expect(JSON.parse(r.stdout).decision).toBe("block");
    expect(readFileSync(incidentLogFile(dir), "utf8")).toMatch(/\| VERIFY \| BLOCK \| command not found\n$/);
    expect(existsSync(path.join(dir, ".claude", "logs", "incident-log.md"))).toBe(false);
  });
});

describe("append-only protection (macOS/BSD)", () => {
  flagged("sets uappnd on the log file and its directory, and appends and new files still work", async () => {
    const a = project();
    const b = project();
    const logs = tmp("agent-hooks-flag-logs-");
    const env = { AGENT_HOOKS_LOG_DIR: logs };

    await runHook("guard-bash.sh", { command: LOGGED }, { projectDir: a, env });
    const file = path.join(logs, `${a.replaceAll("/", "-")}.md`);
    expect(flagsOf(file)).toContain("uappnd");
    expect(flagsOf(logs)).toContain("uappnd");

    await runHook("guard-bash.sh", { command: LOGGED }, { projectDir: a, env }); // append to the flagged file
    expect(readFileSync(file, "utf8").trim().split("\n")).toHaveLength(2);

    await runHook("guard-bash.sh", { command: LOGGED }, { projectDir: b, env }); // new file in the flagged dir
    expect(existsSync(path.join(logs, `${b.replaceAll("/", "-")}.md`))).toBe(true);
    expect(flagsOf(path.join(logs, `${b.replaceAll("/", "-")}.md`))).toContain("uappnd");
  });

  flagged("makes rm of the log file and of the log directory fail", async () => {
    const dir = project();
    const logs = tmp("agent-hooks-rm-logs-");
    await runHook("guard-bash.sh", { command: LOGGED }, { projectDir: dir, env: { AGENT_HOOKS_LOG_DIR: logs } });
    const file = path.join(logs, `${dir.replaceAll("/", "-")}.md`);

    expect(() => execFileSync("rm", ["-f", file], { stdio: "pipe" })).toThrow(/Operation not permitted/);
    expect(() => execFileSync("rm", ["-rf", logs], { stdio: "pipe" })).toThrow(/Operation not permitted/);
    expect(existsSync(file)).toBe(true);
  });

  it("never lets the flag change a verdict when the log dir cannot be created", async () => {
    const dir = project();
    const blocker = path.join(tmp("agent-hooks-blocker-"), "file");
    writeFileSync(blocker, "x");
    // A regular file where the log dir should be: mkdir fails, the verdict still stands.
    const r = await runHook("guard-bash.sh", { command: LOGGED }, { projectDir: dir, env: { AGENT_HOOKS_LOG_DIR: path.join(blocker, "sub") } });
    expect(r.verdict).toBe(HARD);
  });
});
