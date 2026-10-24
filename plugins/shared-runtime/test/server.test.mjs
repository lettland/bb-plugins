import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// The plugin resolves its default runtime root and skill roots through
// homedir(); point HOME at a fixture before anything is imported so the test
// never touches the real ~/.bb.
const fixtureHome = await realpath(await mkdtemp(path.join(tmpdir(), "shared-runtime-server-home-")));
const originalHome = process.env.HOME;
const originalPath = process.env.PATH;
process.env.HOME = fixtureHome;
test.after(() => {
  process.env.HOME = originalHome;
  process.env.PATH = originalPath;
  delete process.env.FAKE_APP_ROOT;
});

const gitEnvironment = {
  ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_"))),
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
};

async function git(cwd, ...args) {
  return execFileAsync("git", ["-C", cwd, ...args], { env: gitEnvironment });
}

const manifestDocument = {
  version: 1,
  name: "Server Fixture",
  isolation: { builder: "app", probe: "app" },
  containers: {
    app: { service: "app", root: ".", mounts: [{ host: ".", container: "/app" }] },
  },
  scratch: {},
  search: { defaultPath: "." },
  operations: {
    check: { container: "app", argv: ["echo", "checked"] },
  },
};

const fakeDockerSource = `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args.includes("build")) {
  const output = args[args.indexOf("-o") + 1].replace("/app/", process.env.FAKE_APP_ROOT + "/");
  fs.writeFileSync(output, "#!/bin/sh\\n", { mode: 0o755 });
}
process.exit(0);
`;

const fakeRgSource = `#!${process.execPath}
process.stdout.write("src/needle.txt:1:needle\\n");
process.exit(0);
`;

async function waitFor(predicate, label, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting for ${label}`);
}

const fixtureRoot = await realpath(await mkdtemp(path.join(tmpdir(), "shared-runtime-server-")));
const bin = path.join(fixtureRoot, "bin");
const primaryRoot = path.join(fixtureRoot, "primary");
const worktreeRoot = path.join(fixtureRoot, "worktrees");
const worktreePath = path.join(worktreeRoot, "env_abc123", "platform");
const runtimeRoot = path.join(fixtureHome, ".bb", "shared-runtime");
const projectsRoot = path.join(runtimeRoot, "projects");
await mkdir(bin, { recursive: true });
await mkdir(primaryRoot, { recursive: true });
await mkdir(worktreeRoot, { recursive: true });
await mkdir(projectsRoot, { recursive: true, mode: 0o700 });
await chmod(runtimeRoot, 0o700);
await chmod(projectsRoot, 0o700);

await writeFile(path.join(bin, "docker"), fakeDockerSource, { mode: 0o755 });
await writeFile(path.join(bin, "rg"), fakeRgSource, { mode: 0o755 });
process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`;
process.env.FAKE_APP_ROOT = primaryRoot;

await writeFile(path.join(primaryRoot, ".bb-runtime.json"), JSON.stringify(manifestDocument));
await git(primaryRoot, "init", "--quiet");
await git(primaryRoot, "config", "user.name", "Server Fixture");
await git(primaryRoot, "config", "user.email", "server-fixture@example.invalid");
await git(primaryRoot, "add", ".bb-runtime.json");
await git(primaryRoot, "commit", "--quiet", "-m", "fixture");
await git(primaryRoot, "worktree", "add", "--quiet", worktreePath, "-b", "bb/example");


const { createHash } = await import("node:crypto");
const { manifestDigest, validateManifest } = await import("../src/manifest.mjs");
const { ensureIsolationLauncher } = await import("../src/runtime.mjs");
const manifestContent = JSON.stringify(manifestDocument);
const digest = manifestDigest(Buffer.from(manifestContent));
const policyPath = path.join(projectsRoot, "proj_platform.json");
await writeFile(
  policyPath,
  `${JSON.stringify({
    projectId: "proj_platform",
    trustedHostId: "host_server",
    primaryRoot,
    worktreeRoot,
    worktreeDirectoryName: "platform",
    gitCommonDir: path.join(primaryRoot, ".git"),
    dockerPath: path.join(bin, "docker"),
    manifestSha256: digest,
    manifestPath: path.join(primaryRoot, ".bb-runtime.json"),
    containers: { app: "server_fixture_app" },
  })}\n`,
  { mode: 0o600 },
);

const threadLookups = [];
const environmentLookups = [];
const sdk = {
  threads: {
    async get({ threadId }) {
      threadLookups.push(threadId);
      if (threadId === "thr_unknown") {
        return {
          id: threadId,
          projectId: "proj_other",
          environmentId: "env_abc123",
          visibility: "visible",
        };
      }
      if (threadId === "thr_broken") {
        return {
          id: threadId,
          projectId: "proj_broken",
          environmentId: "env_broken",
          visibility: "visible",
        };
      }
      return {
        id: threadId,
        projectId: "proj_platform",
        environmentId: "env_abc123",
        visibility: "visible",
        title: "Server fixture thread",
        status: "idle",
        providerId: "claude-code",
        archivedAt: null,
        updatedAt: 1,
      };
    },
    async output() {
      return { output: "Shared server output." };
    },
  },
  environments: {
    async get({ environmentId }) {
      environmentLookups.push(environmentId);
      return {
        id: environmentId,
        projectId: environmentId === "env_broken" ? "proj_broken" : "proj_platform",
        hostId: "host_server",
        path: primaryRoot,
        workspaceProvisionType: "unmanaged",
        branchName: "master",
      };
    },
  },
};
const registeredTools = [];
let configureCallback = null;
const disposeCallbacks = [];
const registryWarnings = [];
const bb = {
  log: { warn: (message) => registryWarnings.push(message) },
  sdk,
  agents: {
    registerTool: (tool) => registeredTools.push(tool),
    configure: (callback) => {
      configureCallback = callback;
    },
  },
  onDispose: (callback) => disposeCallbacks.push(callback),
};

await writeFile(
  path.join(projectsRoot, "proj_broken.json"),
  `${JSON.stringify({
    projectId: "proj_broken",
    trustedHostId: "host_server",
    primaryRoot,
    worktreeRoot,
    worktreeDirectoryName: "platform",
    gitCommonDir: path.join(primaryRoot, ".git"),
    dockerPath: path.join(bin, "docker"),
    manifestSha256: digest,
    manifestPath: path.join(primaryRoot, "absent-manifest.json"),
    containers: { app: "server_fixture_app" },
  })}\n`,
  { mode: 0o600 },
);

const { default: plugin } = await import("../server.ts");
const { RUNTIME_TOOL_ALIASES } = await import("../src/configuration.mjs");

await plugin(bb);

const toolsByName = new Map(registeredTools.map((tool) => [tool.name, tool]));
const authorizedContext = {
  thread: { id: "thr_cache" },
  project: { id: "proj_platform" },
  host: { id: "host_server" },
  environment: {
    id: "env_abc123",
    path: worktreePath,
    workspaceProvisionType: "managed-worktree",
    branchName: "bb/example",
  },
};


test("the plugin registers every runtime tool with an alias and wires configuration", () => {
  const baseNames = registeredTools
    .map((tool) => tool.name)
    .filter(
      (name) =>
        name.startsWith("runtime_") &&
        !Object.values(RUNTIME_TOOL_ALIASES).includes(name),
    );
  // Canary for the alias guard in registerRuntimeTool: more than one runtime
  // tool is registered and every base name must have an alias.
  assert.ok(baseNames.length > 1, "the plugin registers several runtime tools");
  for (const name of baseNames) {
    assert.ok(name in RUNTIME_TOOL_ALIASES, `${name} must have a registered alias`);
    assert.ok(toolsByName.has(RUNTIME_TOOL_ALIASES[name]), `${name} alias is registered`);
  }

  const configured = configureCallback(authorizedContext);
  assert.equal(configured.tools.length, registeredTools.length);
  assert.match(configured.instructions, /runtime_container/);
  assert.match(configured.instructions, /Server Fixture/);

  const denied = configureCallback({
    thread: { id: "thr_other" },
    project: { id: "proj_other" },
    host: { id: "host_server" },
    environment: authorizedContext.environment,
  });
  assert.deepEqual(denied, { tools: [], skills: [] });
});

test("the container tool denies unknown and undeclared operations", async () => {
  const tool = toolsByName.get("runtime_container");
  await assert.rejects(
    tool.execute({ operation: "Not-A-Name" }, { threadId: "thr_cache", signal: undefined }),
    /unsupported container operation/,
  );
  await assert.rejects(
    tool.execute({ operation: "not_declared" }, { threadId: "thr_cache", signal: undefined }),
    /not declared by this project/,
  );
});

test("the container tool runs a declared operation through the shared runtime", async () => {
  const tool = toolsByName.get("runtime_container");
  const result = await tool.execute(
    { operation: "check" },
    { threadId: "thr_cache", signal: undefined },
  );
  assert.equal(result, "Completed successfully with no output.");
  const launcher = await lstat(path.join(primaryRoot, ".bb-runtime", "landlock-run"));
  assert.equal(launcher.isFile(), true);
});

test("a registration with an unreadable manifest denies undeclared operations", async () => {
  const tool = toolsByName.get("runtime_container");
  await assert.rejects(
    tool.execute({ operation: "check" }, { threadId: "thr_broken", signal: undefined }),
    /not declared by this project/,
  );
});

test("the search tool returns workspace-confined ripgrep output", async () => {
  const tool = toolsByName.get("runtime_search");
  const result = await tool.execute(
    { query: "needle" },
    { threadId: "thr_cache", signal: undefined },
  );
  assert.equal(result, "src/needle.txt:1:needle");
});

test("the thread tool reads a bounded same-project output once per thread", async () => {
  const tool = toolsByName.get("runtime_thread");
  const first = await tool.execute({ threadId: "thr_fresh" }, { threadId: "thr_fresh", signal: undefined });
  const second = await tool.execute({ threadId: "thr_fresh" }, { threadId: "thr_fresh", signal: undefined });
  assert.deepEqual(JSON.parse(first).output, "Shared server output.");
  assert.deepEqual(JSON.parse(second).output, "Shared server output.");
  assert.equal(
    environmentLookups.filter((environmentId) => environmentId === "env_abc123").length,
    1,
    "the authorized context is rehydrated once and cached per thread",
  );
  await assert.rejects(
    tool.execute({ threadId: "thr_unknown" }, { threadId: "thr_unknown", signal: undefined }),
    /was not authorized for a registered project/,
  );
});

test("the ops tool reports container status through the fixed docker invocation", async () => {
  const tool = toolsByName.get("runtime_ops");
  const result = await tool.execute({ operation: "status" }, { threadId: "thr_cache", signal: undefined });
  assert.equal(result, "Completed successfully with no output.");
});

test("the skill resource tool reads anchored files from the agent home", async () => {
  const skillRoot = path.join(fixtureHome, ".codex", "skills", "sample");
  const reference = path.join(skillRoot, "references", "guide.md");
  await mkdir(path.dirname(reference), { recursive: true });
  await writeFile(path.join(skillRoot, "SKILL.md"), "# Sample\n");
  await writeFile(reference, "trusted guide\n");
  const tool = toolsByName.get("runtime_skill_resource");
  const content = await tool.execute({ path: reference }, { threadId: "thr_cache", signal: undefined });
  assert.equal(content, "trusted guide\n");
  const outside = path.join(fixtureRoot, "outside.md");
  await writeFile(outside, "secret\n");
  await assert.rejects(
    tool.execute({ path: outside }, { threadId: "thr_cache", signal: undefined }),
    /outside installed agent skill roots/,
  );
});

test("git tool runs typed status in the authorized worktree", async () => {
  const tool = toolsByName.get("runtime_git");
  const result = await tool.execute(
    { operation: "status" },
    { threadId: "thr_cache", signal: undefined },
  );
  assert.match(result, /## bb\/example/);
});

test("the launcher builds through the default host executor when none is injected", async () => {
  const launcherPath = path.join(primaryRoot, ".bb-runtime", "landlock-run");
  await rm(launcherPath);
  await rm(path.join(primaryRoot, ".bb-runtime", "landlock-run.sha256"));
  const policyForLauncher = {
    projectId: "proj_platform",
    trustedHostId: "host_server",
    primaryRoot,
    worktreeRoot,
    worktreeDirectoryName: "platform",
    gitCommonDir: path.join(primaryRoot, ".git"),
    dockerPath: path.join(bin, "docker"),
    manifestSha256: digest,
    manifestPath: path.join(primaryRoot, ".bb-runtime.json"),
    manifest: validateManifest(manifestDocument),
    manifestDigest: digest,
    manifestStale: false,
    manifestError: null,
    containers: { app: "server_fixture_app" },
  };
  const launcher = await ensureIsolationLauncher(policyForLauncher);
  assert.equal(launcher, launcherPath);
  assert.equal((await lstat(launcherPath)).isFile(), true);
});

test("a removed registration denies the cached thread and configuration", async (t) => {
  const tool = toolsByName.get("runtime_thread");
  await rm(policyPath);
  await waitFor(async () => {
    try {
      await tool.execute({ threadId: "thr_cache" }, { threadId: "thr_cache", signal: undefined });
      return false;
    } catch (error) {
      return /registration for this thread is no longer present/.test(error.message);
    }
  }, "the registry refresh to drop the removed registration");

  const denied = configureCallback(authorizedContext);
  assert.deepEqual(denied, { tools: [], skills: [] });
});

test("disposing the plugin drops the registry and thread contexts", async () => {
  for (const callback of disposeCallbacks) {
    await callback();
  }
  const tool = toolsByName.get("runtime_thread");
  await assert.rejects(
    tool.execute({ threadId: "thr_cache" }, { threadId: "thr_cache", signal: undefined }),
    /was not authorized for a registered project/,
  );
});
