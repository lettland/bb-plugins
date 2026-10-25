import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { readFileSync } from "node:fs";

import {
  buildAgentConfiguration,
  buildAgentInstructions,
  rehydrateAgentContext,
} from "../src/configuration.mjs";
import {
  buildContainerPlan,
  isolationProbeRole,
} from "../src/container-plan.mjs";
import { describeOperations } from "../src/manifest.mjs";
import { prepareCommitOutputs } from "../src/container-scratch.mjs";
import { executeSearch } from "../src/runtime.mjs";
import {
  buildGitInvocation,
  buildRebaseRecoveryInvocation,
} from "../src/git-invocation.mjs";
import { buildRuntimeGitTool } from "../src/git-tool.mjs";
import { buildSearchInvocation } from "../src/git-invocation.mjs";
import { readPluginResource } from "../src/plugin-resource.mjs";
import { workspaceLockKey } from "../src/operation-locks.mjs";
import { executeGit } from "../src/execute-git.mjs";
import {
  buildRuntimeInvocation,
  buildRuntimeLogInvocation,
  executeRuntimeOperation,
  schedulePluginReload,
} from "../src/runtime-tool.mjs";
import {
  operationLockOptions,
  withQualityOperationLocks,
} from "../src/operation-locks.mjs";
import { threadReadLimits, readProjectThread } from "../src/thread-read.mjs";
import { containerPathFor } from "../src/isolation-scratch.mjs";
import { hostPathInContainer, validateWorkspace } from "../src/workspace.mjs";
import { assertAbsoluteContainerPath } from "../src/manifest-primitives.mjs";
import { manifestDigest, validateManifest } from "../src/manifest.mjs";

const fixtureManifestPath = new URL(
  "./fixtures/platform.bb-runtime.json",
  import.meta.url,
);
const fixtureManifestContent = readFileSync(fixtureManifestPath);
const fixtureManifestDigest = manifestDigest(fixtureManifestContent);
const manifest = validateManifest(
  JSON.parse(fixtureManifestContent.toString("utf8")),
);

function basePolicy(overrides = {}) {
  return {
    projectId: "proj_platform",
    trustedHostId: "host_vairogs",
    primaryRoot: "/workspace/platform",
    worktreeRoot: "/bb/worktrees",
    worktreeDirectoryName: "platform",
    gitCommonDir: "/workspace/platform/.git",
    containers: {
      go: "pform_dev_tracigo_go",
      sveltekit: "pform_dev_sveltekit",
      symfony: "pform_dev_zts",
    },
    dockerPath: "/usr/local/bin/docker",
    manifestSha256: fixtureManifestDigest,
    manifest,
    manifestDigest: fixtureManifestDigest,
    manifestStale: false,
    manifestError: null,
    ...overrides,
  };
}

function baseWorkspace(overrides = {}) {
  return {
    branchName: "bb/example",
    containerRoot: "/bb-worktrees/env_abc123/platform",
    environmentId: "env_abc123",
    hostRoot: "/bb/worktrees/env_abc123/platform",
    kind: "managed-worktree",
    ...overrides,
  };
}

const okResult = { stdout: "", stderr: "", code: 0, signal: null, overflow: false };
const memoryLocks = () => ({ lockAdapter: new Map() });

test("workspace validation denies primary provision, unmanaged, and stray worktrees", () => {
  const policy = basePolicy();
  const resolvedGitCommonDir = "/workspace/platform/.git";
  for (const [contextOverrides, resolvedEnvironmentPath, expected] of [
    [
      {
        environmentId: "env_primary",
        environmentPath: "/workspace/platform",
        workspaceProvisionType: "managed-worktree",
      },
      "/workspace/platform",
      /invalid provision type/,
    ],
    [
      {
        environmentId: "env_abc123",
        environmentPath: "/bb/worktrees/env_abc123/platform",
        workspaceProvisionType: "unmanaged",
      },
      "/bb/worktrees/env_abc123/platform",
      /not a managed worktree/,
    ],
    [
      {
        environmentId: "env_abc123",
        environmentPath: "/bb/worktrees/env_abc123/other",
        workspaceProvisionType: "managed-worktree",
      },
      "/bb/worktrees/env_abc123/other",
      /outside its assigned worktree/,
    ],
  ]) {
    assert.throws(
      () =>
        validateWorkspace({
          policy,
          context: {
            projectId: "proj_platform",
            hostId: "host_vairogs",
            ...contextOverrides,
          },
          resolvedEnvironmentPath,
          resolvedGitCommonDir,
        }),
      expected,
    );
  }
});

test("container roles without an installed name are denied at plan time", () => {
  const policy = basePolicy();
  assert.throws(
    () => buildContainerPlan({ ...policy, containers: {} }, baseWorkspace(), "go_vet"),
    /container role "go" is not installed/,
  );
  const smallManifest = validateManifest({
    version: 1,
    containers: {
      app: {
        service: "app",
        mounts: [{ host: "src", container: "/src" }],
      },
    },
  });
  assert.throws(
    () => isolationProbeRole(basePolicy({ manifest: smallManifest })),
    /isolation builder is not declared/,
  );
});

test("primary-only paths resolve through mounts and refuse unmounted escapes", () => {
  const policy = basePolicy();
  const primaryWorkspace = { ...baseWorkspace(), containerRoot: null };
  assert.equal(
    containerPathFor(policy, primaryWorkspace, "go", "src/go/main.go"),
    "/app/src/go/main.go",
  );
  for (const hostPath of ["/etc/passwd", "/bb/worktrees"]) {
    assert.throws(
      () => hostPathInContainer(policy, hostPath, "go"),
      /Shared runtime denied/,
      hostPath,
    );
  }
  assert.throws(
    () => hostPathInContainer(policy, policy.primaryRoot, "unknown-role"),
    /not declared/,
  );
  const smallManifest = validateManifest({
    version: 1,
    containers: {
      app: { service: "app", mounts: [{ host: "src", container: "/src" }] },
    },
  });
  assert.throws(
    () =>
      hostPathInContainer(
        basePolicy({ manifest: smallManifest }),
        "/workspace/platform/unmounted/file",
        "app",
      ),
    /is not mounted in container app/,
  );
});

test("targets are validated before a plan is built", () => {
  const policy = basePolicy();
  const workspace = baseWorkspace();
  for (const [target, expected] of [
    ["", /target is invalid/],
    ["a\0b", /target is invalid/],
    ["-flag", /target does not match/],
    ["x".repeat(501), /target is invalid/],
    [42, /target is invalid/],
  ]) {
    assert.throws(
      () => buildContainerPlan(policy, workspace, "symfony_unit", { target }),
      expected,
      JSON.stringify(target),
    );
  }
});

test("hardlink preparation skips a missing source and refuses unusable targets", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "tool-boundaries-hardlink-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runs = [];
  const run = async (invocation) => {
    runs.push(invocation);
    return okResult;
  };
  const hardlinkManifest = (source, target) =>
    validateManifest({
      version: 1,
      containers: {
        app: { service: "app", mounts: [{ host: ".", container: "/app" }] },
      },
      git: { prepareCommit: { hardlinks: [{ source, target }] } },
    });
  await prepareCommitOutputs(
    basePolicy({ manifest: hardlinkManifest("missing.md", "mirror.md") }),
    baseWorkspace({ hostRoot: root }),
    run,
  );
  assert.deepEqual(runs, [], "a missing hardlink source adds nothing");

  await writeFile(path.join(root, "existing.md"), "content\n");
  await writeFile(path.join(root, "blocker"), "a file\n");
  await assert.rejects(
    prepareCommitOutputs(
      basePolicy({ manifest: hardlinkManifest("existing.md", "blocker/child.md") }),
      baseWorkspace({ hostRoot: root }),
      run,
    ),
    { code: "ENOTDIR" },
  );
});

test("git invocations cover diff, log, path list limits, and recovery denies", () => {
  assert.deepEqual(buildGitInvocation("/ws", { operation: "diff" }).args.at(-2), "diff");
  assert.deepEqual(
    buildGitInvocation("/ws", { operation: "diff", staged: true }).args.slice(-3),
    ["diff", "--cached", "--"],
  );
  assert.deepEqual(
    buildGitInvocation("/ws", { operation: "log" }).args.slice(-4),
    ["log", "-20", "--oneline", "--decorate"],
  );
  assert.throws(
    () => buildGitInvocation("/ws", { operation: "add" }),
    /path list is missing or invalid/,
  );
  assert.throws(
    () => buildGitInvocation("/ws", { operation: "add", paths: [] }),
    /path list is missing or invalid/,
  );
  assert.throws(
    () =>
      buildGitInvocation("/ws", {
        operation: "add",
        paths: Array.from({ length: 101 }, (_, index) => `f${index}`),
      }),
    /path list is missing or invalid/,
  );
  assert.throws(
    () => buildRebaseRecoveryInvocation(baseWorkspace(), "rebase_rewind"),
    /unsupported rebase recovery operation/,
  );
});

test("a managed branch mismatch aborts the primary rebase preflight", async () => {
  const policy = basePolicy();
  const workspace = baseWorkspace();
  let stage = 0;
  const run = async () => {
    stage += 1;
    if (stage === 1) {
      return { ...okResult, stdout: "master\n" };
    }
    if (stage === 2) {
      return { ...okResult, stdout: "bb/somewhere-else\n" };
    }
    return okResult;
  };
  await assert.rejects(
    executeGit(policy, workspace, { operation: "rebase_primary" }, { run, ...memoryLocks() }),
    /branch does not match its authorized BB branch/,
  );
});

test("search passes missing paths to ripgrep instead of denying them", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "tool-boundaries-search-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const policy = basePolicy({
    manifest: validateManifest({
      version: 1,
      containers: {
        app: { service: "app", mounts: [{ host: ".", container: "/app" }] },
      },
      search: { defaultPath: "src" },
    }),
  });
  await assert.rejects(
    executeSearch(
      policy,
      baseWorkspace({ hostRoot: root }),
      { query: "needle", path: "missing-dir" },
    ),
    (error) => {
      // The failure must come from ripgrep itself: its error exit and its
      // own stderr about the missing path, or a spawn miss when rg is not
      // installed. Never a tool-boundary denial.
      if (/Shared runtime denied/.test(error.message)) {
        return false;
      }
      if (error.result) {
        return (
          error.result.signal === null &&
          error.result.code > 1 &&
          /No such file or directory/.test(error.result.stderr)
        );
      }
      return error.code === "ENOENT";
    },
    "the missing search path reached ripgrep",
  );
});

test("runtime operations deny unauthorized workspaces and broken policies", async () => {
  const policy = basePolicy();
  await assert.rejects(
    executeRuntimeOperation(policy, null, "status"),
    /authorized workspace is missing/,
  );
  await assert.rejects(
    executeRuntimeOperation(
      basePolicy({ composeProject: "bad project" }),
      baseWorkspace(),
      "diagnose",
      { run: async () => okResult },
    ),
    /Compose project is invalid/,
  );
  await assert.rejects(
    executeRuntimeOperation(basePolicy({ manifest: null }), baseWorkspace(), "ensure", {
      run: async () => okResult,
      ...memoryLocks(),
    }),
    /project manifest is unavailable/,
  );
  const foreignLifecycle = basePolicy({
    manifest: { lifecycle: { ensure: ["python3.11", "scripts/run.py"] } },
  });
  await assert.rejects(
    executeRuntimeOperation(foreignLifecycle, baseWorkspace(), "ensure", {
      run: async () => okResult,
      ...memoryLocks(),
    }),
    /uses an unsupported interpreter/,
  );
});

test("runtime status surfaces reload status read failures other than ENOENT", async () => {
  const policy = basePolicy();
  await assert.rejects(
    executeRuntimeOperation(policy, baseWorkspace(), "status", {
      run: async () => okResult,
      readFile: async () => {
        const error = new Error("denied");
        error.code = "EACCES";
        throw error;
      },
    }),
    { code: "EACCES" },
  );
});

test("runtime logs report an empty compose project without container reads", async () => {
  const runs = [];
  const results = await executeRuntimeOperation(
    basePolicy({ composeProject: "pform_dev" }),
    baseWorkspace(),
    "logs",
    {
      run: async (invocation) => {
        runs.push(invocation);
        return okResult;
      },
    },
  );
  assert.equal(runs.length, 1, "only the discovery invocation ran");
  assert.match(
    results.at(-1).stdout,
    /No containers exist for the configured Compose project/,
  );
});

test("runtime invocations are bounded to fixed operations", () => {
  const policy = basePolicy();
  assert.throws(() => buildRuntimeInvocation(policy, "reboot"), /unsupported runtime operation/);
  assert.equal(buildRuntimeInvocation(policy, "sync").command, process.execPath);
  assert.throws(
    () => buildRuntimeLogInvocation(policy, "bad name"),
    /diagnostic container name is invalid/,
  );
});

test("the git tool validates fast-forward plans before execution", async () => {
  const calls = [];
  const tool = buildRuntimeGitTool({
    workspaceFor: async () => ({ policy: basePolicy(), workspace: baseWorkspace() }),
    executeGitOperation: async (_policy, _workspace, params) => {
      calls.push(params.operation);
      return okResult;
    },
  });
  const result = await tool.execute(
    { operation: "fast_forward_primary" },
    { threadId: "thr_x", signal: undefined },
  );
  assert.deepEqual(calls, ["fast_forward_primary"]);
  assert.equal(typeof result, "string");
  const primaryTool = buildRuntimeGitTool({
    workspaceFor: async () => ({
      policy: basePolicy(),
      workspace: baseWorkspace({ kind: "primary", containerRoot: null }),
    }),
    executeGitOperation: async () => okResult,
  });
  await assert.rejects(
    primaryTool.execute(
      { operation: "fast_forward_primary" },
      { threadId: "thr_x", signal: undefined },
    ),
    /managed worktree/,
  );
});

test("thread reads deny oversized metadata and invalid output payloads", async () => {
  const policy = basePolicy();
  const hugeTitle = "x".repeat(threadReadLimits.resultBytes);
  const hugeThread = {
    async get() {
      return {
        id: "thr_big",
        projectId: "proj_platform",
        visibility: "visible",
        title: hugeTitle,
      };
    },
  };
  await assert.rejects(
    readProjectThread(
      policy,
      { threads: { ...hugeThread, async output() { return { output: null }; } } },
      { threadId: "thr_big" },
    ),
    /exceeds the result limit/,
  );
  await assert.rejects(
    readProjectThread(
      policy,
      { threads: { ...hugeThread, async output() { return { output: "kept" }; } } },
      { threadId: "thr_big" },
    ),
    /exceeds the result limit/,
  );
  await assert.rejects(
    readProjectThread(
      policy,
      {
        threads: {
          async get() {
            return { id: "thr_type", projectId: "proj_platform", visibility: "visible" };
          },
          async output() {
            return { output: 42 };
          },
        },
      },
      { threadId: "thr_type" },
    ),
    /invalid output response/,
  );
});

test("thread reads truncate long plain output at the byte limit", async () => {
  const policy = basePolicy();
  const output = "a".repeat(threadReadLimits.resultBytes + 10);
  const serialized = await readProjectThread(
    policy,
    {
      threads: {
        async get() {
          return { id: "thr_long", projectId: "proj_platform", visibility: "visible" };
        },
        async output() {
          return { output };
        },
      },
    },
    { threadId: "thr_long" },
  );
  const result = JSON.parse(serialized);
  assert.equal(result.outputTruncated, true);
  assert.ok(Buffer.byteLength(serialized, "utf8") <= threadReadLimits.resultBytes);
});

test("agent instructions truncate to the hard limit", () => {
  const policy = basePolicy({
    manifest: { name: "x".repeat(5000), operations: {}, lifecycle: {} },
  });
  const text = buildAgentInstructions(policy);
  assert.equal(text.length, 4000);
  assert.ok(text.endsWith("…"));
});

test("agent context rehydration denies lookup failures and incomplete threads", async () => {
  const policy = basePolicy();
  const registry = { policyFor: (id) => (id === "proj_platform" ? policy : null) };
  assert.equal(
    await rehydrateAgentContext(
      registry,
      {
        threads: {
          async get() {
            throw new Error("lookup failed");
          },
        },
      },
      "thr_valid1",
    ),
    null,
  );
  assert.equal(
    await rehydrateAgentContext(
      registry,
      {
        threads: {
          async get() {
            return null;
          },
        },
      },
      "thr_valid2",
    ),
    null,
  );
  assert.equal(
    await rehydrateAgentContext(
      registry,
      {
        threads: {
          async get() {
            return { projectId: "proj_platform", environmentId: "env_abc123" };
          },
        },
        environments: {
          async get() {
            throw new Error("environment lookup failed");
          },
        },
      },
      "thr_valid3",
    ),
    null,
  );
});

test("plugin resources deny relative and missing paths", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "tool-boundaries-resource-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(readPluginResource({ path: "relative/path.md" }), /bounded absolute path/);
  await assert.rejects(
    readPluginResource({ path: `/${"x".repeat(5000)}` }),
    /bounded absolute path/,
  );
  await assert.rejects(
    readPluginResource({ path: path.join(root, "absent.md") }),
    /resource does not exist/,
  );
});

test("workspace lock keys require a valid environment id", () => {
  assert.throws(
    () => workspaceLockKey(basePolicy(), baseWorkspace({ environmentId: "bad id" })),
    /workspace environment id is invalid/,
  );
});

test("search queries refuse embedded NUL and oversize input", () => {
  assert.throws(
    () => buildSearchInvocation("/ws", { query: "a\0b" }),
    /search query is invalid/,
  );
  assert.throws(
    () => buildSearchInvocation("/ws", { query: "x".repeat(1_001) }),
    /search query is invalid/,
  );
});

test("prepareCommitOutputs tolerates missing generator executables by exit code", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "tool-boundaries-generator-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const generatorManifest = () =>
    validateManifest({
      version: 1,
      containers: {
        app: { service: "app", mounts: [{ host: ".", container: "/app" }] },
      },
      isolation: { builder: "app" },
      git: {
        prepareCommit: {
          generators: [
            {
              container: "app",
              argv: ["php", "gen.php"],
              stages: ["generated.json"],
              tolerateMissingExecutable: true,
            },
          ],
        },
      },
    });
  const policy = basePolicy({ manifest: generatorManifest(), containers: { app: "fixture_app" } });
  const workspace = baseWorkspace({ hostRoot: root });
  const missing127 = Object.assign(new Error("command failed with exit 127"), {
    result: { code: 127, signal: null, stdout: "", stderr: "bash: php: command not found", overflow: false },
  });
  const wrong127 = Object.assign(new Error("command failed with exit 127"), {
    result: { code: 127, signal: null, stdout: "", stderr: "something else failed", overflow: false },
  });
  const missing126 = Object.assign(new Error("command failed with exit 126"), {
    result: { code: 126, signal: null, stdout: undefined, stderr: "not executable", overflow: false },
  });
  const silent127 = Object.assign(new Error("command failed with exit 127"), {
    result: { code: 127, signal: null, stdout: undefined, stderr: undefined, overflow: false },
  });
  const runs = [];
  await prepareCommitOutputs(policy, workspace, async (invocation) => {
    runs.push(invocation);
    throw missing127;
  });
  assert.equal(runs.length, 1, "the tolerated missing executable skips the generator");
  await assert.rejects(
    prepareCommitOutputs(policy, workspace, async () => {
      throw wrong127;
    }),
    (error) => error.result?.code === 127 && error.result.stderr === "something else failed",
    "a 127 exit without a not-found message is not tolerated",
  );
  await assert.rejects(
    prepareCommitOutputs(policy, workspace, async () => {
      throw missing126;
    }),
    (error) => error.result?.code === 126,
    "a 126 exit without a not-found message is not tolerated",
  );
  await assert.rejects(
    prepareCommitOutputs(policy, workspace, async () => {
      throw silent127;
    }),
    (error) => error.result?.code === 127,
    "a 127 exit without any stream content is not tolerated",
  );
});

test("hardlink preparation refuses unusable sources", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "tool-boundaries-hardlink2-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "blocker"), "file\n");
  const policy = basePolicy({
    manifest: validateManifest({
      version: 1,
      containers: {
        app: { service: "app", mounts: [{ host: ".", container: "/app" }] },
      },
      git: {
        prepareCommit: {
          hardlinks: [{ source: "blocker/child.md", target: "out.md" }],
        },
      },
    }),
  });
  await assert.rejects(
    prepareCommitOutputs(policy, baseWorkspace({ hostRoot: root }), async () => ({ ...okResult })),
    { code: "ENOTDIR" },
  );
});

test("an operation target description and optionality render in listings", () => {
  const document = {
    version: 1,
    containers: {
      app: { service: "app", mounts: [{ host: ".", container: "/app" }] },
    },
    isolation: { builder: "app" },
    operations: {
      optional_unit: {
        container: "app",
        argv: ["run", "${target}"],
        target: { pattern: "^[a-z]+$", required: false },
      },
      described_unit: {
        container: "app",
        argv: ["run", "${target}"],
        target: { pattern: "^[a-z]+$", required: true, description: "a component" },
      },
    },
  };
  const listing = describeOperations(validateManifest(document));
  assert.match(
    listing[0],
    /described_unit \(requires target matching .*: a component\)$/,
  );
  assert.match(listing[1], /^optional_unit \(accepts target matching/);
});

test("the probe falls back to the builder when no probe role is declared", () => {
  const policy = basePolicy({
    manifest: validateManifest({
      version: 1,
      containers: {
        app: { service: "app", mounts: [{ host: ".", container: "/app" }] },
      },
      isolation: { builder: "app" },
    }),
  });
  assert.equal(isolationProbeRole(policy), "app");
});

test("absolute container paths keep the root unchanged", () => {
  assert.equal(assertAbsoluteContainerPath("/", "root"), "/");
});

test("stale manifests append the re-pin instruction", () => {
  const text = buildAgentInstructions(
    basePolicy({ manifest: { operations: {}, lifecycle: {} }, manifestStale: true }),
  );
  assert.match(text, /manifest changed after installation/);
});

test("agent instructions fall back through the project label chain", () => {
  const withoutName = buildAgentInstructions(
    basePolicy({ manifest: { operations: {}, lifecycle: {} } }),
  );
  assert.match(withoutName, /^This platform thread /);
  const withoutAnything = buildAgentInstructions(
    basePolicy({ manifest: undefined, worktreeDirectoryName: undefined }),
  );
  assert.match(withoutAnything, /^This this project thread /);
});

test("agent configuration denies contexts without a project", () => {
  const policy = basePolicy();
  const registry = { policyFor: (id) => (id === "proj_platform" ? policy : null) };
  const denied = buildAgentConfiguration(registry, {
    thread: { id: "thr_noproj" },
    host: { id: "host_vairogs" },
    environment: {
      id: "env_abc123",
      path: "/bb/worktrees/env_abc123/platform",
      workspaceProvisionType: "managed-worktree",
      branchName: "bb/example",
    },
  });
  assert.deepEqual(denied, { policy: null, tools: [], context: null });
});

test("a root mount resolves the primary root itself to the mount point", () => {
  const policy = basePolicy();
  const primaryWorkspace = { ...baseWorkspace(), containerRoot: null };
  assert.equal(containerPathFor(policy, primaryWorkspace, "go", "."), "/app");
  assert.equal(
    hostPathInContainer(policy, path.posix.join(policy.primaryRoot, "src/sveltekit"), "sveltekit"),
    "/app",
  );
  assert.equal(
    hostPathInContainer(
      policy,
      path.posix.join(policy.primaryRoot, "src/sveltekit/packages/api-client"),
      "sveltekit",
    ),
    "/app/packages/api-client",
  );
});

test("worktree lock waits report readers and fall back through the owner label", async () => {
  const lockAdapter = new Map();
  const events = [];
  let releaseReader;
  const readerGate = new Promise((resolve) => {
    releaseReader = resolve;
  });
  const primaryWorkspace = { kind: "primary" };
  const reader = withQualityOperationLocks(
    basePolicy(),
    { ...primaryWorkspace, environmentId: "env_reader" },
    "go_tests",
    async () => {
      events.push("reader:start");
      await readerGate;
      events.push("reader:end");
    },
    { lockAdapter },
    "shared",
  );
  await new Promise((resolve) => setImmediate(resolve));
  const messages = [];
  const waiter = withQualityOperationLocks(
    basePolicy(),
    primaryWorkspace,
    "go_vet",
    async () => "single-result",
    { lockAdapter, onLockWait: (message) => messages.push(message) },
    "shared",
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(messages[0], /env_reader running go_tests/);
  releaseReader();

  // A workspace with only kind labels its owner by kind; a workspace with
  // neither falls back to "primary" (operationLockOptions is reachable with
  // workspaces that skip workspaceLockKey validation).
  const byKind = operationLockOptions({}, { kind: "primary" }, "go_vet", "shared", "lock");
  assert.equal(byKind.owner.environmentId, "primary");
  assert.equal(byKind.owner.operation, "go_vet");
  assert.equal(byKind.label, "lock");
  const bare = operationLockOptions({}, {}, "go_vet", "shared", "lock");
  assert.equal(bare.owner.environmentId, "primary");
});

test("the plan compiler keeps its guarantees on manifests that skip validation", () => {
  // A policy object can carry a manifest that never went through
  // validateManifest; the compiler must still behave deterministically.
  const raw = {
    containers: { app: { service: "app", mounts: [{ host: ".", container: "/app" }] } },
    scratch: {},
    operations: {
      targetless_run: {
        kind: "single",
        step: {
          kind: "container",
          container: "app",
          cwd: ".",
          argv: ["run"],
          environment: {},
          failOnStdout: false,
          usesTarget: false,
        },
        target: null,
      },
      host_python: {
        kind: "single",
        step: {
          kind: "host",
          interpreter: "python3.11",
          script: "scripts/run.py",
          argv: [],
          environment: {},
          containers: [],
          usesTarget: false,
        },
        target: null,
      },
      host_target: {
        kind: "single",
        step: {
          kind: "host",
          interpreter: "bash",
          script: "scripts/go.sh",
          argv: [],
          environment: {},
          containers: [],
          usesTarget: false,
        },
        target: { pattern: /^x$/, patternSource: "^x$", required: false, variants: null },
      },
      container_target: {
        kind: "single",
        step: {
          kind: "container",
          container: "app",
          cwd: ".",
          argv: ["run"],
          environment: {},
          failOnStdout: false,
          usesTarget: false,
        },
        target: { pattern: /^x$/, patternSource: "^x$", required: false, variants: null },
      },
    },
  };
  const policy = basePolicy({ manifest: raw, containers: { app: "fixture_app" } });
  const workspace = baseWorkspace();

  const [containerPlan] = buildContainerPlan(policy, workspace, "container_target", { target: "x" });
  assert.deepEqual(containerPlan.args.at(-1), "x", "the unused target is appended");

  const [hostPlan] = buildContainerPlan(policy, workspace, "host_target", { target: "x" });
  assert.deepEqual(hostPlan.args.at(-1), "x", "the unused target is appended to the host step");
  assert.equal(hostPlan.command, "/bin/bash");

  assert.throws(
    () => buildContainerPlan(policy, workspace, "host_python"),
    /unsupported host interpreter "python3.11"/,
  );
});
