import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { hostContract } from "./contract.js";
import host from "./host.js";

// The sdk's host bundle is CJS and will not load under vitest's ESM transform;
// pass the entry through unchanged, which is all defineHostEntry does.
vi.mock("@get-bb/plugin-sdk/host", () => ({
  experimental_defineHostEntry: (args: unknown) => args,
}));

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

/** main: a.ts; feat/x forks and commits b.ts. */
function makeRepo(): { dir: string; forkSha: string } {
  const dir = mkdtempSync(path.join(tmpdir(), "aislop-host-"));
  sh(dir, "init", "-q", "-b", "main");
  write(dir, "a.ts", "export const a = 1;\n");
  sh(dir, "add", ".");
  sh(dir, "commit", "-qm", "init");
  const forkSha = sh(dir, "rev-parse", "HEAD");
  sh(dir, "checkout", "-qb", "feat/x");
  write(dir, "b.ts", "export const b = 1;\n");
  sh(dir, "add", ".");
  sh(dir, "commit", "-qm", "b");
  return { dir, forkSha };
}

/** A fake `npx` that records its cwd and args, then answers like aislop. */
function fakeNpxBin(recordPath: string): string {
  const bin = mkdtempSync(path.join(tmpdir(), "aislop-bin-"));
  const npx = path.join(bin, "npx");
  writeFileSync(
    npx,
    "#!/bin/sh\n{\n  pwd\n  printf '%s\\n' \"$@\"\n} > \"$AISLOP_TEST_RECORD\"\necho \"score 91\"\nexit 3\n",
  );
  chmodSync(npx, 0o755);
  return bin;
}

function hostContext() {
  return { signal: new AbortController().signal } as unknown as Parameters<typeof host.handlers.scan>[1];
}

describe("host entry", () => {
  it("publishes the RPC contract", () => {
    expect(host.contract).toBe(hostContract);
  });

  it("scans the checkout against the branch base", async () => {
    const { dir, forkSha } = makeRepo();
    const recordPath = path.join(mkdtempSync(path.join(tmpdir(), "aislop-record-")), "record");
    const bin = fakeNpxBin(recordPath);
    const originalPath = process.env.PATH;
    process.env.PATH = `${bin}:${originalPath}`;
    process.env.AISLOP_TEST_RECORD = recordPath;
    try {
      const result = await host.handlers.scan(
        {
          directory: dir,
          scope: "branch",
          base: null,
          rootBranch: "main",
          verbose: false,
          json: false,
          include: [],
          exclude: [],
          timeoutMs: 60_000,
        },
        hostContext(),
      );
      expect(result).toEqual({ exitCode: 3, stdout: "score 91\n", stderr: "", base: { ref: "main", sha: forkSha } });
      const lines = readFileSync(recordPath, "utf8").split("\n");
      const cwd = lines[0];
      const args = lines.slice(1, -1);
      // `pwd` reports the physical path; /tmp is a symlink on macOS.
      expect(realpathSync(cwd ?? ".")).toBe(realpathSync(dir));
      expect(args).toEqual(["--yes", "aislop@latest", "scan", "--changes", "--base", forkSha, "."]);
    } finally {
      process.env.PATH = originalPath;
      delete process.env.AISLOP_TEST_RECORD;
    }
  });
});
