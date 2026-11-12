import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import {
  appendFile,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { installedLauncherVerified } from "../src/isolation-launcher.mjs";
import { manifestDigest, validateManifest } from "../src/manifest.mjs";
import {
  ensureContainerSymlink,
  ensureIsolationLauncher,
  ensureRuntimeAssets,
  executeContainerOperation,
  executeGit,
  executeSearch,
  formatResults,
  ISOLATION_SELF_TEST_OPERATION,
  prepareWorktreeDependencies,
  resolveWorkspace,
  runInvocation,
  validateWorkspace,
  withProjectLock,
} from "../src/runtime.mjs";

const execFileAsync = promisify(execFile);
const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sha256Of = (content) => createHash("sha256").update(content).digest("hex");
const prebuiltSums = await readFile(path.join(pluginRoot, "native", "prebuilt", "SHA256SUMS"), "utf8");
const bundledDigests = new Map(
  prebuiltSums
    .split("\n")
    .map((line) => /^([0-9a-f]{64})  linux-(\w+)\/landlock-run$/.exec(line))
    .filter(Boolean)
    .map(([, digest, architecture]) => [architecture, digest]),
);
const DOCKER = "/fixture/bin/docker";

function manifestDocument(overrides = {}) {
  return {
    version: 1,
    isolation: { builder: "app", probe: "probe" },
    containers: {
      app: { service: "app", mounts: [{ host: ".", container: "/app" }] },
      probe: { service: "probe", mounts: [{ host: ".", container: "${primaryRoot}" }] },
    },
    scratch: { cache: { env: ["CACHE_DIR"] } },
    dependencies: [
      { path: "vendor", link: "/app/vendor" },
      { path: "node_modules", mirror: "/app/node_modules", local: [".cache"] },
    ],
    search: { defaultPath: "src" },
    operations: {
      format_check: { container: "app", cwd: ".", argv: ["gofmt", "-l", "."], failOnStdout: true },
      vet: { container: "app", cwd: ".", argv: ["go", "vet", "./..."] },
      full: { steps: ["format_check", "vet"] },
      integration: { kind: "host", argv: ["bash", "scripts/it.sh"], containers: ["probe"] },
    },
    git: {
      prepareCommit: {
        generators: [
          {
            container: "app",
            cwd: ".",
            argv: ["php", "gen.php"],
            requires: "gen.php",
            stages: ["generated.json", "never-created.json"],
            tolerateMissingExecutable: true,
          },
          { container: "app", cwd: ".", argv: ["make", "strict"], stages: ["strict.out"] },
        ],
        hardlinks: [{ source: "docs/README.md", target: "mirror/README.md" }],
      },
    },
    ...overrides,
  };
}

async function createFixture(t, overrides = {}) {
  const fixtureRoot = await realpath(await mkdtemp(path.join(tmpdir(), "shared-runtime-exec-")));
  t.after(() => rm(fixtureRoot, { recursive: true, force: true }));
  const primaryRoot = path.join(fixtureRoot, "primary");
  const worktreeRoot = path.join(fixtureRoot, "worktrees");
  const hostRoot = path.join(worktreeRoot, "env_abc123", "example");
  await mkdir(path.join(primaryRoot, "node_modules", ".cache"), { recursive: true });
  await mkdir(path.join(primaryRoot, "node_modules", "left-pad"), { recursive: true });
  await mkdir(path.join(primaryRoot, "node_modules", "react"), { recursive: true });
  await mkdir(hostRoot, { recursive: true });
  const document = manifestDocument(overrides);
  const content = JSON.stringify(document);
  const digest = manifestDigest(content);
  const policy = Object.freeze({
    projectId: "proj_fixture",
    trustedHostId: "host_fixture",
    primaryRoot,
    scriptRoot: primaryRoot,
    worktreeRoot,
    worktreeDirectoryName: "example",
    gitCommonDir: path.join(primaryRoot, ".git"),
    containers: Object.freeze({ app: "fixture_app", probe: "fixture_probe" }),
    dockerPath: DOCKER,
    manifestSha256: digest,
    manifest: validateManifest(document),
    manifestDigest: digest,
    manifestStale: false,
    manifestError: null,
  });
  const workspace = validateWorkspace({
    policy,
    context: {
      projectId: "proj_fixture",
      hostId: "host_fixture",
      environmentId: "env_abc123",
      environmentPath: hostRoot,
      workspaceProvisionType: "managed-worktree",
      branchName: "bb/fixture",
    },
    resolvedEnvironmentPath: hostRoot,
    resolvedGitCommonDir: policy.gitCommonDir,
  });
  const runtimeDirectory = path.join(primaryRoot, ".bb-runtime");

  function toHost(containerPath) {
    if (containerPath.startsWith("/bb-worktrees/")) {
      return path.join(worktreeRoot, containerPath.slice("/bb-worktrees/".length));
    }
    if (containerPath.startsWith("/app/")) {
      return path.join(primaryRoot, containerPath.slice("/app/".length));
    }
    return containerPath;
  }

  return { fixtureRoot, hostRoot, policy, primaryRoot, runtimeDirectory, toHost, workspace, worktreeRoot };
}

function describeInvocation(invocation) {
  if (invocation.command === DOCKER && invocation.args[0] === "version") {
    return "docker version";
  }
  if (invocation.command === DOCKER) {
    const workdirIndex = invocation.args.indexOf("--workdir");
    const container = invocation.args[workdirIndex + 2];
    const executable = invocation.args[workdirIndex + 3];
    const rest = invocation.args.slice(workdirIndex + 4);
    if (executable.endsWith("/.bb-runtime/landlock-run")) {
      if (rest.includes("--self-test")) {
        return `${container} [self-test]`;
      }
      return `${container} [isolated] ${rest.slice(rest.indexOf("--") + 1).join(" ")}`;
    }
    return `${container} ${executable} ${rest[0]}`;
  }
  if (invocation.command === "git") {
    return `git ${invocation.args.slice(6).join(" ")}`;
  }
  return `${invocation.command} ${invocation.args.join(" ")}`;
}

function ok(stdout = "") {
  return { code: 0, signal: null, stdout, stderr: "", overflow: false };
}

function failure(code, stderr) {
  return Object.assign(new Error(`command failed with exit ${code}\n${stderr}`), {
    result: { code, signal: null, stdout: "", stderr, overflow: false },
  });
}

function recordingRun(fixture, handlers = {}) {
  const calls = [];
  const run = async (invocation, options) => {
    const label = describeInvocation(invocation);
    calls.push({ label, invocation, options });
    const handler = handlers[label];
    if (handler) {
      return handler(invocation);
    }
    // The fake Docker daemon runs on arm64 unless a test says otherwise.
    return label === "docker version" ? ok("arm64\n") : ok();
  };
  return { calls, run, labels: () => calls.map(({ label }) => label) };
}

const assetSourceNames = async () =>
  (await readdir(path.join(pluginRoot, "assets"))).filter((name) => !name.startsWith(".")).sort();

test("runtime assets are installed once, reused when they match, and replaced when they do not", async (t) => {
  const fixture = await createFixture(t);
  const target = await ensureRuntimeAssets(fixture.policy);
  assert.equal(target, path.join(fixture.runtimeDirectory, "assets"));
  const sourceNames = await assetSourceNames();
  assert.deepEqual((await readdir(target)).sort(), sourceNames);
  const copied = path.join(target, sourceNames[0]);
  assert.equal((await stat(copied)).mode & 0o777, 0o644);
  assert.deepEqual(
    (await readdir(fixture.runtimeDirectory)).filter((name) => name.includes("sha256")),
    [],
    "no marker file is written",
  );

  // Matching installed assets are reused without a rewrite.
  const before = await stat(copied);
  const directoryBefore = await stat(target);
  assert.equal(await ensureRuntimeAssets(fixture.policy), target);
  const after = await stat(copied);
  assert.equal(after.ino, before.ino);
  assert.equal(after.mtimeMs, before.mtimeMs);
  assert.equal((await stat(target)).ino, directoryBefore.ino);

  // The same file names with altered content are replaced with the bundled content.
  const bundled = await readFile(path.join(pluginRoot, "assets", sourceNames[0]), "utf8");
  await writeFile(copied, "tampered");
  assert.equal(await ensureRuntimeAssets(fixture.policy), target);
  assert.equal(await readFile(copied, "utf8"), bundled);

  // A missing file is restored.
  await rm(copied);
  await ensureRuntimeAssets(fixture.policy);
  assert.equal(await readFile(copied, "utf8"), bundled);
  assert.deepEqual(
    (await readdir(fixture.runtimeDirectory)).filter((name) => name.includes(".tmp")),
    [],
  );
});

test("a symlinked entry inside the installed assets is replaced and its target is left alone", async (t) => {
  const fixture = await createFixture(t);
  const target = await ensureRuntimeAssets(fixture.policy);
  const [name] = await assetSourceNames();
  const bundled = await readFile(path.join(pluginRoot, "assets", name), "utf8");
  const outside = path.join(fixture.fixtureRoot, "outside-file");
  await writeFile(outside, bundled);
  await rm(path.join(target, name));
  await symlink(outside, path.join(target, name));
  await ensureRuntimeAssets(fixture.policy);
  const replaced = await lstat(path.join(target, name));
  assert.equal(replaced.isSymbolicLink(), false);
  assert.equal(replaced.isFile(), true);
  assert.equal(await readFile(outside, "utf8"), bundled);
  assert.equal(await readFile(path.join(target, name), "utf8"), bundled);
});

test("an installed assets directory that is a symlink is replaced, not followed", async (t) => {
  const fixture = await createFixture(t);
  const outside = path.join(fixture.fixtureRoot, "outside-assets");
  await mkdir(outside);
  for (const name of await assetSourceNames()) {
    await writeFile(path.join(outside, name), await readFile(path.join(pluginRoot, "assets", name)));
  }
  await mkdir(fixture.runtimeDirectory);
  const target = path.join(fixture.runtimeDirectory, "assets");
  await symlink(outside, target);
  await ensureRuntimeAssets(fixture.policy);
  assert.equal((await lstat(target)).isSymbolicLink(), false);
  assert.equal((await lstat(target)).isDirectory(), true);
  assert.deepEqual((await readdir(outside)).sort(), await assetSourceNames(), "the link target is untouched");
});

test("a committed assets.sha256 symlink is unlinked and never followed", async (t) => {
  // Regression: the marker was read and then written through the link, so a repository that
  // committed .bb-runtime/assets.sha256 as a symlink truncated or created an arbitrary file.
  // The hole predates the shared-runtime launcher commits.
  const fixture = await createFixture(t);
  await mkdir(fixture.runtimeDirectory);
  const marker = path.join(fixture.runtimeDirectory, "assets.sha256");
  const outside = path.join(fixture.fixtureRoot, "outside-secret");
  await writeFile(outside, "must survive");
  await symlink(outside, marker);
  await ensureRuntimeAssets(fixture.policy);
  assert.equal(await readFile(outside, "utf8"), "must survive");
  await assert.rejects(lstat(marker), { code: "ENOENT" }, "the symlink is gone");

  // Through the launcher install, with a dangling link: the missing target is not created.
  const dangling = path.join(fixture.fixtureRoot, "never-created");
  await symlink(dangling, marker);
  await ensureIsolationLauncher(fixture.policy, { run: recordingRun(fixture).run });
  await assert.rejects(lstat(dangling), { code: "ENOENT" });
  await assert.rejects(lstat(marker), { code: "ENOENT" });
});

test("the SHA256SUMS source line is the digest of native/landlock-run.go", async () => {
  const source = /^source ([0-9a-f]{64})$/m.exec(prebuiltSums)?.[1];
  assert.equal(source, sha256Of(await readFile(path.join(pluginRoot, "native", "landlock-run.go"))));
  assert.match(prebuiltSums, /^toolchain golang:[0-9.]+@sha256:[0-9a-f]{64}$/m);
  assert.deepEqual([...bundledDigests.keys()].sort(), ["amd64", "arm64"]);
});

test("the prebuilt launcher is installed for the daemon architecture and reused only after verification", async (t) => {
  const fixture = await createFixture(t);
  const recorder = recordingRun(fixture);
  const controller = new AbortController();
  const launcher = await ensureIsolationLauncher(fixture.policy, {
    run: recorder.run,
    signal: controller.signal,
  });
  assert.equal(launcher, path.join(fixture.runtimeDirectory, "landlock-run"));
  assert.equal(recorder.calls.length, 1, "only the architecture query runs; nothing is compiled");
  const [{ invocation, options }] = recorder.calls;
  assert.equal(options.signal, controller.signal);
  assert.deepEqual(invocation, {
    command: DOCKER,
    args: ["version", "-f", "{{.Server.Arch}}"],
  });
  const installed = await lstat(launcher);
  assert.equal(installed.isFile(), true);
  assert.equal(installed.mode & 0o777, 0o555);
  assert.equal(sha256Of(await readFile(launcher)), bundledDigests.get("arm64"));
  assert.deepEqual(
    (await readdir(fixture.runtimeDirectory)).filter((name) => name.includes("landlock-run")),
    ["landlock-run"],
    "no marker, source copy, or temporary file is written",
  );

  await ensureIsolationLauncher(fixture.policy, { run: recorder.run });
  assert.equal((await lstat(launcher)).ino, installed.ino, "a verified launcher is reused, not rewritten");
  assert.equal(recorder.calls.length, 2, "the daemon is asked on every call");

  await chmod(launcher, 0o755);
  await writeFile(launcher, "swapped by an unconfined container process");
  await ensureIsolationLauncher(fixture.policy, { run: recorder.run });
  assert.equal(sha256Of(await readFile(launcher)), bundledDigests.get("arm64"), "a swapped binary is reinstalled");
  assert.equal((await stat(launcher)).mode & 0o777, 0o555);

  await chmod(launcher, 0o755);
  await ensureIsolationLauncher(fixture.policy, { run: recorder.run });
  assert.equal((await stat(launcher)).mode & 0o777, 0o555, "a changed mode is repaired");

  await rm(launcher);
  await symlink(path.join(pluginRoot, "native", "prebuilt", "linux-arm64", "landlock-run"), launcher);
  await ensureIsolationLauncher(fixture.policy, { run: recorder.run });
  assert.equal((await lstat(launcher)).isFile(), true, "a symlink is replaced by a regular file");
  assert.equal((await lstat(launcher)).isSymbolicLink(), false);

  assert.deepEqual(
    (await readdir(fixture.runtimeDirectory)).filter((name) => name.includes(".tmp")),
    [],
  );
});

test("two concurrent launcher installs in one process both succeed with the expected launcher", async (t) => {
  // Regression: temporary paths were named by process id only, so two operations in one
  // process (a shared project lock, two worktrees) removed or overwrote each other's temporary
  // asset directory and launcher file.
  const fixture = await createFixture(t);
  const launchers = await Promise.all(
    Array.from({ length: 4 }, () => ensureIsolationLauncher(fixture.policy, { run: recordingRun(fixture).run })),
  );
  assert.deepEqual(new Set(launchers), new Set([path.join(fixture.runtimeDirectory, "landlock-run")]));
  assert.equal(sha256Of(await readFile(launchers[0])), bundledDigests.get("arm64"));
  assert.equal((await stat(launchers[0])).mode & 0o777, 0o555);
  assert.deepEqual(
    (await readdir(fixture.runtimeDirectory)).filter((name) => name.includes(".tmp")),
    [],
    "no call leaves or removes a temporary file that is not its own",
  );
  assert.deepEqual(
    (await readdir(path.join(fixture.runtimeDirectory, "assets"))).sort(),
    (await readdir(path.join(pluginRoot, "assets"))).filter((name) => !name.startsWith(".")).sort(),
  );
});

test("a symlinked runtime directory is refused before anything is written or removed", async (t) => {
  // Regression: a repository that commits .bb-runtime as a symlink redirected the install's
  // writes and removals to the link target.
  const fixture = await createFixture(t);
  const elsewhere = path.join(fixture.fixtureRoot, "elsewhere");
  await mkdir(elsewhere);
  await writeFile(path.join(elsewhere, "landlock-run.go"), "must survive");
  await symlink(elsewhere, fixture.runtimeDirectory);
  const expected = `Shared runtime denied: ${fixture.runtimeDirectory} must be a directory owned by you, not a symlink; if the repository commits .bb-runtime, do not run it, otherwise remove it and run the operation again`;
  await assert.rejects(ensureRuntimeAssets(fixture.policy), { message: expected });
  await assert.rejects(
    ensureIsolationLauncher(fixture.policy, { run: recordingRun(fixture).run }),
    { message: expected },
  );
  assert.deepEqual(await readdir(elsewhere), ["landlock-run.go"]);
  assert.equal(await readFile(path.join(elsewhere, "landlock-run.go"), "utf8"), "must survive");
  assert.equal((await lstat(fixture.runtimeDirectory)).isSymbolicLink(), true);

  // A dangling link and a plain file are refused the same way.
  await rm(fixture.runtimeDirectory);
  await symlink(path.join(fixture.fixtureRoot, "nowhere"), fixture.runtimeDirectory);
  await assert.rejects(ensureRuntimeAssets(fixture.policy), { message: expected });
  await rm(fixture.runtimeDirectory);
  await writeFile(fixture.runtimeDirectory, "not a directory");
  await assert.rejects(ensureRuntimeAssets(fixture.policy), { message: expected });

  // Absent, or a real directory you own, passes.
  await rm(fixture.runtimeDirectory);
  await ensureIsolationLauncher(fixture.policy, { run: recordingRun(fixture).run });
  assert.equal(sha256Of(await readFile(path.join(fixture.runtimeDirectory, "landlock-run"))), bundledDigests.get("arm64"));
  await ensureIsolationLauncher(fixture.policy, { run: recordingRun(fixture).run });
});

test("a stale source copy and marker from a source build are removed", async (t) => {
  const fixture = await createFixture(t);
  await mkdir(fixture.runtimeDirectory, { recursive: true });
  await writeFile(path.join(fixture.runtimeDirectory, "landlock-run.go"), "package main\n");
  await writeFile(path.join(fixture.runtimeDirectory, "landlock-run.sha256"), "stale\n");
  const launcher = await ensureIsolationLauncher(fixture.policy, { run: recordingRun(fixture).run });
  assert.deepEqual(
    (await readdir(fixture.runtimeDirectory)).filter((name) => name.includes("landlock-run")),
    ["landlock-run"],
  );
  assert.equal(sha256Of(await readFile(launcher)), bundledDigests.get("arm64"));
});

test("the launcher matches the daemon architecture, not the container image architecture", async (t) => {
  // Regression, BB thread thr_69ubadfky5: an amd64-image container on an arm64 daemon gets the
  // arm64 launcher. A native static binary runs natively in every container, and the seccomp
  // syscall numbers match the kernel; an amd64 binary under emulation would not match them.
  const arm64 = await createFixture(t);
  await ensureIsolationLauncher(arm64.policy, { run: recordingRun(arm64).run });
  assert.equal(
    sha256Of(await readFile(path.join(arm64.runtimeDirectory, "landlock-run"))),
    bundledDigests.get("arm64"),
  );
  const amd64 = await createFixture(t);
  await ensureIsolationLauncher(amd64.policy, {
    run: recordingRun(amd64, { "docker version": () => ok("amd64\n") }).run,
  });
  assert.equal(
    sha256Of(await readFile(path.join(amd64.runtimeDirectory, "landlock-run"))),
    bundledDigests.get("amd64"),
  );
  assert.notEqual(bundledDigests.get("amd64"), bundledDigests.get("arm64"));
});

test("an unsupported or unreadable daemon architecture denies the install", async (t) => {
  const fixture = await createFixture(t);
  for (const reported of ["riscv64", "", "x86_64"]) {
    await assert.rejects(
      ensureIsolationLauncher(fixture.policy, {
        run: recordingRun(fixture, { "docker version": () => ok(`${reported}\n`) }).run,
      }),
      (error) =>
        error.message ===
        `Shared runtime denied: unsupported Docker host architecture ${JSON.stringify(reported)}`,
    );
  }
  await assert.rejects(
    ensureIsolationLauncher(fixture.policy, {
      run: recordingRun(fixture, {
        "docker version": () => {
          throw failure(1, "Cannot connect to the Docker daemon");
        },
      }).run,
    }),
    /Shared runtime denied: cannot read the Docker host architecture: command failed with exit 1\nCannot connect to the Docker daemon/,
  );
  await assert.rejects(lstat(path.join(fixture.runtimeDirectory, "landlock-run")), { code: "ENOENT" });
});

test("a Python-only stack installs the launcher without an isolation builder", async (t) => {
  // Regression, BB thread thr_69ubadfky5: a Python-only stack could not run any operation because
  // the plugin compiled its launcher with Go inside the project. The install needs no container.
  const fixture = await createFixture(t, {
    isolation: undefined,
    containers: { python: { service: "python", mounts: [{ host: ".", container: "/app" }] } },
    operations: { tests: { container: "python", argv: ["pytest", "-q"] } },
    git: undefined,
    dependencies: [],
  });
  assert.equal(fixture.policy.manifest.isolation, null);
  const recorder = recordingRun(fixture);
  await ensureIsolationLauncher(fixture.policy, { run: recorder.run });
  assert.deepEqual(recorder.labels(), ["docker version"]);
  assert.equal(sha256Of(await readFile(path.join(fixture.runtimeDirectory, "landlock-run"))), bundledDigests.get("arm64"));
});

test("the doctor check compares the installed launcher with SHA256SUMS", async (t) => {
  const fixture = await createFixture(t);
  assert.equal(await installedLauncherVerified(fixture.primaryRoot), false, "not installed yet");
  const launcher = await ensureIsolationLauncher(fixture.policy, { run: recordingRun(fixture).run });
  assert.equal(await installedLauncherVerified(fixture.primaryRoot), true);
  await chmod(launcher, 0o755);
  assert.equal(await installedLauncherVerified(fixture.primaryRoot), false, "wrong mode");
  await writeFile(launcher, "swapped");
  await chmod(launcher, 0o555);
  assert.equal(await installedLauncherVerified(fixture.primaryRoot), false, "wrong digest");
});

test("container operations run their plan inside reset scratch with shared dependencies", async (t) => {
  const fixture = await createFixture(t);
  const recorder = recordingRun(fixture, {
    "fixture_app [isolated] go vet ./...": () => ok("vet clean\n"),
  });
  const results = await executeContainerOperation(fixture.policy, fixture.workspace, "full", {
    lockAdapter: new Map(),
    run: recorder.run,
  });
  assert.deepEqual(recorder.labels(), [
    "docker version",
    "fixture_app rm -rf",
    "fixture_app mkdir -p",
    "fixture_app [isolated] gofmt -l .",
    "fixture_app [isolated] go vet ./...",
    "fixture_app rm -rf",
  ]);
  assert.deepEqual(recorder.calls[2].invocation.args.slice(-4), [
    "/var/tmp/bb-runtime-cache-env_abc123",
    "/tmp/bb-runtime-env_abc123",
    "/var/tmp/bb-runtime-env_abc123",
    "/dev/shm/bb-runtime-env_abc123",
  ]);
  assert.ok(
    recorder.calls[3].invocation.args.includes("CACHE_DIR=/var/tmp/bb-runtime-cache-env_abc123"),
  );
  assert.equal(recorder.calls[3].invocation.rejectNonEmptyStdout, true);
  assert.equal(results.length, 2);
  assert.equal(formatResults(results), "vet clean");

  assert.equal(
    await readlink(path.join(fixture.hostRoot, "vendor")),
    "/app/vendor",
    "link dependencies point at the shared container install",
  );
  const mirror = path.join(fixture.hostRoot, "node_modules");
  assert.deepEqual((await readdir(mirror)).sort(), [".cache", "left-pad", "react"]);
  assert.equal(await readlink(path.join(mirror, "react")), "/app/node_modules/react");
  assert.ok((await lstat(path.join(mirror, ".cache"))).isDirectory());
});

test("host-step operations reset scratch only for their declared containers", async (t) => {
  const fixture = await createFixture(t);
  const recorder = recordingRun(fixture);
  await executeContainerOperation(fixture.policy, fixture.workspace, "integration", {
    lockAdapter: new Map(),
    run: recorder.run,
  });
  assert.deepEqual(recorder.labels(), [
    "docker version",
    "fixture_probe rm -rf",
    "fixture_probe mkdir -p",
    `/bin/bash ${path.join(fixture.primaryRoot, "scripts", "it.sh")}`,
    "fixture_probe rm -rf",
  ]);
  assert.equal(recorder.calls[3].invocation.cwd, fixture.hostRoot);
});

test("a format check with output fails the operation after cleaning scratch", async (t) => {
  const fixture = await createFixture(t);
  const recorder = recordingRun(fixture, {
    "fixture_app [isolated] gofmt -l .": () => ok("main.go\n"),
  });
  await assert.rejects(
    executeContainerOperation(fixture.policy, fixture.workspace, "full", {
      lockAdapter: new Map(),
      run: recorder.run,
    }),
    /^Error: format check failed; files need formatting:\nmain\.go\n$/,
  );
  assert.equal(recorder.labels().at(-1), "fixture_app rm -rf");
  assert.ok(!recorder.labels().includes("fixture_app [isolated] go vet ./..."));
});

test("container operations refuse primary checkouts and stale manifests before running", async (t) => {
  const fixture = await createFixture(t);
  const recorder = recordingRun(fixture);
  await assert.rejects(
    executeContainerOperation(
      fixture.policy,
      { ...fixture.workspace, kind: "primary", containerRoot: null },
      "vet",
      { run: recorder.run, lockAdapter: new Map() },
    ),
    /quality operations require an isolated managed worktree/,
  );
  await assert.rejects(
    executeContainerOperation(
      { ...fixture.policy, manifestStale: true },
      fixture.workspace,
      "vet",
      { run: recorder.run, lockAdapter: new Map() },
    ),
    /changed since installation; run the shared runtime "sync" operation/,
  );
  await assert.rejects(
    executeContainerOperation(fixture.policy, fixture.workspace, "missing_operation", {
      run: recorder.run,
      lockAdapter: new Map(),
    }),
    /unsupported operation "missing_operation"/,
  );
  assert.deepEqual(recorder.calls, []);
});

test("the isolation self-test proves writes stay inside the selected worktree", async (t) => {
  const fixture = await createFixture(t);
  const selfTest = (tamper) => async (invocation) => {
    const allowed = invocation.args[invocation.args.indexOf("--allow-write") + 1];
    await appendFile(fixture.toHost(allowed), "allowed\n");
    if (tamper !== null) {
      const denied = invocation.args.filter((_, index, all) => all[index - 1] === "--deny-write");
      await appendFile(fixture.toHost(denied[tamper]), "escaped\n");
    }
    return ok("self-test passed\n");
  };
  const recorder = recordingRun(fixture, { "fixture_probe [self-test]": selfTest(null) });
  const results = await executeContainerOperation(
    fixture.policy,
    fixture.workspace,
    ISOLATION_SELF_TEST_OPERATION,
    { lockAdapter: new Map(), run: recorder.run },
  );
  assert.equal(formatResults(results), "self-test passed");
  assert.deepEqual(recorder.labels(), [
    "docker version",
    "fixture_probe rm -rf",
    "fixture_probe mkdir -p",
    "fixture_probe git --version",
    "fixture_probe mkdir -p",
    "fixture_probe touch /tmp/bb-runtime-env_sibling/unchanged.txt",
    "fixture_probe [self-test]",
    "fixture_probe rm -rf",
    "fixture_probe rm -rf",
  ]);
  const probe = recorder.calls[6].invocation.args;
  const deny = probe.filter((_, index, all) => all[index - 1] === "--deny-write");
  assert.ok(deny[0].startsWith(path.join(fixture.runtimeDirectory, "isolation-primary-")));
  assert.match(deny[1], /^\/bb-worktrees\/\.bb-runtime-isolation-sibling-[^/]+\/unchanged\.txt$/);
  assert.equal(deny[2], "/tmp/bb-runtime-env_sibling/unchanged.txt");
  assert.match(
    probe[probe.indexOf("--allow-write") + 1],
    /^\/bb-worktrees\/env_abc123\/example\/\.bb-runtime-isolation-selected-[^/]+\/selected\.txt$/,
  );
  assert.equal(probe[probe.indexOf("--git-ref") + 1], "refs/heads/bb/fixture");

  for (const index of [0, 1]) {
    const tampered = recordingRun(fixture, { "fixture_probe [self-test]": selfTest(index) });
    await assert.rejects(
      executeContainerOperation(fixture.policy, fixture.workspace, ISOLATION_SELF_TEST_OPERATION, {
        lockAdapter: new Map(),
        run: tampered.run,
      }),
      /isolation probe modified a protected checkout/,
    );
    assert.deepEqual(tampered.labels().slice(-2), ["fixture_probe rm -rf", "fixture_probe rm -rf"]);
  }

  const leftovers = [
    ...(await readdir(fixture.runtimeDirectory)).filter((name) => name.startsWith("isolation-")),
    ...(await readdir(fixture.worktreeRoot)).filter((name) => name.startsWith(".bb-runtime-")),
    ...(await readdir(fixture.hostRoot)).filter((name) => name.startsWith(".bb-runtime-")),
  ];
  assert.deepEqual(leftovers, [], "probe directories are always removed");
});

test("the isolation self-test needs git in the probe container", async (t) => {
  const fixture = await createFixture(t);
  const withGit = recordingRun(fixture, { "fixture_probe [self-test]": async (invocation) => {
    const allowed = invocation.args[invocation.args.indexOf("--allow-write") + 1];
    await appendFile(fixture.toHost(allowed), "allowed\n");
    return ok("self-test passed\n");
  } });
  await executeContainerOperation(fixture.policy, fixture.workspace, ISOLATION_SELF_TEST_OPERATION, {
    lockAdapter: new Map(),
    run: withGit.run,
  });
  assert.ok(withGit.labels().includes("fixture_probe git --version"), "with git present the self-test runs");

  const withoutGit = recordingRun(fixture, {
    "fixture_probe git --version": () => {
      throw failure(127, "exec: git: executable file not found");
    },
  });
  await assert.rejects(
    executeContainerOperation(fixture.policy, fixture.workspace, ISOLATION_SELF_TEST_OPERATION, {
      lockAdapter: new Map(),
      run: withoutGit.run,
    }),
    {
      message:
        'Shared runtime denied: isolation_self_test needs git in container "probe"; set isolation.probe to a container with git',
    },
  );
  assert.equal(withoutGit.labels().includes("fixture_probe [self-test]"), false);
  assert.deepEqual(
    (await readdir(fixture.runtimeDirectory)).filter((name) => name.startsWith("isolation-")),
    [],
    "the denial happens before any probe directory exists",
  );
});

test("commits regenerate outputs, hard-link mirrors, and stage them before committing", async (t) => {
  const fixture = await createFixture(t);
  await writeFile(path.join(fixture.hostRoot, "gen.php"), "<?php\n");
  await mkdir(path.join(fixture.hostRoot, "docs"));
  await writeFile(path.join(fixture.hostRoot, "docs", "README.md"), "readme\n");
  const recorder = recordingRun(fixture, {
    "fixture_app [isolated] php gen.php": async () => {
      await writeFile(path.join(fixture.hostRoot, "generated.json"), "{}\n");
      return ok();
    },
    "fixture_app [isolated] make strict": () => ok(),
  });
  const commit = { operation: "commit", message: "Regenerate outputs" };
  const result = await executeGit(fixture.policy, fixture.workspace, commit, {
    lockAdapter: new Map(),
    run: recorder.run,
  });
  assert.equal(result.code, 0);
  assert.deepEqual(recorder.labels(), [
    "docker version",
    "fixture_app rm -rf",
    "fixture_app mkdir -p",
    "fixture_app [isolated] php gen.php",
    "fixture_app [isolated] make strict",
    "git --literal-pathspecs add -- generated.json mirror/README.md",
    "fixture_app rm -rf",
    "git commit --no-verify -m Regenerate outputs",
  ]);
  const source = await stat(path.join(fixture.hostRoot, "docs", "README.md"));
  const target = await stat(path.join(fixture.hostRoot, "mirror", "README.md"));
  assert.equal(target.ino, source.ino);
  assert.equal(target.dev, source.dev);

  await rm(path.join(fixture.hostRoot, "generated.json"));
  await rm(path.join(fixture.hostRoot, "gen.php"));
  const second = recordingRun(fixture);
  await executeGit(fixture.policy, fixture.workspace, commit, {
    lockAdapter: new Map(),
    run: second.run,
  });
  assert.deepEqual(
    second.labels(),
    [
      "docker version",
      "fixture_app rm -rf",
      "fixture_app mkdir -p",
      "fixture_app [isolated] make strict",
      "fixture_app rm -rf",
      "git commit --no-verify -m Regenerate outputs",
    ],
    "absent requirements skip generators and existing hard links are not restaged",
  );
});

test("commit generators tolerate only declared missing executables", async (t) => {
  const fixture = await createFixture(t);
  await writeFile(path.join(fixture.hostRoot, "gen.php"), "<?php\n");
  const missingPhp = recordingRun(fixture, {
    "fixture_app [isolated] php gen.php": () => {
      throw failure(127, 'exec: "php": executable file not found in $PATH');
    },
  });
  await executeGit(
    fixture.policy,
    fixture.workspace,
    { operation: "commit", message: "Tolerate php" },
    { lockAdapter: new Map(), run: missingPhp.run },
  );
  assert.ok(missingPhp.labels().includes("fixture_app [isolated] make strict"));
  assert.equal(missingPhp.labels().at(-1), "git commit --no-verify -m Tolerate php");

  const phpCrash = recordingRun(fixture, {
    "fixture_app [isolated] php gen.php": () => {
      throw failure(127, "segmentation fault");
    },
  });
  await assert.rejects(
    executeGit(
      fixture.policy,
      fixture.workspace,
      { operation: "commit", message: "Crash" },
      { lockAdapter: new Map(), run: phpCrash.run },
    ),
    /segmentation fault/,
  );
  assert.equal(phpCrash.labels().at(-1), "fixture_app rm -rf", "scratch is cleaned after a failure");

  const phpFails = recordingRun(fixture, {
    "fixture_app [isolated] php gen.php": () => {
      throw failure(2, "not found");
    },
  });
  await assert.rejects(
    executeGit(
      fixture.policy,
      fixture.workspace,
      { operation: "commit", message: "Fail" },
      { lockAdapter: new Map(), run: phpFails.run },
    ),
    /exit 2/,
  );

  const makeMissing = recordingRun(fixture, {
    "fixture_app [isolated] make strict": () => {
      throw failure(127, "make: not found");
    },
  });
  await assert.rejects(
    executeGit(
      fixture.policy,
      fixture.workspace,
      { operation: "commit", message: "Strict" },
      { lockAdapter: new Map(), run: makeMissing.run },
    ),
    /make: not found/,
  );
  assert.ok(!makeMissing.labels().some((label) => label.startsWith("git commit")));
});

test("commits without generators skip the launcher and scratch entirely", async (t) => {
  const fixture = await createFixture(t, { git: undefined });
  const recorder = recordingRun(fixture);
  await executeGit(
    fixture.policy,
    fixture.workspace,
    { operation: "commit", message: "Plain commit" },
    { lockAdapter: new Map(), run: recorder.run },
  );
  assert.deepEqual(recorder.labels(), ["git commit --no-verify -m Plain commit"]);
  await assert.rejects(
    executeGit(
      fixture.policy,
      { ...fixture.workspace, kind: "primary", containerRoot: null },
      { operation: "commit", message: "Primary commit" },
      { lockAdapter: new Map(), run: recorder.run },
    ),
    /quality operations require an isolated managed worktree/,
  );
});

test("primary fast-forward only lands the managed branch onto a mainline checkout", async (t) => {
  const fixture = await createFixture(t);
  for (const mainline of ["main", "master"]) {
    const recorder = recordingRun(fixture, {
      "git symbolic-ref --quiet --short HEAD": () => ok(`${mainline}\n`),
      "git merge --ff-only refs/heads/bb/fixture": () => ok("Fast-forward\n"),
    });
    const results = await executeGit(
      fixture.policy,
      fixture.workspace,
      { operation: "fast_forward_primary" },
      { lockAdapter: new Map(), run: recorder.run },
    );
    assert.equal(formatResults(results), `${mainline}\n\nFast-forward`);
    assert.deepEqual(
      recorder.calls.map(({ invocation }) => invocation.cwd),
      [fixture.primaryRoot, fixture.primaryRoot],
    );
  }
  const feature = recordingRun(fixture, {
    "git symbolic-ref --quiet --short HEAD": () => ok("feature/x\n"),
  });
  await assert.rejects(
    executeGit(
      fixture.policy,
      fixture.workspace,
      { operation: "fast_forward_primary" },
      { lockAdapter: new Map(), run: feature.run },
    ),
    /primary checkout is on non-mainline branch "feature\/x"/,
  );
  assert.equal(feature.calls.length, 1, "no merge is attempted from a non-mainline checkout");
});

test("search runs ripgrep in the workspace with the manifest default path", async (t) => {
  const fixture = await createFixture(t);
  const bin = path.join(fixture.fixtureRoot, "bin");
  await mkdir(bin);
  await writeFile(
    path.join(bin, "rg"),
    '#!/bin/sh\nprintf "cwd=%s\\n" "$(pwd -P)"\nfor a in "$@"; do printf "arg=%s\\n" "$a"; done\n[ "$5" = "missing" ] && exit 1\nexit 0\n',
    { mode: 0o755 },
  );
  const env = { PATH: `${bin}${path.delimiter}/usr/bin${path.delimiter}/bin` };
  const found = await executeSearch(fixture.policy, fixture.workspace, { query: "needle" }, { env });
  assert.equal(found.code, 0);
  assert.equal(
    found.stdout,
    [
      `cwd=${fixture.hostRoot}`,
      "arg=--color=never",
      "arg=--line-number",
      "arg=--fixed-strings",
      "arg=--",
      "arg=needle",
      "arg=src",
      "",
    ].join("\n"),
  );
  const scoped = await executeSearch(
    fixture.policy,
    fixture.workspace,
    { query: "missing", path: "lib" },
    { env },
  );
  assert.equal(scoped.code, 1, "ripgrep's no-match exit is accepted");
  assert.match(scoped.stdout, /arg=lib\n$/);
  await assert.rejects(
    executeSearch({ ...fixture.policy, manifest: null }, fixture.workspace, { query: "x" }),
    /manifest \.bb-runtime\.json is unavailable/,
  );
});

test("runInvocation reports failures, signals, spawn errors, and bounds output", async () => {
  await assert.rejects(
    runInvocation({
      command: process.execPath,
      args: ["-e", "process.stderr.write('bad things'); process.exit(3)"],
    }),
    (error) => {
      assert.equal(error.message, "command failed with exit 3\nbad things");
      assert.equal(error.result.code, 3);
      assert.equal(error.result.stderr, "bad things");
      return true;
    },
  );
  await assert.rejects(
    runInvocation({
      command: process.execPath,
      args: ["-e", "process.stdout.write('only stdout'); process.exit(4)"],
    }),
    /^Error: command failed with exit 4\nonly stdout$/,
  );

  const controller = new AbortController();
  const pending = runInvocation(
    { command: process.execPath, args: ["-e", "setInterval(() => {}, 1000)"] },
    { signal: controller.signal },
  );
  setTimeout(() => controller.abort(), 50);
  await assert.rejects(pending, (error) => {
    assert.match(error.message, /^command failed with exit null \(SIGTERM\)/);
    assert.equal(error.result.signal, "SIGTERM");
    return true;
  });

  await assert.rejects(
    runInvocation({ command: "/nonexistent/shared-runtime-binary", args: [] }),
    { code: "ENOENT" },
  );

  const large = await runInvocation({
    command: process.execPath,
    args: ["-e", "process.stdout.write('x'.repeat(200000)); process.stderr.write('y'.repeat(130000))"],
  });
  assert.equal(large.overflow, true);
  assert.equal(large.stdout.length, 120_000);
  assert.equal(large.stderr.length, 120_000);

  const custom = await runInvocation(
    {
      acceptedExitCodes: [0, 5],
      command: process.execPath,
      args: ["-e", "process.stdout.write(process.env.FROM_INVOCATION + ':' + process.env.FROM_OPTIONS); process.exit(5)"],
      environment: { FROM_INVOCATION: "invocation", FROM_OPTIONS: "overridden" },
    },
    { env: { FROM_OPTIONS: "options" } },
  );
  assert.equal(custom.code, 5);
  assert.equal(custom.stdout, "invocation:options");
  assert.equal(custom.overflow, false);
});

test("resolveWorkspace binds a real checkout to the registered repository", async (t) => {
  const fixture = await createFixture(t);
  await execFileAsync("git", ["init", "--quiet", fixture.primaryRoot], {
    env: Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_"))),
  });
  const context = {
    projectId: "proj_fixture",
    hostId: "host_fixture",
    environmentId: "env_primary",
    environmentPath: fixture.primaryRoot,
    workspaceProvisionType: "unmanaged",
    branchName: "main",
  };
  const workspace = await resolveWorkspace(fixture.policy, context);
  assert.deepEqual(workspace, {
    branchName: "main",
    containerRoot: null,
    environmentId: "env_primary",
    hostRoot: fixture.primaryRoot,
    kind: "primary",
  });
  await assert.rejects(
    resolveWorkspace({ ...fixture.policy, gitCommonDir: "/elsewhere/.git" }, context),
    /Shared runtime denied: foreign repository/,
  );
  await assert.rejects(
    resolveWorkspace(fixture.policy, { ...context, environmentPath: "" }),
    /environment path is missing or invalid/,
  );
  await assert.rejects(
    resolveWorkspace(fixture.policy, { ...context, environmentPath: path.join(fixture.fixtureRoot, "gone") }),
    { code: "ENOENT" },
  );
  assert.equal(await prepareWorktreeDependencies(fixture.policy, workspace), undefined);
});

test("dependency mirrors repair stale links and refuse foreign entries", async (t) => {
  const fixture = await createFixture(t);
  const mirror = path.join(fixture.hostRoot, "node_modules");
  const prepare = () => prepareWorktreeDependencies(fixture.policy, fixture.workspace);

  await symlink("/app/node_modules", mirror);
  await prepare();
  assert.ok((await lstat(mirror)).isDirectory(), "a legacy whole-directory link becomes a mirror");
  assert.equal(await readlink(path.join(mirror, "left-pad")), "/app/node_modules/left-pad");

  await symlink("/app/node_modules/removed", path.join(mirror, "removed"));
  await rm(path.join(mirror, ".cache"), { recursive: true });
  await symlink("/app/node_modules/.cache", path.join(mirror, ".cache"));
  await prepare();
  assert.deepEqual((await readdir(mirror)).sort(), [".cache", "left-pad", "react"]);
  assert.ok((await lstat(path.join(mirror, ".cache"))).isDirectory());

  const refusals = [
    [
      async () => {
        await rm(mirror, { recursive: true });
        await symlink("/somewhere/else", mirror);
      },
      /dependency link has an unexpected target: .*node_modules$/,
    ],
    [
      async () => {
        await rm(mirror);
        await writeFile(mirror, "file");
      },
      /dependency path is not a directory: .*node_modules$/,
    ],
    [
      async () => {
        await rm(mirror);
        await mkdir(path.join(mirror, "stray"), { recursive: true });
      },
      /dependency mirror contains an unexpected entry: .*node_modules\/stray$/,
    ],
    [
      async () => {
        await rm(path.join(mirror, "stray"), { recursive: true });
        await symlink("/other/stray", path.join(mirror, "stray"));
      },
      /dependency link has an unexpected target: .*node_modules\/stray$/,
    ],
    [
      async () => {
        await rm(path.join(mirror, "stray"));
        await rm(path.join(mirror, ".cache"), { recursive: true, force: true });
        await symlink("/other/.cache", path.join(mirror, ".cache"));
      },
      /dependency link has an unexpected target: .*node_modules\/\.cache$/,
    ],
    [
      async () => {
        await rm(path.join(mirror, ".cache"));
        await writeFile(path.join(mirror, ".cache"), "file");
      },
      /local dependency cache is not a directory: .*node_modules\/\.cache$/,
    ],
  ];
  for (const [arrange, expected] of refusals) {
    await arrange();
    await assert.rejects(prepare(), expected);
  }

  const vendor = path.join(fixture.hostRoot, "vendor");
  await rm(vendor);
  await mkdir(vendor);
  await assert.rejects(
    ensureContainerSymlink(vendor, "/app/vendor"),
    /dependency path is not a symbolic link/,
  );
});

test("memory locks report waits and release queued requests on abort", async () => {
  const lockAdapter = new Map();
  const waits = [];
  let releaseHolder;
  const holderGate = new Promise((resolve) => {
    releaseHolder = resolve;
  });
  const holder = withProjectLock("proj_fixture", () => holderGate, {
    lockAdapter,
    mode: "exclusive",
    owner: { environmentId: "env_holder", operation: "go_tests" },
  });
  await new Promise((resolve) => setImmediate(resolve));

  const controller = new AbortController();
  const waiter = withProjectLock("proj_fixture", async () => "never", {
    label: "shared dependency lock",
    lockAdapter,
    mode: "shared",
    onWait: (message) => waits.push(message),
    owner: { environmentId: "env_waiter", operation: "web_check" },
    signal: controller.signal,
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(waits.length, 1);
  assert.match(
    waits[0],
    /^Shared runtime waiting for shared dependency lock held by env_holder running go_tests since \d{4}-/,
  );
  controller.abort(new Error("caller went away"));
  await assert.rejects(waiter, /caller went away/);
  assert.equal(lockAdapter.get("proj_fixture").queue.length, 0);

  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(
    withProjectLock("proj_fixture", async () => "never", {
      lockAdapter,
      signal: aborted.signal,
    }),
    { name: "AbortError" },
  );

  await assert.rejects(
    withProjectLock("proj_other", async () => "never", { lockAdapter, mode: "upgrade" }),
    /unsupported lock mode "upgrade"/,
  );

  releaseHolder("held");
  assert.equal(await holder, "held");
  assert.equal(lockAdapter.size, 0, "released locks leave no state behind");
});
