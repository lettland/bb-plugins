import assert from "node:assert/strict";
import * as fsPromises from "node:fs/promises";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { mock } from "node:test";
import { fileURLToPath } from "node:url";

// The asset directory and the bundled launcher paths are fixed constants, so the
// fs seams below inject the failure states (a vanished assets directory, a
// missing or unreadable SHA256SUMS, a corrupt bundled binary, an unreadable
// installed launcher) that cannot be produced against the real checkout. Every
// seam is restored after each test.
const fsHooks = {};
const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function hookedFs(name, ...args) {
  const implementation = fsHooks[name];
  return implementation ? implementation(...args) : fsPromises[name](...args);
}

mock.module("node:fs/promises", {
  namedExports: {
    ...fsPromises,
    lstat: (...args) => hookedFs("lstat", ...args),
    readFile: (...args) => hookedFs("readFile", ...args),
    readdir: (...args) => hookedFs("readdir", ...args),
  },
});

const { ensureIsolationLauncher, ensureRuntimeAssets, installedLauncherVerified } = await import(
  "../src/isolation-launcher.mjs"
);

test.afterEach(() => {
  for (const name of Object.keys(fsHooks)) {
    delete fsHooks[name];
  }
});

const sumsPath = path.join(pluginRoot, "native", "prebuilt", "SHA256SUMS");
const bundledPath = (architecture) =>
  path.join(pluginRoot, "native", "prebuilt", `linux-${architecture}`, "landlock-run");
const missing = () => Object.assign(new Error("absent"), { code: "ENOENT" });
const denied = () => Object.assign(new Error("denied"), { code: "EACCES" });

function policyFor(primaryRoot) {
  return { primaryRoot, dockerPath: "/fixture/bin/docker" };
}

// A fake Docker daemon that reports the given architecture.
const daemon = (architecture) => async () => ({ stdout: `${architecture}\n` });

// Replace what readFile returns for one path; every other path reads the real file.
function readOverride(target, implementation) {
  fsHooks.readFile = async (filePath, ...rest) =>
    filePath === target ? implementation() : fsPromises.readFile(filePath, ...rest);
}

test("an unreadable assets directory publishes an empty asset set", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "launcher-mocks-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  fsHooks.readdir = async (directory) => {
    if (directory === path.join(pluginRoot, "assets")) {
      throw Object.assign(new Error("absent"), { code: "ENOENT" });
    }
    return fsPromises.readdir(directory);
  };
  const target = await ensureRuntimeAssets(policyFor(root));
  assert.equal(target, path.join(root, ".bb-runtime", "assets"));
  const marker = await readFile(path.join(root, ".bb-runtime", "assets.sha256"), "utf8");
  // sha256 of the empty input.
  assert.equal(
    marker,
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855\n",
  );
  assert.deepEqual(await fsPromises.readdir(target), []);
});

test("an unreadable installed launcher surfaces the error instead of reinstalling", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "launcher-mocks-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const installed = path.join(root, ".bb-runtime", "landlock-run");
  await ensureIsolationLauncher(policyFor(root), { run: daemon("arm64") });
  readOverride(installed, () => {
    throw denied();
  });
  await assert.rejects(ensureIsolationLauncher(policyFor(root), { run: daemon("arm64") }), {
    code: "EACCES",
  });
});

test("an installed launcher that vanishes between lstat and read is reinstalled", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "launcher-mocks-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const installed = path.join(root, ".bb-runtime", "landlock-run");
  await ensureIsolationLauncher(policyFor(root), { run: daemon("arm64") });
  readOverride(installed, () => {
    throw missing();
  });
  assert.equal(await ensureIsolationLauncher(policyFor(root), { run: daemon("arm64") }), installed);
  delete fsHooks.readFile;
  assert.equal(await installedLauncherVerified(root), true, "the reinstalled launcher verifies");
});

test("an installed launcher that cannot be inspected surfaces errors other than ENOENT", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "launcher-mocks-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const installed = path.join(root, ".bb-runtime", "landlock-run");
  fsHooks.lstat = async (filePath, ...rest) => {
    if (filePath === installed) {
      throw denied();
    }
    return fsPromises.lstat(filePath, ...rest);
  };
  await assert.rejects(ensureIsolationLauncher(policyFor(root), { run: daemon("arm64") }), {
    code: "EACCES",
  });
});

test("a missing SHA256SUMS denies, and an unreadable one surfaces its error", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "launcher-mocks-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  readOverride(sumsPath, () => {
    throw missing();
  });
  await assert.rejects(ensureIsolationLauncher(policyFor(root), { run: daemon("arm64") }), {
    message: "Shared runtime denied: native/prebuilt/SHA256SUMS is missing",
  });
  await assert.rejects(installedLauncherVerified(root), {
    message: "Shared runtime denied: native/prebuilt/SHA256SUMS is missing",
  });
  readOverride(sumsPath, () => {
    throw denied();
  });
  await assert.rejects(ensureIsolationLauncher(policyFor(root), { run: daemon("arm64") }), {
    code: "EACCES",
  });
  await assert.rejects(fsPromises.lstat(path.join(root, ".bb-runtime", "landlock-run")), {
    code: "ENOENT",
  });
});

test("a SHA256SUMS without the daemon architecture's line denies", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "launcher-mocks-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const realSums = await fsPromises.readFile(sumsPath, "utf8");
  readOverride(sumsPath, () =>
    realSums
      .split("\n")
      .filter((line) => !line.endsWith("linux-arm64/landlock-run"))
      .join("\n"),
  );
  await assert.rejects(ensureIsolationLauncher(policyFor(root), { run: daemon("arm64") }), {
    message: "Shared runtime denied: native/prebuilt/SHA256SUMS has no entry for linux-arm64",
  });
  assert.equal(
    await ensureIsolationLauncher(policyFor(root), { run: daemon("amd64") }),
    path.join(root, ".bb-runtime", "landlock-run"),
    "the other architecture's line is still honoured",
  );
});

test("a missing, unreadable, or corrupt bundled binary denies the install", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "launcher-mocks-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  readOverride(bundledPath("arm64"), () => {
    throw missing();
  });
  await assert.rejects(ensureIsolationLauncher(policyFor(root), { run: daemon("arm64") }), {
    message: "Shared runtime denied: the bundled launcher for linux-arm64 is missing",
  });
  readOverride(bundledPath("arm64"), () => {
    throw denied();
  });
  await assert.rejects(ensureIsolationLauncher(policyFor(root), { run: daemon("arm64") }), {
    code: "EACCES",
  });
  readOverride(bundledPath("arm64"), () => Buffer.from("one byte changed"));
  await assert.rejects(ensureIsolationLauncher(policyFor(root), { run: daemon("arm64") }), {
    message:
      "Shared runtime denied: the bundled launcher for linux-arm64 does not match native/prebuilt/SHA256SUMS",
  });
  await assert.rejects(fsPromises.lstat(path.join(root, ".bb-runtime", "landlock-run")), {
    code: "ENOENT",
  });
});

test("the assets digest ignores dot files and directories", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "launcher-mocks-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  fsHooks.readdir = async (directory) => {
    if (directory === path.join(pluginRoot, "assets")) {
      return [
        { isFile: () => true, name: "node-copy-compat-preload.cjs" },
        { isFile: () => true, name: ".hidden" },
        { isFile: () => false, name: "subdir" },
      ];
    }
    return fsPromises.readdir(directory);
  };
  const target = await ensureRuntimeAssets(policyFor(root));
  assert.deepEqual(await fsPromises.readdir(target), ["node-copy-compat-preload.cjs"]);
  const marker = await readFile(path.join(root, ".bb-runtime", "assets.sha256"), "utf8");
  assert.match(marker, /^[0-9a-f]{64}\n$/);
});

test("an unreadable assets directory surfaces errors other than ENOENT", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "launcher-mocks-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  fsHooks.readdir = async (directory) => {
    if (directory === path.join(pluginRoot, "assets")) {
      throw Object.assign(new Error("denied"), { code: "EACCES" });
    }
    return fsPromises.readdir(directory);
  };
  await assert.rejects(ensureRuntimeAssets(policyFor(root)), { code: "EACCES" });
});
