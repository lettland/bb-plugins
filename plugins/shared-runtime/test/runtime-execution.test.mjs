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
  launcherBuildInvocation,
  prepareWorktreeDependencies,
  resolveWorkspace,
  runInvocation,
  validateWorkspace,
  withProjectLock,
} from "../src/runtime.mjs";

const execFileAsync = promisify(execFile);
const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const launcherSourceDigest = createHash("sha256")
  .update(await readFile(path.join(pluginRoot, "native", "landlock-run.go")))
  .digest("hex");
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
  const hostRoot = path.join(worktreeRoot, "env_abc123", "platform");
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
    worktreeRoot,
    worktreeDirectoryName: "platform",
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
    if (executable === "go" && rest[0] === "build") {
      return `${container} go build`;
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
    if (label.endsWith(" go build")) {
      const output = invocation.args[invocation.args.indexOf("-o") + 1];
      await writeFile(fixture.toHost(output), "#!/bin/sh\n");
    }
    const handler = handlers[label];
    if (handler) {
      return handler(invocation);
    }
    return ok();
  };
  return { calls, run, labels: () => calls.map(({ label }) => label) };
}

test("runtime assets are copied once and refreshed when their marker disappears", async (t) => {
  const fixture = await createFixture(t);
  const target = await ensureRuntimeAssets(fixture.policy);
  assert.equal(target, path.join(fixture.runtimeDirectory, "assets"));
  const sourceNames = (await readdir(path.join(pluginRoot, "assets"))).filter(
    (name) => !name.startsWith("."),
  );
  assert.deepEqual((await readdir(target)).sort(), sourceNames.sort());
  const copied = path.join(target, sourceNames[0]);
  assert.equal((await stat(copied)).mode & 0o777, 0o644);
  const marker = path.join(fixture.runtimeDirectory, "assets.sha256");
  assert.match(await readFile(marker, "utf8"), /^[0-9a-f]{64}\n$/);
  assert.equal((await stat(marker)).mode & 0o777, 0o600);

  await chmod(copied, 0o644);
  await writeFile(copied, "tampered");
  assert.equal(await ensureRuntimeAssets(fixture.policy), target);
  assert.equal(await readFile(copied, "utf8"), "tampered", "a matching marker skips the copy");

  await rm(marker);
  await ensureRuntimeAssets(fixture.policy);
  assert.equal(
    await readFile(copied, "utf8"),
    await readFile(path.join(pluginRoot, "assets", sourceNames[0]), "utf8"),
  );
  assert.deepEqual(
    (await readdir(fixture.runtimeDirectory)).filter((name) => name.includes(".tmp")),
    [],
  );

  await rm(marker);
  await mkdir(marker);
  await assert.rejects(ensureRuntimeAssets(fixture.policy), { code: "EISDIR" });
});

test("the isolation launcher is built in the builder container and cached by source digest", async (t) => {
  const fixture = await createFixture(t);
  const recorder = recordingRun(fixture);
  const controller = new AbortController();
  const launcher = await ensureIsolationLauncher(fixture.policy, {
    run: recorder.run,
    signal: controller.signal,
  });
  assert.equal(launcher, path.join(fixture.runtimeDirectory, "landlock-run"));
  assert.equal(recorder.calls.length, 1);
  const [{ invocation, options }] = recorder.calls;
  assert.equal(options.signal, controller.signal);
  assert.deepEqual(invocation.args, [
    "exec",
    "--workdir",
    "/app",
    "fixture_app",
    "go",
    "build",
    "-trimpath",
    "-o",
    `/app/.bb-runtime/.landlock-run.${process.pid}.tmp`,
    "/app/.bb-runtime/landlock-run.go",
  ]);
  assert.equal((await stat(launcher)).mode & 0o777, 0o555);
  assert.equal(
    await readFile(path.join(fixture.runtimeDirectory, "landlock-run.sha256"), "utf8"),
    `${launcherSourceDigest}\n`,
  );
  assert.equal(
    await readFile(path.join(fixture.runtimeDirectory, "landlock-run.go"), "utf8"),
    await readFile(path.join(pluginRoot, "native", "landlock-run.go"), "utf8"),
  );

  await ensureIsolationLauncher(fixture.policy, { run: recorder.run });
  assert.equal(recorder.calls.length, 1, "a current launcher is not rebuilt");

  await writeFile(path.join(fixture.runtimeDirectory, "landlock-run.sha256"), "stale\n");
  await ensureIsolationLauncher(fixture.policy, { run: recorder.run });
  assert.equal(recorder.calls.length, 2, "a stale digest triggers a rebuild");

  await rm(path.join(fixture.runtimeDirectory, "landlock-run.sha256"));
  await rm(launcher, { force: true });
  await assert.rejects(
    ensureIsolationLauncher(fixture.policy, {
      run: async () => {
        throw new Error("go toolchain unavailable");
      },
    }),
    /go toolchain unavailable/,
  );
  await assert.rejects(stat(launcher), { code: "ENOENT" });
  assert.deepEqual(
    (await readdir(fixture.runtimeDirectory)).filter((name) => name.includes(".tmp")),
    [],
  );

  await rm(path.join(fixture.runtimeDirectory, "landlock-run.sha256"), { force: true });
  await mkdir(path.join(fixture.runtimeDirectory, "landlock-run.sha256"));
  await assert.rejects(
    ensureIsolationLauncher(fixture.policy, { run: recorder.run }),
    { code: "EISDIR" },
  );
});

test("launcher builds require a declared isolation builder", async (t) => {
  const fixture = await createFixture(t);
  const withoutIsolation = { ...fixture.policy, manifest: { ...fixture.policy.manifest, isolation: null } };
  assert.throws(
    () => launcherBuildInvocation(withoutIsolation, "/a", "/b"),
    /Shared runtime denied: isolation builder is not declared/,
  );
  assert.throws(
    () => launcherBuildInvocation({ ...fixture.policy, manifest: null, manifestError: "broken" }, "/a", "/b"),
    /project manifest \.bb-runtime\.json is unavailable: broken/,
  );
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
    "fixture_app go build",
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
    "fixture_app go build",
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
    "fixture_app go build",
    "fixture_probe rm -rf",
    "fixture_probe mkdir -p",
    "fixture_probe mkdir -p",
    "fixture_probe touch /tmp/bb-runtime-env_sibling/unchanged.txt",
    "fixture_probe [self-test]",
    "fixture_probe rm -rf",
    "fixture_probe rm -rf",
  ]);
  const probe = recorder.calls[5].invocation.args;
  const deny = probe.filter((_, index, all) => all[index - 1] === "--deny-write");
  assert.ok(deny[0].startsWith(path.join(fixture.runtimeDirectory, "isolation-primary-")));
  assert.match(deny[1], /^\/bb-worktrees\/\.bb-runtime-isolation-sibling-[^/]+\/unchanged\.txt$/);
  assert.equal(deny[2], "/tmp/bb-runtime-env_sibling/unchanged.txt");
  assert.match(
    probe[probe.indexOf("--allow-write") + 1],
    /^\/bb-worktrees\/env_abc123\/platform\/\.bb-runtime-isolation-selected-[^/]+\/selected\.txt$/,
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
    "fixture_app go build",
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
    owner: { environmentId: "env_waiter", operation: "svelte_check" },
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
