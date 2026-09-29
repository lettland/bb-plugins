import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { aislopArgs, clip, exec, resolveBase, scan, type Exec, type ScanInput } from "./scan.js";

function sh(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
  }).trim();
}

function write(dir: string, file: string, content: string): void {
  writeFileSync(path.join(dir, file), content);
}

/**
 * main: a.ts. feat/x forks, commits b.ts, stages c.ts, leaves d.ts untracked.
 * main then moves on (a.ts changes) after the fork.
 */
function makeRepo(): { dir: string; forkSha: string; mainTip: string } {
  const dir = mkdtempSync(path.join(tmpdir(), "aislop-scan-"));
  sh(dir, "init", "-q", "-b", "main");
  write(dir, "a.ts", "export const a = 1;\n");
  sh(dir, "add", ".");
  sh(dir, "commit", "-qm", "init");
  const forkSha = sh(dir, "rev-parse", "HEAD");
  sh(dir, "checkout", "-qb", "feat/x");
  write(dir, "b.ts", "export const b = 1;\n");
  sh(dir, "add", ".");
  sh(dir, "commit", "-qm", "b");
  sh(dir, "checkout", "-q", "main");
  write(dir, "a.ts", "export const a = 2;\n");
  sh(dir, "commit", "-qam", "main moves");
  const mainTip = sh(dir, "rev-parse", "HEAD");
  sh(dir, "checkout", "-q", "feat/x");
  write(dir, "c.ts", "export const c = 1;\n");
  sh(dir, "add", "c.ts");
  write(dir, "d.ts", "export const d = 1;\n");
  return { dir, forkSha, mainTip };
}

function input(overrides: Partial<ScanInput> = {}): ScanInput {
  return {
    directory: "/repo",
    scope: "branch",
    base: null,
    rootBranch: null,
    verbose: false,
    json: false,
    include: [],
    exclude: [],
    timeoutMs: 60_000,
    ...overrides,
  };
}

/** Real git; npx is recorded and answered with `answer`. */
function fakeNpx(answer: { exitCode: number; stdout: string; stderr: string }) {
  const calls: Array<{ args: string[]; cwd: string }> = [];
  const run: Exec = async (command, args, options) => {
    if (command !== "npx") return exec(command, args, options);
    calls.push({ args, cwd: options.cwd });
    return answer;
  };
  return { run, calls };
}

describe("resolveBase", () => {
  it("uses the merge-base with the root branch, not the root's tip", async () => {
    const { dir, forkSha, mainTip } = makeRepo();
    const base = await resolveBase(exec, { directory: dir, scope: "branch", base: null, rootBranch: "main" });
    expect(base).toEqual({ ref: "main", sha: forkSha });
    expect(base?.sha).not.toBe(mainTip);
  });

  it("finds the root on its own when bb names none", async () => {
    const { dir, forkSha } = makeRepo();
    const base = await resolveBase(exec, { directory: dir, scope: "branch", base: null, rootBranch: null });
    expect(base).toEqual({ ref: "main", sha: forkSha });
  });

  it("prefers the remote copy of the root, so unpushed root commits count as changes", async () => {
    const { dir, forkSha, mainTip } = makeRepo();
    sh(dir, "update-ref", "refs/remotes/origin/main", forkSha);
    sh(dir, "checkout", "-q", "main");
    const base = await resolveBase(exec, { directory: dir, scope: "branch", base: null, rootBranch: "main" });
    expect(base).toEqual({ ref: "origin/main", sha: forkSha });
    expect(base?.sha).not.toBe(mainTip);
  });

  it("falls back to the repo's own root when bb's root branch is not in it", async () => {
    const { dir, forkSha } = makeRepo();
    const base = await resolveBase(exec, { directory: dir, scope: "branch", base: null, rootBranch: "master" });
    expect(base).toEqual({ ref: "main", sha: forkSha });
  });

  it("follows origin/HEAD when bb names no root", async () => {
    const { dir, forkSha } = makeRepo();
    sh(dir, "branch", "-q", "-m", "main", "trunk");
    sh(dir, "update-ref", "refs/remotes/origin/trunk", forkSha);
    sh(dir, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/trunk");
    const base = await resolveBase(exec, { directory: dir, scope: "branch", base: null, rootBranch: null });
    expect(base).toEqual({ ref: "origin/trunk", sha: forkSha });
  });

  it("takes an explicit base, still through the merge-base", async () => {
    const { dir, forkSha } = makeRepo();
    const base = await resolveBase(exec, { directory: dir, scope: "branch", base: "main", rootBranch: "nope" });
    expect(base).toEqual({ ref: "main", sha: forkSha });
  });

  it("compares uncommitted changes against HEAD", async () => {
    const { dir } = makeRepo();
    const head = sh(dir, "rev-parse", "HEAD");
    const base = await resolveBase(exec, { directory: dir, scope: "changes", base: null, rootBranch: "main" });
    expect(base).toEqual({ ref: "HEAD", sha: head });
  });

  it("needs no base for the staged and whole-directory scopes", async () => {
    for (const scope of ["staged", "all"] as const) {
      expect(await resolveBase(exec, { directory: "/nowhere", scope, base: null, rootBranch: null })).toBeNull();
    }
  });
});

describe("aislopArgs", () => {
  const base = { ref: "main", sha: "abc123" };

  it("hands aislop the merge-base commit for a branch scan", () => {
    expect(aislopArgs(input(), base)).toEqual(["--yes", "aislop@latest", "scan", "--changes", "--base", "abc123", "."]);
  });

  it("passes staged, verbose, json, include and exclude through", () => {
    expect(
      aislopArgs(input({ scope: "staged", verbose: true, json: true, include: ["src"], exclude: ["a", "b"] }), null),
    ).toEqual([
      "--yes", "aislop@latest", "scan", "--staged", "--verbose", "--json",
      "--include", "src", "--exclude", "a", "--exclude", "b", ".",
    ]);
  });

  it("scans everything with no base", () => {
    expect(aislopArgs(input({ scope: "all" }), null)).toEqual(["--yes", "aislop@latest", "scan", "."]);
  });
});

describe("scan", () => {
  it("runs aislop in the checkout against the merge-base", async () => {
    const { dir, forkSha } = makeRepo();
    const { run, calls } = fakeNpx({ exitCode: 1, stdout: "score 90\n", stderr: "" });
    const result = await scan(input({ directory: dir, rootBranch: "main" }), run);
    expect(result).toEqual({ exitCode: 1, stdout: "score 90\n", stderr: "", base: { ref: "main", sha: forkSha } });
    expect(calls).toEqual([{ cwd: dir, args: ["--yes", "aislop@latest", "scan", "--changes", "--base", forkSha, "."] }]);
  });

  it("reports an unresolvable base without running aislop", async () => {
    const { dir } = makeRepo();
    const { run, calls } = fakeNpx({ exitCode: 0, stdout: "", stderr: "" });
    const result = await scan(input({ directory: dir, base: "no-such-ref" }), run);
    expect(result).toEqual({ exitCode: 2, stdout: "", stderr: "Unknown ref: no-such-ref\n", base: null });
    expect(calls).toEqual([]);
  });

  it("names the refs it tried when the repo has no root branch", async () => {
    const { dir } = makeRepo();
    sh(dir, "branch", "-q", "-m", "main", "trunk");
    const result = await scan(input({ directory: dir }), fakeNpx({ exitCode: 0, stdout: "", stderr: "" }).run);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("tried origin/main, main, origin/master, master");
    expect(result.stderr).toContain("--base");
  });

  it("refuses a directory that is not a git checkout", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "aislop-nogit-"));
    const run = fakeNpx({ exitCode: 0, stdout: "", stderr: "" }).run;
    expect((await scan(input({ directory: dir }), run)).stderr).toContain("not inside a git checkout");
    expect((await scan(input({ directory: dir, scope: "changes" }), run)).stderr).toContain("not a git checkout");
  });

  it("clips output that would overflow bb's CLI limit", async () => {
    const { run } = fakeNpx({ exitCode: 0, stdout: "x".repeat(2 * 1024 * 1024), stderr: "e".repeat(100 * 1024) });
    const result = await scan(input({ scope: "all", directory: tmpdir() }), run);
    expect(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr)).toBeLessThan(1024 * 1024);
    expect(result.stdout).toContain("output truncated");
    expect(result.stderr).toContain("output truncated");
  });
});

describe("clip", () => {
  it("leaves short text alone", () => {
    expect(clip("hello", 10)).toBe("hello");
  });

  it("stays within the byte budget, note included", () => {
    const clipped = clip("y".repeat(500), 200);
    expect(Buffer.byteLength(clipped)).toBeLessThanOrEqual(200);
    expect(clipped).toContain("output truncated at 200 bytes");
  });
});

describe("exec", () => {
  it("resolves with a failing command's exit code and output", async () => {
    const result = await exec("sh", ["-c", "echo out; echo err >&2; exit 3"], { cwd: tmpdir(), timeoutMs: 10_000 });
    expect(result).toEqual({ exitCode: 3, stdout: "out\n", stderr: "err\n" });
  });

  it("reports a missing executable as 127", async () => {
    const result = await exec("definitely-not-a-command-xyz", [], { cwd: tmpdir(), timeoutMs: 10_000 });
    expect(result.exitCode).toBe(127);
  });

  it("reports a timeout as 124", async () => {
    const result = await exec("sleep", ["5"], { cwd: tmpdir(), timeoutMs: 100 });
    expect(result.exitCode).toBe(124);
    expect(result.stderr).toContain("timed out");
  });
});
