import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
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

import { manifestDigest } from "../src/manifest.mjs";
import { loadRegistry } from "../src/registry.mjs";

const execFileAsync = promisify(execFile);
const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = path.join(pluginRoot, "bin", "bb-shared-runtime.mjs");
const fixtureManifestPath = path.join(pluginRoot, "test", "fixtures", "example.bb-runtime.json");

const fakeBbSource = `#!${process.execPath}
const fs = require("node:fs");
const statePath = process.env.FAKE_BB_STATE;
const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_BB_LOG, JSON.stringify({ args, bbCli: process.env.BB_CLI }) + "\\n");
const key = args.filter((argument) => argument !== "--json").slice(0, 2).join(" ");
if (key === "project list") {
  process.stdout.write(JSON.stringify(state.projects));
} else if (key === "plugin list") {
  process.stdout.write(JSON.stringify(state.wrapPlugins ? { plugins: state.plugins } : state.plugins));
} else if (key === "plugin install") {
  state.plugins = state.plugins ?? [];
  state.plugins.push({ id: "shared-runtime", source: args[args.length - 1] });
} else if (key === "plugin remove") {
  state.plugins = state.plugins.filter((plugin) => plugin.id !== args[2]);
} else if (key === "plugin reload") {
  state.reloads = (state.reloads ?? 0) + 1;
} else {
  process.stderr.write("unexpected bb call: " + args.join(" ") + "\\n");
  process.exit(9);
}
fs.writeFileSync(statePath, JSON.stringify(state));
`;

const fakeDockerSource = `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "context" && args[1] === "inspect") {
  if (!process.env.FAKE_DOCKER_CONTEXT) {
    process.stderr.write("no context\\n");
    process.exit(1);
  }
  process.stdout.write(process.env.FAKE_DOCKER_CONTEXT + "\\n");
} else if (args[0] === "inspect") {
  const mounts = JSON.parse(fs.readFileSync(process.env.FAKE_DOCKER_MOUNTS, "utf8"));
  const name = args[args.length - 1];
  if (!Object.hasOwn(mounts, name)) {
    process.stderr.write("Error: No such object: " + name + "\\n");
    process.exit(1);
  }
  process.stdout.write(JSON.stringify(mounts[name]) + "\\n");
} else {
  process.exit(3);
}
`;

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const gitEnvironment = {
  ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_"))),
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
};

async function git(cwd, ...args) {
  return execFileAsync("git", ["-C", cwd, ...args], { env: gitEnvironment });
}

async function createFixture(t, { projects, plugins = [], manifest = true, gitUser = true } = {}) {
  const fixtureRoot = await realpath(await mkdtemp(path.join(tmpdir(), "shared-runtime-cli-")));
  t.after(() => rm(fixtureRoot, { recursive: true, force: true }));
  const home = path.join(fixtureRoot, "home");
  const bin = path.join(fixtureRoot, "bin");
  const repo = path.join(fixtureRoot, "repo");
  const worktreeRoot = path.join(fixtureRoot, "worktrees");
  const runtimeRoot = path.join(home, ".bb", "shared-runtime");
  await Promise.all([
    mkdir(home, { recursive: true }),
    mkdir(bin, { recursive: true }),
    mkdir(repo, { recursive: true }),
    mkdir(worktreeRoot, { recursive: true }),
  ]);
  await git(repo, "init", "--quiet");
  if (gitUser) {
    await git(repo, "config", "user.name", "Fixture User");
    await git(repo, "config", "user.email", "fixture@example.invalid");
  }
  if (manifest) {
    await writeFile(path.join(repo, ".bb-runtime.json"), await readFile(fixtureManifestPath));
    await mkdir(path.join(repo, "docker", "dev"), { recursive: true });
    await writeFile(
      path.join(repo, "docker", "dev", ".env"),
      [
        "# Compose defaults",
        "",
        "not a variable line",
        "export PROJECT=wrong_default",
        "OTHER='quoted value'",
        "",
      ].join("\n"),
    );
    await writeFile(
      path.join(repo, "docker", "dev", ".env.local"),
      'PROJECT = example_dev   # local override\nQUOTED="kept # hash"\n',
    );
  }
  const state = path.join(fixtureRoot, "bb-state.json");
  const log = path.join(fixtureRoot, "bb-log.jsonl");
  const mounts = path.join(fixtureRoot, "docker-mounts.json");
  await writeFile(
    state,
    JSON.stringify({
      projects: projects ?? [
        {
          id: "proj_example",
          name: "example",
          sources: [
            { type: "remote", path: repo, hostId: "host_other" },
            { type: "local_path", path: 42 },
            { type: "local_path", path: path.join(fixtureRoot, "missing"), hostId: "host_gone" },
            { type: "local_path", path: repo, hostId: "host_fixture" },
          ],
        },
        { id: "proj_unrelated", name: "unrelated", sources: [] },
        { id: "proj_nosources", name: "nosources" },
      ],
      plugins,
    }),
  );
  await writeFile(log, "");
  await writeFile(mounts, "{}");
  await writeFile(path.join(bin, "bb"), fakeBbSource, { mode: 0o755 });
  await writeFile(path.join(bin, "docker"), fakeDockerSource, { mode: 0o755 });

  const baseEnvironment = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) =>
        !name.startsWith("GIT_") &&
        !name.startsWith("BB_") &&
        !name.startsWith("DOCKER_") &&
        name !== "HOME" &&
        name !== "PATH",
    ),
  );
  const environment = {
    ...baseEnvironment,
    HOME: home,
    PATH: [bin, "/usr/bin", "/bin"].join(path.delimiter),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    BB_WORKTREES_ROOT: worktreeRoot,
    FAKE_BB_STATE: state,
    FAKE_BB_LOG: log,
    FAKE_DOCKER_MOUNTS: mounts,
    DOCKER_HOST: "unix:///fixture/docker.sock",
  };

  async function run(args, { cwd = repo, env = {} } = {}) {
    const merged = { ...environment, ...env };
    for (const [name, value] of Object.entries(env)) {
      if (value === undefined) {
        delete merged[name];
      }
    }
    try {
      const { stdout, stderr } = await execFileAsync(process.execPath, [cliPath, ...args], {
        cwd,
        env: merged,
      });
      return { code: 0, stdout, stderr };
    } catch (error) {
      if (typeof error.code !== "number") {
        throw error;
      }
      return { code: error.code, stdout: error.stdout, stderr: error.stderr };
    }
  }

  return {
    bin,
    fixtureRoot,
    home,
    repo,
    runtimeRoot,
    worktreeRoot,
    run,
    policyPath: (projectId = "proj_example", root = runtimeRoot) =>
      path.join(root, "projects", `${projectId}.json`),
    readPolicy: async (projectId = "proj_example", root = runtimeRoot) =>
      JSON.parse(await readFile(path.join(root, "projects", `${projectId}.json`), "utf8")),
    bbCalls: async () =>
      (await readFile(log, "utf8"))
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line)),
    bbState: async () => JSON.parse(await readFile(state, "utf8")),
    setMounts: (value) => writeFile(mounts, JSON.stringify(value)),
  };
}

test("argument parsing reports usage, missing values, and unknown options", async (t) => {
  const fixture = await createFixture(t);
  for (const args of [[], ["--help"], ["help"], ["install", "--help"]]) {
    const result = await fixture.run(args);
    assert.equal(result.code, 0, args.join(" "));
    assert.match(result.stdout, /^Usage: bb-shared-runtime <command> \[options\]/);
    assert.match(result.stdout, /compose-overlay/);
  }
  const missingValue = await fixture.run(["install", "--project-id"]);
  assert.equal(missingValue.code, 2);
  assert.equal(missingValue.stderr, "--project-id requires a value\n");
  const flagAsValue = await fixture.run(["install", "--runtime-root", "--json"]);
  assert.equal(flagAsValue.code, 2);
  assert.equal(flagAsValue.stderr, "--runtime-root requires a value\n");
  const unknown = await fixture.run(["list", "--verbose"]);
  assert.equal(unknown.code, 2);
  assert.equal(unknown.stderr, "Unknown option: --verbose\n");
  const unknownCommand = await fixture.run(["frobnicate"]);
  assert.equal(unknownCommand.code, 2);
  assert.match(unknownCommand.stderr, /^Unknown command: frobnicate\n\nUsage:/);
  assert.deepEqual(await fixture.bbCalls(), []);
});

test("install registers the checkout, pins the manifest, and installs the plugin", async (t) => {
  const fixture = await createFixture(t);
  await mkdir(fixture.runtimeRoot, { recursive: true, mode: 0o755 });
  await chmod(fixture.runtimeRoot, 0o755);

  const installed = await fixture.run(["install"]);
  assert.equal(installed.code, 0, installed.stderr);
  const digest = manifestDigest(await readFile(path.join(fixture.repo, ".bb-runtime.json")));
  assert.equal(
    installed.stdout,
    [
      `Registered example (proj_example) on host host_fixture with manifest ${digest.slice(0, 12)}; plugin installed.`,
      "Containers: worker=example_dev_worker, web=example_dev_web, api=example_dev_api",
      "",
    ].join("\n"),
  );

  const policy = await fixture.readPolicy();
  assert.equal(policy.projectId, "proj_example");
  assert.equal(policy.trustedHostId, "host_fixture");
  assert.equal(policy.primaryRoot, fixture.repo);
  assert.equal(policy.worktreeRoot, fixture.worktreeRoot);
  assert.equal(policy.worktreeDirectoryName, "example");
  assert.equal(policy.gitCommonDir, path.join(fixture.repo, ".git"));
  assert.equal(policy.dockerPath, path.join(fixture.bin, "docker"));
  assert.equal(policy.dockerSocket, "/fixture/docker.sock");
  assert.equal(policy.composeProject, "example_dev");
  assert.equal(policy.manifestSha256, digest);
  assert.equal(policy.manifestPath, undefined);
  assert.equal("codegraphCommand" in policy, false, "CodeGraph is retired and never pinned");
  assert.equal(policy.bbCli, path.join(fixture.bin, "bb"));
  assert.ok(!Number.isNaN(Date.parse(policy.installedAt)));
  assert.equal((await stat(fixture.policyPath())).mode & 0o777, 0o600);
  for (const directory of [
    fixture.runtimeRoot,
    path.join(fixture.runtimeRoot, "projects"),
    path.join(fixture.runtimeRoot, "locks"),
  ]) {
    assert.equal((await stat(directory)).mode & 0o777, 0o700, directory);
  }

  const calls = await fixture.bbCalls();
  assert.deepEqual(
    calls.map(({ args }) => args.join(" ")),
    ["project list --json", "plugin list --json", `plugin install --yes ${pluginRoot}`],
  );
  assert.ok(calls.every(({ bbCli }) => bbCli === path.join(fixture.bin, "bb")));

  const synced = await fixture.run(["sync"]);
  assert.equal(synced.code, 0, synced.stderr);
  assert.match(synced.stdout, /plugin reloaded\.$/m);
  assert.equal((await fixture.bbState()).reloads, 1);

  const quiet = await fixture.run(["install", "--no-reload"]);
  assert.equal(quiet.code, 0, quiet.stderr);
  assert.match(quiet.stdout, /plugin registered\.$/m);
  assert.equal((await fixture.bbState()).reloads, 1);
});

test("install honours explicit options and docker contexts", async (t) => {
  const fixture = await createFixture(t, {
    plugins: [{ id: "shared-runtime" }],
  });
  const state = await fixture.bbState();
  await writeFile(
    path.join(fixture.fixtureRoot, "bb-state.json"),
    JSON.stringify({ ...state, wrapPlugins: true }),
  );
  const externalManifest = path.join(fixture.fixtureRoot, "trusted.json");
  const document = JSON.parse(await readFile(fixtureManifestPath, "utf8"));
  document.containers.worker.containerName = "explicit-worker";
  delete document.compose;
  await writeFile(externalManifest, JSON.stringify(document));
  const otherRuntime = path.join(fixture.fixtureRoot, "custom-runtime");
  const otherWorktrees = path.join(fixture.fixtureRoot, "custom-worktrees");

  const result = await fixture.run(
    [
      "install",
      "--primary-root",
      fixture.repo,
      "--manifest",
      externalManifest,
      "--compose-project",
      "custom",
      "--docker-socket",
      "relative.sock",
      "--worktree-root",
      otherWorktrees,
      "--runtime-root",
      otherRuntime,
      "--project-id",
      "proj_example",
    ],
    { cwd: fixture.fixtureRoot },
  );
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /plugin reloaded\./);
  assert.match(
    result.stdout,
    /Containers: worker=explicit-worker, web=custom_web, api=custom_api/,
  );
  const policy = await fixture.readPolicy("proj_example", otherRuntime);
  assert.equal(policy.manifestPath, externalManifest);
  assert.equal(policy.manifestSha256, manifestDigest(await readFile(externalManifest)));
  assert.equal(policy.composeProject, "custom");
  assert.equal(policy.dockerSocket, path.join(fixture.fixtureRoot, "relative.sock"));
  assert.equal(policy.worktreeRoot, otherWorktrees);

  const fromContext = await fixture.run(["install", "--no-reload"], {
    env: { DOCKER_HOST: undefined, FAKE_DOCKER_CONTEXT: "unix:///context/docker.sock" },
  });
  assert.equal(fromContext.code, 0, fromContext.stderr);
  assert.equal((await fixture.readPolicy()).dockerSocket, "/context/docker.sock");

  const tcpContext = await fixture.run(["install", "--no-reload"], {
    env: { DOCKER_HOST: "tcp://127.0.0.1:2375", FAKE_DOCKER_CONTEXT: "tcp://remote:2376" },
  });
  assert.equal(tcpContext.code, 0, tcpContext.stderr);
  const tcpPolicy = await fixture.readPolicy();
  assert.equal(tcpPolicy.dockerSocket, null);

  const noContext = await fixture.run(["install", "--no-reload"], {
    env: { DOCKER_HOST: undefined, FAKE_DOCKER_CONTEXT: undefined },
  });
  assert.equal(noContext.code, 0, noContext.stderr);
  const noContextPolicy = await fixture.readPolicy();
  assert.equal(noContextPolicy.dockerSocket, null);
});

test("install refuses checkouts and projects it cannot trust", async (t) => {
  const fixture = await createFixture(t);
  const failures = [];
  const expectFailure = async (label, args, options, expected) => {
    const result = await fixture.run(args, options);
    assert.equal(result.code, 1, `${label}: ${result.stdout}${result.stderr}`);
    assert.match(result.stderr, expected, label);
    failures.push(label);
  };

  const notRepository = path.join(fixture.fixtureRoot, "plain");
  await mkdir(notRepository);
  await expectFailure(
    "not a repository",
    ["install"],
    { cwd: notRepository },
    new RegExp(`^${escapeRegExp(notRepository)} is not inside a Git repository\\n$`),
  );

  const separateGitDir = path.join(fixture.fixtureRoot, "separate-git");
  const separateCheckout = path.join(fixture.fixtureRoot, "separate-checkout");
  await git(fixture.fixtureRoot, "init", "--quiet", `--separate-git-dir=${separateGitDir}`, separateCheckout);
  await expectFailure(
    "linked checkout",
    ["install"],
    { cwd: separateCheckout },
    /^Refusing to manage the shared runtime from a linked worktree:\n {2}worktree: .*separate-checkout\n {2}primary: {2}.*\nRun this command from the primary checkout\.\n$/,
  );

  await expectFailure(
    "relative BB_CLI",
    ["install"],
    { env: { BB_CLI: "bb" } },
    /^BB_CLI is not an existing absolute executable: bb\n$/,
  );
  await expectFailure(
    "missing BB_CLI",
    ["install"],
    { env: { BB_CLI: path.join(fixture.bin, "absent-bb") } },
    /BB_CLI is not an existing absolute executable/,
  );
  await expectFailure(
    "wrong project id",
    ["install", "--project-id", "proj_other"],
    {},
    new RegExp(`^BB project proj_other has no local source at ${escapeRegExp(fixture.repo)}\\n$`),
  );
  // Linux runners ship docker in /usr/bin, so a system PATH cannot model its
  // absence; expose only git, the one host tool install needs before docker.
  const gitOnly = path.join(fixture.fixtureRoot, "git-only-bin");
  await mkdir(gitOnly);
  const { stdout: gitPath } = await execFileAsync("/bin/sh", ["-c", "command -v git"]);
  await symlink(gitPath.trim(), path.join(gitOnly, "git"));
  await expectFailure(
    "docker missing",
    ["install"],
    { env: { BB_CLI: path.join(fixture.bin, "bb"), PATH: gitOnly } },
    /^docker is not on PATH\n$/,
  );

  await writeFile(
    path.join(fixture.repo, "docker", "dev", ".env.local"),
    "PROJECT=\n",
  );
  await expectFailure(
    "compose project unset",
    ["install"],
    {},
    /^PROJECT is not set in docker\/dev\/\.env; pass --compose-project\n$/,
  );

  const noCompose = JSON.parse(await readFile(fixtureManifestPath, "utf8"));
  delete noCompose.compose;
  await writeFile(path.join(fixture.repo, ".bb-runtime.json"), JSON.stringify(noCompose));
  await expectFailure(
    "no compose project to derive names",
    ["install"],
    {},
    /^containers\.worker needs a Compose project name to derive its container name; pass --compose-project or declare compose\.envFile and compose\.projectVariable\n$/,
  );
  await expectFailure(
    "invalid manifest",
    ["install", "--manifest", path.join(fixture.fixtureRoot, "absent.json")],
    {},
    /Shared runtime manifest missing: .*absent\.json/,
  );
  assert.equal(failures.length, 9);
  await assert.rejects(stat(fixture.policyPath()), { code: "ENOENT" });
});

test("install rejects ambiguous projects, unusable names, and unconfigured Git identity", async (t) => {
  const repoPlaceholder = "__REPO__";
  const fixture = await createFixture(t, { gitUser: false, projects: [] });
  const writeProjects = async (projects) => {
    const state = await fixture.bbState();
    state.projects = JSON.parse(JSON.stringify(projects).replaceAll(repoPlaceholder, fixture.repo));
    await writeFile(path.join(fixture.fixtureRoot, "bb-state.json"), JSON.stringify(state));
  };
  const local = { type: "local_path", path: repoPlaceholder, hostId: "host_fixture" };

  let result = await fixture.run(["install"]);
  assert.equal(result.code, 1);
  assert.equal(
    result.stderr,
    `No BB project has a local source at ${fixture.repo}. Add the repository as a BB project first.\n`,
  );

  await writeProjects([
    { id: "proj_one", name: "one", sources: [local] },
    { id: "proj_two", name: "two", sources: [local] },
  ]);
  result = await fixture.run(["install"]);
  assert.equal(result.code, 1);
  assert.equal(
    result.stderr,
    `More than one BB project maps to ${fixture.repo}; pass --project-id (proj_one, proj_two)\n`,
  );

  result = await fixture.run(["install", "--project-id", "proj_two"]);
  assert.equal(result.code, 1);
  assert.equal(
    result.stderr,
    "Git user.name must be configured in the primary checkout before installation\n",
  );
  await git(fixture.repo, "config", "user.name", "Fixture User");
  result = await fixture.run(["install", "--project-id", "proj_two"]);
  assert.equal(
    result.stderr,
    "Git user.email must be configured in the primary checkout before installation\n",
  );
  await git(fixture.repo, "config", "user.email", "fixture@example.invalid");

  for (const name of ["", "a/b", ".", "..", 7]) {
    await writeProjects([{ id: "proj_named", name, sources: [local] }]);
    result = await fixture.run(["install"]);
    assert.equal(result.code, 1, JSON.stringify(name));
    assert.equal(
      result.stderr,
      "BB project proj_named has a name that cannot be a worktree directory\n",
    );
  }

  await writeProjects([{ id: "proj_named", name: "  padded  ", sources: [local] }]);
  result = await fixture.run(["install"]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal((await fixture.readPolicy("proj_named")).worktreeDirectoryName, "padded");
});

test("a bb CLI on PATH is found when BB_CLI is unset, and failures surface stderr", async (t) => {
  const fixture = await createFixture(t);
  const found = await fixture.run(["install", "--no-reload"]);
  assert.equal(found.code, 0, found.stderr);
  const policy = await fixture.readPolicy();
  assert.equal(policy.bbCli, path.join(fixture.bin, "bb"));

  await writeFile(path.join(fixture.fixtureRoot, "bb-state.json"), "{ corrupt");
  const crashed = await fixture.run(["install"]);
  assert.equal(crashed.code, 1);
  assert.match(crashed.stderr, /Command failed: .*bb project list --json/);
});

test("list, env, validate, and uninstall manage the host registry", async (t) => {
  const fixture = await createFixture(t, { plugins: [{ id: "shared-runtime" }] });
  let result = await fixture.run(["list"]);
  assert.equal(result.code, 0);
  assert.equal(result.stdout, "No projects are registered on this host.\n");

  result = await fixture.run(["uninstall"]);
  assert.equal(result.code, 1);
  assert.equal(result.stderr, `No registration exists for ${fixture.repo}\n`);

  assert.equal((await fixture.run(["install", "--no-reload"])).code, 0);
  await writeFile(path.join(fixture.runtimeRoot, "projects", "proj_bad.json"), "{}", { mode: 0o600 });

  result = await fixture.run(["list"]);
  assert.equal(result.code, 0);
  assert.equal(
    result.stdout,
    [
      `proj_example  ${fixture.repo}  compose=example_dev  ok`,
      `skipped ${path.join(fixture.runtimeRoot, "projects", "proj_bad.json")}: Shared runtime denied: policy projectId is missing or invalid`,
      "",
    ].join("\n"),
  );
  result = await fixture.run(["list", "--json"]);
  const listed = JSON.parse(result.stdout);
  assert.deepEqual(listed.projects, [
    {
      projectId: "proj_example",
      hostId: "host_fixture",
      primaryRoot: fixture.repo,
      composeProject: "example_dev",
      containers: {
        worker: "example_dev_worker",
        web: "example_dev_web",
        api: "example_dev_api",
      },
      manifestStale: false,
      manifestError: null,
    },
  ]);
  assert.equal(listed.problems.length, 1);

  const manifestPath = path.join(fixture.repo, ".bb-runtime.json");
  const original = await readFile(manifestPath, "utf8");
  await writeFile(manifestPath, `${original}\n`);
  result = await fixture.run(["list"]);
  assert.match(result.stdout, /compose=example_dev {2}manifest changed \(run sync\)/);
  await rm(manifestPath);
  result = await fixture.run(["list"]);
  assert.match(result.stdout, /compose=example_dev {2}manifest error: Shared runtime manifest missing/);
  await writeFile(manifestPath, original);

  result = await fixture.run(["env"]);
  assert.equal(
    result.stdout,
    `export BB_WORKTREES_ROOT=${JSON.stringify(fixture.worktreeRoot)}\nexport BB_PRIMARY_ROOT=${JSON.stringify(fixture.repo)}\n`,
  );
  result = await fixture.run(["env"], { env: { BB_WORKTREES_ROOT: undefined } });
  assert.match(result.stdout, new RegExp(`BB_WORKTREES_ROOT=${escapeRegExp(JSON.stringify(path.join(fixture.home, ".bb", "worktrees")))}`));

  result = await fixture.run(["validate"]);
  assert.equal(result.code, 0);
  const digest = manifestDigest(original);
  assert.match(
    result.stdout,
    new RegExp(`^${escapeRegExp(manifestPath)} is valid \\(sha256 ${digest.slice(0, 12)}\\)\\.\\n`),
  );
  assert.match(result.stdout, /^Containers: worker, web, api$/m);
  assert.match(result.stdout, /^Lifecycle: ensure, recreate, stop$/m);
  assert.match(result.stdout, /^ {2}go_full \(sequence: go_format_check, go_vet, go_tests\)$/m);

  const plain = path.join(fixture.fixtureRoot, "plain-manifest");
  await mkdir(plain);
  const minimal = { version: 1, containers: { app: { service: "app", mounts: [{ host: ".", container: "/app" }] } } };
  await writeFile(path.join(plain, ".bb-runtime.json"), JSON.stringify(minimal));
  result = await fixture.run(["validate"], { cwd: plain });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /^Lifecycle: -$/m);
  result = await fixture.run(["env"], { cwd: plain });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /is not inside a Git repository/);

  result = await fixture.run(["uninstall", "--no-reload"]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout, "Removed registration proj_example.\n");
  await assert.rejects(stat(fixture.policyPath()), { code: "ENOENT" });
  assert.equal((await fixture.bbState()).reloads, undefined);

  assert.equal((await fixture.run(["install", "--no-reload"])).code, 0);
  result = await fixture.run(["uninstall"]);
  assert.equal(result.stdout, "Removed registration proj_example.\n");
  assert.equal((await fixture.bbState()).reloads, 1);

  assert.equal((await fixture.run(["install", "--no-reload"])).code, 0);
  await rm(path.join(fixture.runtimeRoot, "projects", "proj_bad.json"));
  result = await fixture.run(["uninstall", "--remove-plugin"]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout, "Removed registration proj_example and the shared-runtime plugin.\n");
  assert.deepEqual((await fixture.bbState()).plugins, []);
  const removeCalls = (await fixture.bbCalls()).map(({ args }) => args.join(" "));
  assert.equal(removeCalls.at(-1), "plugin remove shared-runtime");

  result = await fixture.run(["uninstall", "--project-id", "proj_example", "--remove-plugin"]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout, "Removed registration proj_example and the shared-runtime plugin.\n");
  assert.equal((await fixture.bbCalls()).map(({ args }) => args.join(" ")).at(-1), "plugin list --json");

  result = await fixture.run(["uninstall", "--project-id", "proj_example"]);
  assert.equal(result.stdout, "Removed registration proj_example.\n");
});

test("uninstall refuses to guess between registrations for one checkout", async (t) => {
  const fixture = await createFixture(t);
  assert.equal((await fixture.run(["install", "--no-reload"])).code, 0);
  const policy = await fixture.readPolicy();
  await writeFile(
    fixture.policyPath("proj_copy"),
    JSON.stringify({ ...policy, projectId: "proj_copy" }),
    { mode: 0o600 },
  );
  const result = await fixture.run(["uninstall"]);
  assert.equal(result.code, 1);
  assert.equal(result.stderr, "More than one registration matches this checkout; pass --project-id\n");
  const targeted = await fixture.run(["uninstall", "--project-id", "proj_copy", "--no-reload"]);
  assert.equal(targeted.stdout, "Removed registration proj_copy.\n");
  assert.equal((await fixture.readPolicy()).projectId, "proj_example");
});

test("doctor verifies registration, manifest, and container mounts", async (t) => {
  const fixture = await createFixture(t);
  let result = await fixture.run(["doctor"]);
  assert.equal(result.code, 1);
  assert.equal(
    result.stdout,
    `error no registration for ${fixture.repo}; run bb-shared-runtime install\n`,
  );
  assert.equal(result.stderr, "doctor found errors\n");

  assert.equal((await fixture.run(["install", "--no-reload"])).code, 0);
  const worktreeAlias = path.join(fixture.fixtureRoot, "worktrees-alias");
  await symlink(fixture.worktreeRoot, worktreeAlias);
  const healthy = {
    example_dev_worker: [
      { Destination: "/bb-worktrees", Source: worktreeAlias },
      { Destination: "/app", Source: fixture.repo },
    ],
    example_dev_web: [
      { Destination: "/bb-worktrees", Name: fixture.worktreeRoot },
      { Destination: "/example-primary", Source: fixture.repo },
      { Destination: "/app", Source: path.join(fixture.repo, "src", "web") },
    ],
    example_dev_api: [
      { Destination: "/bb-worktrees", Source: fixture.worktreeRoot },
      { Destination: fixture.repo, Source: fixture.repo },
      { Destination: fixture.worktreeRoot, Source: fixture.worktreeRoot },
      { Destination: "/srv/api", Source: path.join(fixture.repo, "src", "api") },
    ],
  };
  await fixture.setMounts(healthy);
  result = await fixture.run(["doctor"]);
  assert.equal(result.code, 0, result.stdout + result.stderr);
  const digest = (await fixture.readPolicy()).manifestSha256;
  assert.equal(
    result.stdout,
    [
      "ok    registration proj_example on host host_fixture",
      `ok    manifest source: repo (${path.join(fixture.repo, ".bb-runtime.json")})`,
      `ok    script root: ${fixture.repo}`,
      `ok    manifest hash ${digest.slice(0, 12)} matches`,
      "ok    policy file permissions verified",
      "warn  isolation launcher is missing or does not match; reinstalled on the next operation",
      `ok    container worker: /bb-worktrees is mounted from ${worktreeAlias}`,
      `ok    container web: /bb-worktrees is mounted from ${fixture.worktreeRoot}`,
      `ok    container api: /bb-worktrees is mounted from ${fixture.worktreeRoot}`,
      "",
    ].join("\n"),
  );

  await mkdir(path.join(fixture.repo, ".bb-runtime"));
  const installedLauncher = path.join(fixture.repo, ".bb-runtime", "landlock-run");
  await copyFile(path.join(pluginRoot, "native", "prebuilt", "linux-arm64", "landlock-run"), installedLauncher);
  await chmod(installedLauncher, 0o555);
  await fixture.setMounts({
    example_dev_web: [
      { Destination: "/bb-worktrees", Source: "/elsewhere/worktrees" },
      { Destination: "/app", Source: "/x" },
    ],
    example_dev_api: [{ Destination: "/srv/api", Source: "/x" }],
  });
  result = await fixture.run(["doctor", "--json"]);
  assert.equal(result.code, 1);
  assert.equal(result.stderr, "doctor found errors\n");
  const { findings } = JSON.parse(result.stdout);
  assert.deepEqual(findings.slice(5), [
    { level: "ok", message: "isolation launcher is installed and verified" },
    { level: "error", message: "container worker (example_dev_worker) is not running or not created" },
    { level: "warn", message: "container web: /bb-worktrees is mounted from /elsewhere/worktrees" },
    {
      level: "error",
      message: "container web (example_dev_web) does not mount . at /example-primary",
    },
    { level: "error", message: "container api (example_dev_api) does not mount /bb-worktrees" },
    {
      level: "error",
      message: `container api (example_dev_api) does not mount . at ${fixture.repo}`,
    },
    {
      level: "error",
      message: `container api (example_dev_api) must also mount ${fixture.worktreeRoot} at the identical path for Git worktree metadata`,
    },
  ]);

  const manifestPath = path.join(fixture.repo, ".bb-runtime.json");
  const original = await readFile(manifestPath, "utf8");
  await fixture.setMounts(healthy);
  await writeFile(manifestPath, `${original}\n`);
  result = await fixture.run(["doctor", "--json"]);
  assert.equal(result.code, 1);
  assert.deepEqual(JSON.parse(result.stdout).findings[3], {
    level: "error",
    message: "manifest changed since installation; run bb-shared-runtime sync",
  });

  await writeFile(manifestPath, "{ not json");
  result = await fixture.run(["doctor", "--json"]);
  assert.equal(result.code, 1);
  assert.deepEqual(JSON.parse(result.stdout).findings, [
    { level: "ok", message: "registration proj_example on host host_fixture" },
    { level: "ok", message: `manifest source: repo (${manifestPath})` },
    { level: "ok", message: `script root: ${fixture.repo}` },
    {
      level: "error",
      message: `manifest: Shared runtime manifest invalid: ${manifestPath} is not valid JSON`,
    },
  ]);
});

test("doctor reports unresolved mount sources and a vanished worktree root", async (t) => {
  const fixture = await createFixture(t);
  assert.equal((await fixture.run(["install", "--no-reload"])).code, 0);
  await rm(fixture.worktreeRoot, { recursive: true, force: true });
  await fixture.setMounts({
    example_dev_worker: [{ Destination: "/bb-worktrees", Source: "/gone/worktrees" }],
    example_dev_web: [{ Destination: "/bb-worktrees", Source: "/gone/worktrees" }],
    example_dev_api: [{ Destination: "/bb-worktrees", Source: "/gone/worktrees" }],
  });
  const result = await fixture.run(["doctor", "--json"]);
  assert.equal(result.code, 1);
  const { findings } = JSON.parse(result.stdout);
  const launcherFinding = findings.find((finding) => /isolation launcher is missing or does not match/.test(finding.message));
  assert.ok(launcherFinding, "expected an isolation launcher warn finding");
  assert.equal(launcherFinding.level, "warn");
  assert.equal(launcherFinding.message, "isolation launcher is missing or does not match; reinstalled on the next operation");
  const goMount = findings.find((finding) => /container worker: \/bb-worktrees is mounted from \/gone\/worktrees/.test(finding.message));
  assert.ok(goMount, "expected a container worker mount warn finding");
  assert.equal(goMount.level, "warn");
  assert.equal(goMount.message, "container worker: /bb-worktrees is mounted from /gone/worktrees");
});

test("install derives the worktree root from the home directory without BB_WORKTREES_ROOT", async (t) => {
  const fixture = await createFixture(t);
  const result = await fixture.run(["install", "--no-reload"], {
    env: { BB_WORKTREES_ROOT: undefined },
  });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(
    (await fixture.readPolicy()).worktreeRoot,
    path.join(fixture.home, ".bb", "worktrees"),
  );
});

test("a wrapped plugin listing without a plugins array finds no installed plugin", async (t) => {
  const fixture = await createFixture(t);
  const state = await fixture.bbState();
  await writeFile(
    path.join(fixture.fixtureRoot, "bb-state.json"),
    JSON.stringify({ ...state, wrapPlugins: true, plugins: undefined }),
  );
  const result = await fixture.run(["install", "--no-reload"]);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /plugin installed\./);
  const calls = await fixture.bbCalls();
  assert.deepEqual(
    calls.map(({ args }) => args.join(" ")).at(-1),
    `plugin install --yes ${pluginRoot}`,
  );
});

test("list and doctor honour --runtime-root and render compose-less policies", async (t) => {
  const fixture = await createFixture(t);
  const customRoot = path.join(fixture.fixtureRoot, "custom-runtime");
  const installed = await fixture.run(["install", "--runtime-root", customRoot, "--no-reload"]);
  assert.equal(installed.code, 0, installed.stderr);
  const policy = await fixture.readPolicy("proj_example", customRoot);
  delete policy.composeProject;
  const noComposePath = path.join(customRoot, "projects", "proj_plain.json");
  await writeFile(
    noComposePath,
    JSON.stringify({ ...policy, projectId: "proj_plain" }),
    { mode: 0o600 },
  );

  const list = await fixture.run(["list", "--runtime-root", customRoot]);
  assert.equal(list.code, 0, list.stderr);
  assert.match(list.stdout, /^proj_example  .*  compose=example_dev  ok$/m);
  assert.match(list.stdout, /^proj_plain  .*  compose=-  ok$/m);

  const validated = await fixture.run(["validate", "--json"]);
  assert.equal(validated.code, 0, validated.stderr);
  const validatedDocument = JSON.parse(validated.stdout);
  assert.equal(validatedDocument.containers.join(", "), "worker, web, api");

  await fixture.setMounts({
    example_dev_worker: [{ Destination: "/bb-worktrees" }],
    example_dev_web: [{ Destination: "/bb-worktrees" }],
    example_dev_api: [{ Destination: "/bb-worktrees" }],
  });
  const doctor = await fixture.run(["doctor", "--runtime-root", customRoot, "--json"]);
  assert.equal(doctor.code, 1);
  const { findings } = JSON.parse(doctor.stdout);
  const registration = findings.find((finding) => /registration proj_example /.test(finding.message));
  assert.equal(registration.level, "ok");
  const goMount = findings.find((finding) => /container worker: \/bb-worktrees is mounted from /.test(finding.message));
  assert.equal(goMount.level, "warn");
  assert.equal(goMount.message, "container worker: /bb-worktrees is mounted from ");

  const removed = await fixture.run([
    "uninstall",
    "--runtime-root",
    customRoot,
    "--project-id",
    "proj_example",
    "--no-reload",
  ]);
  assert.equal(removed.code, 0, removed.stderr);
  assert.match(removed.stdout, /Removed registration proj_example\./);
});

// Origin: BB thread thr_69ubadfky5 — a project could not use the runtime without committing
// .bb-runtime.json and its scripts. These tests run a fixture repository that holds zero
// runtime files and keep the manifest, a script and an overlay in the host project directory.
const hostManifest = {
  version: 1,
  containers: {
    app: { service: "app", containerName: "demo_app", mounts: [{ host: ".", container: "/app" }] },
  },
  lifecycle: { ensure: ["bash", "ensure.sh"] },
};

async function createHostDirectoryFixture(t, { projectId = "proj_example", manifest = hostManifest } = {}) {
  const fixture = await createFixture(t, { manifest: false });
  await git(fixture.repo, "commit", "--allow-empty", "--quiet", "-m", "initial");
  const projectDirectory = path.join(fixture.runtimeRoot, "projects", projectId);
  for (const directory of [fixture.runtimeRoot, path.join(fixture.runtimeRoot, "projects"), projectDirectory]) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
  }
  const manifestPath = path.join(projectDirectory, ".bb-runtime.json");
  await writeFile(manifestPath, JSON.stringify(manifest), { mode: 0o600 });
  await writeFile(path.join(projectDirectory, "ensure.sh"), "#!/bin/bash\n", { mode: 0o700 });
  await writeFile(path.join(projectDirectory, "overlay.yml"), "services: {}\n", { mode: 0o600 });
  const excludePath = path.join(fixture.repo, ".git", "info", "exclude");
  return {
    ...fixture,
    manifestPath,
    projectDirectory,
    excludePath,
    registered: async (root = fixture.runtimeRoot) => (await loadRegistry(root)).policies.get(projectId),
  };
}

async function repoStatus(repo) {
  return (await git(repo, "status", "--porcelain", "--untracked-files=all")).stdout;
}

test("a project with zero committed runtime files installs from its host project directory", async (t) => {
  const fixture = await createHostDirectoryFixture(t);
  assert.equal(await repoStatus(fixture.repo), "", "the repository holds no runtime file");

  const installed = await fixture.run(["install", "--no-reload"]);
  assert.equal(installed.code, 0, installed.stderr);
  const digest = manifestDigest(await readFile(fixture.manifestPath));
  assert.match(installed.stdout, new RegExp(`with manifest ${digest.slice(0, 12)}; plugin installed\\.`));

  // The stored path comes from the real install output, and the registry loads it back.
  const stored = await fixture.readPolicy();
  assert.equal(stored.manifestPath, fixture.manifestPath);
  assert.equal("scriptRoot" in stored, false, "the script root is derived, never stored");
  const policy = await fixture.registered();
  assert.equal(policy.manifestError, null);
  assert.equal(policy.manifestStale, false);
  assert.equal(policy.scriptRoot, fixture.projectDirectory);
  assert.equal(policy.manifestSha256, digest);

  // The host directory keeps the runtime files out of git status.
  const excludes = await readFile(fixture.excludePath, "utf8");
  assert.ok(excludes.includes("\n/.bb-runtime/\n/.bb-runtime-isolation-*/\n"));
  await mkdir(path.join(fixture.repo, ".bb-runtime"));
  await writeFile(path.join(fixture.repo, ".bb-runtime", "landlock-run"), "x");
  await mkdir(path.join(fixture.repo, ".bb-runtime-isolation-1"));
  await writeFile(path.join(fixture.repo, ".bb-runtime-isolation-1", "f"), "x");
  assert.equal(await repoStatus(fixture.repo), "");

  // A second install adds nothing and keeps the registration.
  const before = await readFile(fixture.excludePath, "utf8");
  assert.equal((await fixture.run(["sync", "--no-reload"])).code, 0);
  assert.equal(await readFile(fixture.excludePath, "utf8"), before);

  // validate and compose-overlay read the same manifest from anywhere in the repository.
  const validated = await fixture.run(["validate"]);
  assert.equal(validated.code, 0, validated.stderr);
  assert.match(validated.stdout, new RegExp(`^${escapeRegExp(fixture.manifestPath)} is valid`));
  const overlay = await fixture.run(["compose-overlay"]);
  assert.equal(overlay.code, 0, overlay.stderr);
  assert.match(overlay.stdout, /^services:\n {2}app:\n/m);
});

test("a repository manifest keeps the primary checkout as its script root and writes no exclude lines", async (t) => {
  const fixture = await createHostDirectoryFixture(t);
  await rm(fixture.projectDirectory, { recursive: true });
  await writeFile(path.join(fixture.repo, ".bb-runtime.json"), JSON.stringify(hostManifest));
  const excludesBefore = await readFile(fixture.excludePath, "utf8");
  const installed = await fixture.run(["install", "--no-reload"]);
  assert.equal(installed.code, 0, installed.stderr);
  assert.equal((await fixture.readPolicy()).manifestPath, undefined);
  const policy = await fixture.registered();
  assert.equal(policy.manifestError, null);
  assert.equal(policy.scriptRoot, fixture.repo);
  assert.equal(await readFile(fixture.excludePath, "utf8"), excludesBefore);

  // An explicit --manifest naming the repository file is stored as no path at all.
  assert.equal(
    (await fixture.run(["install", "--no-reload", "--manifest", path.join(fixture.repo, ".bb-runtime.json")])).code,
    0,
  );
  assert.equal((await fixture.readPolicy()).manifestPath, undefined);
});

test("install denies two manifests and a missing manifest, and --manifest breaks the tie", async (t) => {
  const fixture = await createHostDirectoryFixture(t);
  const repoManifest = path.join(fixture.repo, ".bb-runtime.json");
  await writeFile(repoManifest, JSON.stringify(hostManifest));

  const both = await fixture.run(["install", "--no-reload"]);
  assert.equal(both.code, 1);
  assert.equal(
    both.stderr,
    `two manifests: ${fixture.manifestPath} and ${repoManifest}; remove one or pass --manifest\n`,
  );
  await assert.rejects(stat(fixture.policyPath()), { code: "ENOENT" }, "nothing was registered");
  assert.equal((await readFile(fixture.excludePath, "utf8")).includes("/.bb-runtime/"), false, "no exclude lines before the install is accepted");

  const explicitHost = await fixture.run(["install", "--no-reload", "--manifest", fixture.manifestPath]);
  assert.equal(explicitHost.code, 0, explicitHost.stderr);
  assert.equal((await fixture.readPolicy()).manifestPath, fixture.manifestPath);
  assert.equal((await fixture.registered()).scriptRoot, fixture.projectDirectory);
  const explicitRepo = await fixture.run(["install", "--no-reload", "--manifest", repoManifest]);
  assert.equal(explicitRepo.code, 0, explicitRepo.stderr);
  assert.equal((await fixture.readPolicy()).manifestPath, undefined);
  assert.equal((await fixture.registered()).scriptRoot, fixture.repo);

  await rm(repoManifest);
  await rm(fixture.manifestPath);
  const none = await fixture.run(["install", "--no-reload"]);
  assert.equal(none.code, 1);
  assert.match(none.stderr, /^No manifest found\. Searched: /);
  assert.ok(none.stderr.includes(fixture.manifestPath), "the concrete project directory path is listed");
  assert.ok(none.stderr.includes(repoManifest), "the repository path is listed");
  assert.match(none.stderr, /`bb project list`/);
});

test("install refuses an untrusted host directory with the fix, and a failing exclude write registers nothing", async (t) => {
  const fixture = await createHostDirectoryFixture(t);
  await chmod(fixture.projectDirectory, 0o755);
  const loose = await fixture.run(["install", "--no-reload"]);
  assert.equal(loose.code, 1);
  assert.match(loose.stderr, /must have mode 0700; fix: chmod 700 /);
  await assert.rejects(stat(fixture.policyPath()), { code: "ENOENT" });
  await chmod(fixture.projectDirectory, 0o700);

  const target = path.join(fixture.fixtureRoot, "elsewhere");
  await writeFile(target, "untouched\n");
  await rm(fixture.excludePath, { force: true });
  await symlink(target, fixture.excludePath);
  const linked = await fixture.run(["install", "--no-reload"]);
  assert.equal(linked.code, 1);
  assert.match(linked.stderr, /^Refusing to write .*exclude: it is a symlink\n$/);
  assert.equal(await readFile(target, "utf8"), "untouched\n");
  await assert.rejects(stat(fixture.policyPath()), { code: "ENOENT" }, "no half-finished registration");
  await rm(fixture.excludePath);
  assert.equal((await fixture.run(["install", "--no-reload"])).code, 0);
});

test("sync keeps the host-directory path, the custom runtime root and its script root", async (t) => {
  const fixture = await createHostDirectoryFixture(t);
  assert.equal((await fixture.run(["install", "--no-reload"])).code, 0);

  // The invocation the runtime tool builds: it passes the runtime root and the stored path.
  await writeFile(path.join(fixture.repo, ".bb-runtime.json"), JSON.stringify(hostManifest));
  const synced = await fixture.run([
    "sync",
    "--project-id",
    "proj_example",
    "--runtime-root",
    fixture.runtimeRoot,
    "--manifest",
    fixture.manifestPath,
    "--no-reload",
  ]);
  assert.equal(synced.code, 0, synced.stderr);
  assert.equal((await fixture.readPolicy()).manifestPath, fixture.manifestPath, "the stored path wins over a repository file that appeared later");
  assert.equal((await fixture.registered()).scriptRoot, fixture.projectDirectory);

  // A manual sync without --manifest re-resolves the path and reports the two manifests.
  const manual = await fixture.run(["sync", "--no-reload"]);
  assert.equal(manual.code, 1);
  assert.match(manual.stderr, /^two manifests: /);
  await rm(path.join(fixture.repo, ".bb-runtime.json"));

  // A non-default runtime root keeps its own host directory.
  const otherRoot = path.join(fixture.fixtureRoot, "other-runtime");
  const otherDirectory = path.join(otherRoot, "projects", "proj_example");
  await mkdir(otherDirectory, { recursive: true, mode: 0o700 });
  await chmod(otherRoot, 0o700);
  await chmod(path.join(otherRoot, "projects"), 0o700);
  await chmod(otherDirectory, 0o700);
  await writeFile(path.join(otherDirectory, ".bb-runtime.json"), JSON.stringify(hostManifest), { mode: 0o600 });
  const other = await fixture.run(["install", "--runtime-root", otherRoot, "--no-reload"]);
  assert.equal(other.code, 0, other.stderr);
  const otherManifest = path.join(otherDirectory, ".bb-runtime.json");
  assert.equal((await fixture.readPolicy("proj_example", otherRoot)).manifestPath, otherManifest);
  const resynced = await fixture.run([
    "sync",
    "--project-id",
    "proj_example",
    "--runtime-root",
    otherRoot,
    "--manifest",
    otherManifest,
    "--no-reload",
  ]);
  assert.equal(resynced.code, 0, resynced.stderr);
  const otherPolicy = await fixture.registered(otherRoot);
  assert.equal(otherPolicy.manifestPath, otherManifest);
  assert.equal(otherPolicy.scriptRoot, otherDirectory);
  // Without --runtime-root the same invocation would have looked in the default root.
  assert.equal((await fixture.readPolicy()).manifestPath, fixture.manifestPath);
});

test("validate and compose-overlay resolve the manifest in order and degrade on any checkout", async (t) => {
  const fixture = await createHostDirectoryFixture(t);
  const repoManifest = path.join(fixture.repo, ".bb-runtime.json");
  const custom = path.join(fixture.fixtureRoot, "custom.bb-runtime.json");
  await writeFile(custom, JSON.stringify(hostManifest));
  const validateFrom = (args = [], options = {}) => fixture.run(["validate", ...args], options);

  // Host directory only.
  let result = await validateFrom();
  assert.equal(result.code, 0, result.stderr);
  assert.ok(result.stdout.startsWith(`${fixture.manifestPath} is valid`));
  // Repository only.
  await rm(fixture.manifestPath);
  await writeFile(repoManifest, JSON.stringify(hostManifest));
  result = await validateFrom();
  assert.ok(result.stdout.startsWith(`${repoManifest} is valid`));
  // Both present: deny, for both commands.
  await writeFile(fixture.manifestPath, JSON.stringify(hostManifest), { mode: 0o600 });
  for (const command of ["validate", "compose-overlay"]) {
    result = await fixture.run([command]);
    assert.equal(result.code, 1, command);
    assert.match(result.stderr, /^two manifests: .* and .*; remove one or pass --manifest\n$/);
  }
  // --manifest breaks the tie and wins over everything.
  result = await validateFrom(["--manifest", custom]);
  assert.ok(result.stdout.startsWith(`${custom} is valid`));
  result = await fixture.run(["compose-overlay", "--manifest", custom]);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /^services:\n {2}app:/m);

  // The registered path wins over both files.
  await rm(fixture.manifestPath);
  assert.equal((await fixture.run(["install", "--no-reload", "--manifest", custom])).code, 0);
  assert.equal((await fixture.readPolicy()).manifestPath, custom);
  await writeFile(fixture.manifestPath, JSON.stringify(hostManifest), { mode: 0o600 });
  result = await validateFrom();
  assert.equal(result.code, 0, result.stderr);
  assert.ok(result.stdout.startsWith(`${custom} is valid`));
  result = await fixture.run(["compose-overlay"]);
  assert.equal(result.code, 0, result.stderr);
  await rm(fixture.policyPath());
  await rm(fixture.manifestPath);
  await rm(repoManifest);

  // None found: deny, listing both searched paths.
  result = await validateFrom();
  assert.equal(result.code, 1);
  assert.ok(result.stderr.includes(fixture.manifestPath) && result.stderr.includes(repoManifest));
  assert.match(result.stderr, /`bb project list`/);

  // A host manifest that is not private is refused by validate too.
  await writeFile(fixture.manifestPath, JSON.stringify(hostManifest), { mode: 0o600 });
  await chmod(fixture.manifestPath, 0o666);
  result = await validateFrom();
  assert.equal(result.code, 1);
  assert.match(result.stderr, /group- or world-writable; fix: chmod go-w /);
  await rm(fixture.manifestPath);

  // Degraded lookups: each skips the registered and host-directory steps with a note and
  // falls back to the repository file.
  await writeFile(repoManifest, JSON.stringify(hostManifest));
  const note = /^note: the registered and host-directory manifests are not searched: /m;
  const expectDegraded = (output, label) => {
    assert.equal(output.code, 0, `${label}: ${output.stderr}`);
    assert.match(output.stderr, note, label);
    assert.ok(output.stdout.startsWith(`${repoManifest} is valid`), label);
  };
  expectDegraded(await validateFrom([], { env: { BB_CLI: path.join(fixture.bin, "absent-bb") } }), "bb CLI unavailable");

  const writeProjects = async (projects) => {
    const state = await fixture.bbState();
    state.projects = JSON.parse(JSON.stringify(projects).replaceAll("__REPO__", fixture.repo));
    await writeFile(path.join(fixture.fixtureRoot, "bb-state.json"), JSON.stringify(state));
  };
  const local = { type: "local_path", path: "__REPO__", hostId: "host_fixture" };
  await writeProjects([{ id: "proj_unrelated", name: "unrelated", sources: [] }]);
  expectDegraded(await validateFrom(), "no project matches");
  await writeProjects([
    { id: "proj_one", name: "one", sources: [local] },
    { id: "proj_two", name: "two", sources: [local] },
  ]);
  expectDegraded(await validateFrom(), "more than one project matches");
  await writeProjects([{ id: "proj_example", name: "example", sources: [local] }]);
  const brokenRoot = path.join(fixture.fixtureRoot, "broken-runtime");
  await mkdir(brokenRoot, { recursive: true });
  await writeFile(path.join(brokenRoot, "projects"), "not a directory");
  expectDegraded(await validateFrom(["--runtime-root", brokenRoot]), "registry unusable");

  // Not a git repository: the current directory is the checkout.
  const plain = path.join(fixture.fixtureRoot, "plain");
  await mkdir(plain);
  await writeFile(path.join(plain, ".bb-runtime.json"), JSON.stringify(hostManifest));
  result = await validateFrom([], { cwd: plain });
  assert.equal(result.code, 0, result.stderr);
  assert.ok(result.stdout.startsWith(`${path.join(plain, ".bb-runtime.json")} is valid`));
  result = await fixture.run(["compose-overlay"], { cwd: plain });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stderr, note);

  // A linked worktree: the worktree directory is the checkout.
  const worktree = path.join(fixture.fixtureRoot, "linked");
  await git(fixture.repo, "worktree", "add", "--quiet", worktree, "-b", "linked");
  await writeFile(path.join(worktree, ".bb-runtime.json"), JSON.stringify(hostManifest));
  result = await validateFrom([], { cwd: worktree });
  assert.equal(result.code, 0, result.stderr);
  assert.ok(result.stdout.startsWith(`${path.join(await realpath(worktree), ".bb-runtime.json")} is valid`));
  result = await fixture.run(["compose-overlay"], { cwd: worktree });
  assert.equal(result.code, 0, result.stderr);
});

test("doctor reports the manifest source, the script root, the trust result and the exclude lines", async (t) => {
  const fixture = await createHostDirectoryFixture(t);
  assert.equal((await fixture.run(["install", "--no-reload"])).code, 0);
  await fixture.setMounts({ demo_app: [{ Destination: "/bb-worktrees", Source: fixture.worktreeRoot }] });
  const findingsOf = async () => JSON.parse((await fixture.run(["doctor", "--json"])).stdout).findings;

  let findings = await findingsOf();
  assert.deepEqual(findings.slice(0, 5), [
    { level: "ok", message: "registration proj_example on host host_fixture" },
    { level: "ok", message: `manifest source: host dir (${fixture.manifestPath})` },
    { level: "ok", message: `script root: ${fixture.projectDirectory}` },
    {
      level: "ok",
      message: "host directory trust check passed (0700 directory, user-owned manifest, no links, not group- or world-writable)",
    },
    { level: "ok", message: `git exclude lines are present in ${fixture.excludePath}` },
  ]);

  await rm(fixture.excludePath);
  findings = await findingsOf();
  assert.deepEqual(findings[4], {
    level: "warn",
    message: `git exclude lines missing from ${fixture.excludePath}: /.bb-runtime/, /.bb-runtime-isolation-*/; run bb-shared-runtime sync`,
  });
  await mkdir(fixture.excludePath);
  findings = await findingsOf();
  assert.equal(findings[4].level, "error");
  assert.match(findings[4].message, /^git exclude file: /);
  await rm(fixture.excludePath, { recursive: true });

  await chmod(fixture.projectDirectory, 0o755);
  findings = await findingsOf();
  assert.deepEqual(findings[3], {
    level: "error",
    message: "host directory trust check failed (see the manifest finding below)",
  });
  assert.ok(
    findings.some((finding) => finding.level === "error" && /manifest: .*must have mode 0700; fix: chmod 700/.test(finding.message)),
  );
  await chmod(fixture.projectDirectory, 0o700);

  // A custom manifest path is reported as custom and has no host-directory checks.
  const custom = path.join(fixture.fixtureRoot, "custom.bb-runtime.json");
  await writeFile(custom, JSON.stringify(hostManifest));
  assert.equal((await fixture.run(["install", "--no-reload", "--manifest", custom])).code, 0);
  findings = await findingsOf();
  assert.deepEqual(findings.slice(1, 4).map((finding) => finding.message), [
    `manifest source: custom (${custom})`,
    `script root: ${fixture.repo}`,
    `manifest hash ${manifestDigest(await readFile(custom)).slice(0, 12)} matches`,
  ]);
});

test("uninstall leaves the host directory and the exclude lines in place", async (t) => {
  const fixture = await createHostDirectoryFixture(t);
  assert.equal((await fixture.run(["install", "--no-reload"])).code, 0);
  const excludes = await readFile(fixture.excludePath, "utf8");
  const removed = await fixture.run(["uninstall", "--no-reload"]);
  assert.equal(removed.code, 0, removed.stderr);
  await assert.rejects(stat(fixture.policyPath()), { code: "ENOENT" });
  assert.equal((await stat(fixture.manifestPath)).isFile(), true);
  assert.equal(await readFile(fixture.excludePath, "utf8"), excludes);
});
