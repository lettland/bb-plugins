import { describe, expect, it } from "vitest";
import { createFakePluginHost, makeThreadResponse, type CreateFakePluginHostOptions } from "@get-bb/plugin-sdk/testing";
import plugin from "./server.js";

const SHA = "0123456789abcdef0123456789abcdef01234567";

interface Setup {
  environmentId?: string | null;
  env?: { hostId: string; path: string | null; mergeBaseBranch: string | null; defaultBranch: string | null };
  primaryHostId?: string | null;
  hostResult?: unknown;
}

async function setup(options: Setup = {}) {
  const env = options.env ?? {
    hostId: "host-thread",
    path: "/work/repo",
    mergeBaseBranch: null,
    defaultBranch: "master",
  };
  const sdk: CreateFakePluginHostOptions["sdk"] = {
    threads: {
      get: async (args: { threadId: string }) => ({
        ...makeThreadResponse({ id: args.threadId }),
        environmentId: options.environmentId === undefined ? "env-1" : options.environmentId,
      }),
    },
    environments: {
      get: async () => env,
    },
    system: {
      config: async () => ({ primaryHostId: options.primaryHostId === undefined ? "host-local" : options.primaryHostId }),
    },
  } as unknown as CreateFakePluginHostOptions["sdk"];
  const fake = createFakePluginHost({
    pluginId: "aislop",
    sdk,
    experimental_callHostRpc: () =>
      options.hostResult ?? { exitCode: 1, stdout: "score 88\n", stderr: "", base: { ref: "origin/master", sha: SHA } },
  });
  await plugin(fake.bb);
  return fake;
}

describe("bb aislop scan", () => {
  it("scans the thread's checkout on the thread's machine against its root branch", async () => {
    const { harness } = await setup();
    const result = await harness.runCli(["scan"], { threadId: "thr-1" });
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("score 88\n");
    expect(result.stderr).toBe(
      "aislop: scanning changes since 0123456789 (merge-base of HEAD and origin/master), committed or not in /work/repo\n",
    );
    expect(harness.experimental_hostRpcCalls).toEqual([
      {
        method: "scan",
        hostId: "host-thread",
        signal: undefined,
        input: {
          directory: "/work/repo",
          scope: "branch",
          base: null,
          rootBranch: "master",
          verbose: false,
          json: false,
          include: [],
          exclude: [],
          timeoutMs: 15 * 60_000,
        },
      },
    ]);
  });

  it("prefers the environment's merge-base branch and the caller's cwd", async () => {
    const { harness } = await setup({
      env: { hostId: "host-thread", path: "/work/repo", mergeBaseBranch: "develop", defaultBranch: "master" },
    });
    await harness.runCli(["scan", "packages/api"], { threadId: "thr-1", cwd: "/work/repo/sub" });
    expect(harness.experimental_hostRpcCalls[0]?.input).toMatchObject({
      directory: "/work/repo/sub/packages/api",
      rootBranch: "develop",
    });
  });

  it("drops bb's root branch when scanning a directory outside the thread's checkout", async () => {
    const { harness } = await setup();
    await harness.runCli(["scan"], { threadId: "thr-1", cwd: "/work/repo-other" });
    await harness.runCli(["scan", "../other"], { threadId: "thr-1", cwd: "/work/repo" });
    expect(harness.experimental_hostRpcCalls.map((call) => call.input)).toMatchObject([
      { directory: "/work/repo-other", rootBranch: null },
      { directory: "/work/other", rootBranch: null },
    ]);
  });

  it("passes scope, base, filters, verbosity, json and timeout through", async () => {
    const { harness } = await setup({ hostResult: { exitCode: 0, stdout: "{}", stderr: "", base: null } });
    const result = await harness.runCli(
      ["scan", "--scope", "all", "--include", "src,lib", "--exclude", "dist", "-d", "--json", "--timeout", "2m"],
      { cwd: "/elsewhere" },
    );
    expect(result.stderr).toBe("aislop: scanning the whole directory in /elsewhere\n");
    const [call] = harness.experimental_hostRpcCalls;
    expect(call?.hostId).toBe("host-local");
    expect(call?.input).toMatchObject({
      directory: "/elsewhere",
      scope: "all",
      rootBranch: null,
      include: ["src", "lib"],
      exclude: ["dist"],
      verbose: true,
      json: true,
      timeoutMs: 2 * 60_000,
    });
  });

  it("leaves off the header when the host could not resolve a base", async () => {
    const { harness } = await setup({
      hostResult: { exitCode: 2, stdout: "", stderr: "Unknown ref: nope\n", base: null },
    });
    const result = await harness.runCli(["scan", "--base", "nope"], { threadId: "thr-1" });
    expect(result).toMatchObject({ exitCode: 2, stderr: "Unknown ref: nope\n" });
  });

  it("rejects --base outside the branch scope", async () => {
    const { harness } = await setup();
    const result = await harness.runCli(["scan", "--scope", "changes", "--base", "main"], { threadId: "thr-1" });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("--base only applies to --scope branch");
    expect(harness.experimental_hostRpcCalls).toEqual([]);
  });

  it("falls back to the local machine for a thread with no environment", async () => {
    const { harness } = await setup({ environmentId: null });
    await harness.runCli(["scan"], { threadId: "thr-1", cwd: "/tmp/x" });
    expect(harness.experimental_hostRpcCalls[0]).toMatchObject({
      hostId: "host-local",
      input: { directory: "/tmp/x", rootBranch: null },
    });
  });

  it("needs a directory when there is no cwd or thread", async () => {
    const { harness } = await setup();
    const relative = await harness.runCli(["scan", "repo"], {});
    expect(relative.stderr).toContain("No working directory to scan");
    const absolute = await harness.runCli(["scan", "/abs/repo"], {});
    expect(absolute.exitCode).toBe(1);
    expect(harness.experimental_hostRpcCalls.map((call) => (call.input as { directory: string }).directory)).toEqual([
      "/abs/repo",
    ]);
  });

  it("explains a server with no local machine", async () => {
    const { harness } = await setup({ primaryHostId: null });
    const result = await harness.runCli(["scan"], { cwd: "/tmp/x" });
    expect(result.stderr).toContain("No machine to run the scan on");
    expect(harness.experimental_hostRpcCalls).toEqual([]);
  });
});
