import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import * as fsPromises from "node:fs/promises";
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { mock } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFileCallback);

// resolveBbCli probes hard-coded host candidate paths, so the filesystem
// seams below decide which candidates exist without touching the host. Every
// seam is restored after each test.
const fsHooks = {};

function hookedFs(name, ...args) {
  const implementation = fsHooks[name];
  return implementation ? implementation(...args) : fsPromises[name](...args);
}

mock.module("node:fs/promises", {
  namedExports: {
    ...fsPromises,
    access: (...args) => hookedFs("access", ...args),
    stat: (...args) => hookedFs("stat", ...args),
    lstat: (...args) => hookedFs("lstat", ...args),
    realpath: (...args) => hookedFs("realpath", ...args),
    open: (...args) => hookedFs("open", ...args),
  },
});

const cliHost = await import("../src/cli-host.mjs");

const originalBbCli = process.env.BB_CLI;
const originalPath = process.env.PATH;

test.afterEach(() => {
  for (const name of Object.keys(fsHooks)) {
    delete fsHooks[name];
  }
  if (originalBbCli === undefined) {
    delete process.env.BB_CLI;
  } else {
    process.env.BB_CLI = originalBbCli;
  }
  if (originalPath === undefined) {
    delete process.env.PATH;
  } else {
    process.env.PATH = originalPath;
  }
});

test("pathExists rethrows lstat failures other than ENOENT", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "cli-host-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const blocker = path.join(root, "blocker");
  await writeFile(blocker, "file\n");
  await assert.rejects(cliHost.pathExists(path.join(blocker, "child")), { code: "ENOTDIR" });
  assert.equal(await cliHost.pathExists(path.join(root, "absent")), false);
});

test("without BB_CLI and without a PATH hit, the CLI candidates are tried in order", async (t) => {
  delete process.env.BB_CLI;
  const emptyDirectory = await mkdtemp(path.join(tmpdir(), "cli-host-empty-"));
  t.after(() => rm(emptyDirectory, { recursive: true, force: true }));
  process.env.PATH = emptyDirectory;
  // Candidate probes must not depend on the host: every path is absent here,
  // including the real /opt/homebrew/bin/bb of a developer machine.
  const absent = async () => {
    throw Object.assign(new Error("absent"), { code: "ENOENT" });
  };
  fsHooks.access = absent;
  fsHooks.stat = absent;
  fsHooks.lstat = absent;
  await assert.rejects(
    cliHost.resolveBbCli(),
    /Could not resolve the BB CLI\. Set BB_CLI/,
  );
});

test("a host without PATH finds no CLI on the search path", async (t) => {
  delete process.env.BB_CLI;
  delete process.env.PATH;
  const absent = async () => {
    throw Object.assign(new Error("absent"), { code: "ENOENT" });
  };
  fsHooks.access = absent;
  fsHooks.stat = absent;
  fsHooks.lstat = absent;
  await assert.rejects(
    cliHost.resolveBbCli(),
    /Could not resolve the BB CLI\. Set BB_CLI/,
  );
});

test("an executable candidate satisfies the CLI lookup without PATH", async (t) => {
  delete process.env.BB_CLI;
  const emptyDirectory = await mkdtemp(path.join(tmpdir(), "cli-host-candidate-"));
  t.after(() => rm(emptyDirectory, { recursive: true, force: true }));
  process.env.PATH = emptyDirectory;
  const candidate = "/opt/homebrew/bin/bb";
  fsHooks.access = async (target) => {
    if (target === candidate) {
      return;
    }
    throw Object.assign(new Error("absent"), { code: "ENOENT" });
  };
  fsHooks.stat = async (target) => {
    if (target === candidate) {
      return { isFile: () => true };
    }
    throw Object.assign(new Error("absent"), { code: "ENOENT" });
  };
  fsHooks.lstat = fsHooks.stat;
  fsHooks.realpath = async () => "/resolved/bb";
  assert.equal(await cliHost.resolveBbCli(), "/resolved/bb");
});

test("doctor reports a policy file that fails only on re-verification", async (t) => {
  const fixtureRoot = await realpath(await mkdtemp(path.join(tmpdir(), "doctor-recheck-")));
  t.after(() => rm(fixtureRoot, { recursive: true, force: true }));
  const repo = path.join(fixtureRoot, "repo");
  const runtimeRoot = path.join(fixtureRoot, "runtime");
  const projectsRoot = path.join(runtimeRoot, "projects");
  await execFileAsync("git", ["init", "--quiet", repo], {
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
  });
  await mkdir(projectsRoot, { recursive: true, mode: 0o700 });
  await chmod(runtimeRoot, 0o700);
  await writeFile(path.join(repo, ".bb-runtime.json"), JSON.stringify({
    version: 1,
    containers: { app: { service: "app", mounts: [{ host: ".", container: "/app" }] } },
  }));
  const digest = "b".repeat(64);
  const policyPath = path.join(projectsRoot, "proj_fixture.json");
  await writeFile(policyPath, JSON.stringify({
    projectId: "proj_fixture",
    trustedHostId: "host_fixture",
    primaryRoot: repo,
    worktreeRoot: path.join(fixtureRoot, "worktrees"),
    worktreeDirectoryName: "fixture",
    gitCommonDir: path.join(repo, ".git"),
    dockerPath: "/nonexistent/docker",
    manifestSha256: digest,
    containers: { app: "fixture_app" },
  }) + "\n", { mode: 0o600 });

  // The registry load reads the policy once; the doctor re-verification gets
  // an injected EACCES on the same path.
  let opens = 0;
  fsHooks.open = async (filePath, ...rest) => {
    if (filePath === policyPath) {
      opens += 1;
      if (opens >= 2) {
        throw Object.assign(new Error("policy file changed under us"), { code: "EACCES" });
      }
    }
    return fsPromises.open(filePath, ...rest);
  };

  const { commandDoctor } = await import("../src/cli-inspect.mjs");
  const previousCwd = process.cwd();
  process.chdir(repo);
  t.after(() => process.chdir(previousCwd));
  await assert.rejects(
    commandDoctor({ values: { "runtime-root": runtimeRoot }, flags: new Set(["json"]) }),
    /doctor found errors/,
  );
  assert.equal(opens, 2, "the policy file was read twice");
});

test("a non-Error rejection from a command reaches the String(error) fallback", async (t) => {
  const work = await mkdtemp(path.join(tmpdir(), "bin-non-error-"));
  t.after(() => rm(work, { recursive: true, force: true }));
  const thrower = [
    "export async function commandList() { throw 'boom-string'; }",
    "export async function commandValidate() { throw 'boom-string'; }",
    "export async function commandEnv() { throw 'boom-string'; }",
    "export async function commandComposeOverlay() { throw 'boom-string'; }",
    "export async function commandDoctor() { throw 'boom-string'; }",
  ].join("\n");
  const throwerUrl = "data:text/javascript," + encodeURIComponent(thrower);
  const hookSource = [
    "const target = process.env.BIN_THROWER_URL;",
    "export async function resolve(specifier, context, nextResolve) {",
    "  if (specifier.endsWith(\"cli-inspect.mjs\")) {",
    "    return { shortCircuit: true, url: target };",
    "  }",
    "  return nextResolve(specifier, context);",
    "}",
  ].join("\n");
  const hookPath = path.join(work, "throw-hook.mjs");
  const preloadPath = path.join(work, "register-hook.mjs");
  await writeFile(hookPath, hookSource);
  await writeFile(preloadPath, "import { register } from 'node:module';\nimport { pathToFileURL } from 'node:url';\nregister(pathToFileURL(" + JSON.stringify(hookPath) + "));\n");

  const binPath = path.join(path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."), "bin", "bb-shared-runtime.mjs");
  await assert.rejects(
    execFileAsync(process.execPath, ["--import", preloadPath, binPath, "list"], {
      env: { ...process.env, BIN_THROWER_URL: throwerUrl },
    }),
    (error) => error.code === 1 && error.stderr === "boom-string\n",
  );
});
