import assert from "node:assert/strict";
import * as fsPromises from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import path from "node:path";
import test, { mock } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

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
    copyFile: (...args) => hookedFs("copyFile", ...args),
    lstat: (...args) => hookedFs("lstat", ...args),
    readFile: (...args) => hookedFs("readFile", ...args),
    readdir: (...args) => hookedFs("readdir", ...args),
    rename: (...args) => hookedFs("rename", ...args),
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
  assert.deepEqual(await fsPromises.readdir(target), []);
  assert.equal(await ensureRuntimeAssets(policyFor(root)), target, "the empty set is reused");
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

const bundledAssetNames = async () =>
  (await fsPromises.readdir(path.join(pluginRoot, "assets"))).filter((name) => !name.startsWith("."));

// The other call wins the publish race: its directory is already in place when ours renames.
function raceWith(publish) {
  fsHooks.rename = async (from, to) => {
    await fsPromises.mkdir(to, { recursive: true });
    await publish(to);
    return fsPromises.rename(from, to);
  };
}

test("another process that published matching assets between our rm and rename is accepted", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "launcher-mocks-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const target = path.join(root, ".bb-runtime", "assets");
  raceWith(async (to) => {
    for (const name of await bundledAssetNames()) {
      await fsPromises.copyFile(path.join(pluginRoot, "assets", name), path.join(to, name));
    }
  });
  assert.equal(await ensureRuntimeAssets(policyFor(root)), target);
  assert.deepEqual((await fsPromises.readdir(target)).sort(), (await bundledAssetNames()).sort());
  assert.deepEqual(
    (await fsPromises.readdir(path.join(root, ".bb-runtime"))).filter((name) => name.includes(".tmp")),
    [],
    "our own temporary directory is removed",
  );
});

test("another process that published assets that do not match is denied", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "launcher-mocks-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const target = path.join(root, ".bb-runtime", "assets");
  raceWith((to) => fsPromises.writeFile(path.join(to, "other-call"), "not the bundled set"));
  await assert.rejects(ensureRuntimeAssets(policyFor(root)), {
    message: `Shared runtime denied: ${target} was published by another process and does not match the bundled assets; remove it and run the operation again`,
  });
  assert.deepEqual(
    (await fsPromises.readdir(path.join(root, ".bb-runtime"))).filter((name) => name.includes(".tmp")),
    [],
    "our own temporary directory is removed",
  );
});

test("installed assets that someone else owns, or that cannot be inspected, are not reused", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "launcher-mocks-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const target = path.join(root, ".bb-runtime", "assets");
  await ensureRuntimeAssets(policyFor(root));
  const [name] = await bundledAssetNames();
  const marker = path.join(target, name);
  const before = await fsPromises.lstat(marker);
  fsHooks.lstat = async (filePath, ...rest) => {
    const info = await fsPromises.lstat(filePath, ...rest);
    return filePath === target ? Object.create(info, { uid: { value: process.getuid() + 1 } }) : info;
  };
  assert.equal(await ensureRuntimeAssets(policyFor(root)), target);
  const after = await fsPromises.lstat(marker);
  assert.notEqual(after.ino, before.ino, "assets owned by another user are reinstalled");

  fsHooks.lstat = async (filePath, ...rest) => {
    if (filePath === target) {
      throw denied();
    }
    return fsPromises.lstat(filePath, ...rest);
  };
  await assert.rejects(ensureRuntimeAssets(policyFor(root)), { code: "EACCES" });
});

// Swap one installed asset after readdir listed it as a regular file and before it is opened.
async function swapAfterListing(target, name, swap) {
  let swapped = false;
  fsHooks.readdir = async (directory, ...rest) => {
    const entries = await fsPromises.readdir(directory, ...rest);
    if (directory === target && !swapped) {
      swapped = true;
      await swap(path.join(target, name));
    }
    return entries;
  };
  return () => swapped;
}

test("a symlink swapped in after the listing is not read through, and the set is reinstalled", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "launcher-mocks-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const target = path.join(root, ".bb-runtime", "assets");
  await ensureRuntimeAssets(policyFor(root));
  const [name] = await bundledAssetNames();
  const bundled = await fsPromises.readFile(path.join(pluginRoot, "assets", name));
  // The link target holds the correct content, so a digest that followed the link would match.
  const outside = path.join(root, "outside-file");
  await fsPromises.writeFile(outside, bundled);
  const swapped = await swapAfterListing(target, name, async (file) => {
    await fsPromises.rm(file);
    await fsPromises.symlink(outside, file);
  });
  assert.equal(await ensureRuntimeAssets(policyFor(root)), target);
  assert.equal(swapped(), true);
  const installed = await fsPromises.lstat(path.join(target, name));
  assert.equal(installed.isSymbolicLink(), false, "the link was replaced by a regular file");
  assert.equal(installed.isFile(), true);
  assert.deepEqual(await fsPromises.readFile(outside), bundled, "the link target is untouched");
});

test("a file removed after the listing leads to a reinstall, not an error", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "launcher-mocks-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const target = path.join(root, ".bb-runtime", "assets");
  await ensureRuntimeAssets(policyFor(root));
  const [name] = await bundledAssetNames();
  const swapped = await swapAfterListing(target, name, (file) => fsPromises.rm(file));
  assert.equal(await ensureRuntimeAssets(policyFor(root)), target);
  assert.equal(swapped(), true);
  assert.equal((await fsPromises.lstat(path.join(target, name))).isFile(), true, "the removed file is back");
});

test("a directory at the stale marker path is refused with a clear message", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "launcher-mocks-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const marker = path.join(root, ".bb-runtime", "assets.sha256");
  await fsPromises.mkdir(marker, { recursive: true });
  await assert.rejects(ensureRuntimeAssets(policyFor(root)), {
    message: `Shared runtime denied: ${marker} is a directory; remove it and run the operation again`,
  });
});

test("a special file swapped in after the listing neither blocks nor matches", { timeout: 10000 }, async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "launcher-mocks-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const target = path.join(root, ".bb-runtime", "assets");
  await ensureRuntimeAssets(policyFor(root));
  const [name] = await bundledAssetNames();
  const swapped = await swapAfterListing(target, name, async (file) => {
    await fsPromises.rm(file);
    await promisify(execFile)("mkfifo", [file]);
  });
  assert.equal(await ensureRuntimeAssets(policyFor(root)), target);
  assert.equal(swapped(), true);
  assert.equal((await fsPromises.lstat(path.join(target, name))).isFile(), true, "the FIFO was replaced");
});

test("a failed call does not block or fail the next call on the same runtime directory", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "launcher-mocks-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const target = path.join(root, ".bb-runtime", "assets");
  let renames = 0;
  fsHooks.rename = async (from, to) => {
    renames += 1;
    if (renames === 1) {
      throw denied();
    }
    return fsPromises.rename(from, to);
  };
  const first = ensureRuntimeAssets(policyFor(root));
  const second = ensureRuntimeAssets(policyFor(root));
  const third = ensureRuntimeAssets(policyFor(root));
  await assert.rejects(first, { code: "EACCES" });
  assert.equal(await second, target);
  assert.equal(await third, target);
  assert.equal(renames, 2, "one failed rename, one install; the third call finds the set in place");
  assert.deepEqual(
    (await fsPromises.readdir(path.join(root, ".bb-runtime"))).filter((name) => name.includes(".tmp")),
    [],
  );
  // The chain is idle again: a later call starts fresh.
  assert.equal(await ensureRuntimeAssets(policyFor(root)), target);
});

test("a rename failure other than a lost publish race surfaces", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "launcher-mocks-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  fsHooks.rename = async () => {
    throw denied();
  };
  await assert.rejects(ensureRuntimeAssets(policyFor(root)), { code: "EACCES" });
});

test("a runtime directory that cannot be inspected, or that someone else owns, is refused", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "launcher-mocks-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runtimeDirectory = path.join(root, ".bb-runtime");
  await fsPromises.mkdir(runtimeDirectory);
  fsHooks.lstat = async (filePath, ...rest) => {
    if (filePath === runtimeDirectory) {
      throw denied();
    }
    return fsPromises.lstat(filePath, ...rest);
  };
  await assert.rejects(ensureRuntimeAssets(policyFor(root)), { code: "EACCES" });
  fsHooks.lstat = async (filePath, ...rest) => {
    const info = await fsPromises.lstat(filePath, ...rest);
    return filePath === runtimeDirectory ? Object.create(info, { uid: { value: process.getuid() + 1 } }) : info;
  };
  const expected = `Shared runtime denied: ${runtimeDirectory} must be a directory owned by you, not a symlink; if the repository commits .bb-runtime, do not run operations in it, otherwise remove it and run the operation again`;
  await assert.rejects(ensureRuntimeAssets(policyFor(root)), { message: expected });
  await assert.rejects(ensureIsolationLauncher(policyFor(root), { run: daemon("arm64") }), { message: expected });
  assert.deepEqual(await fsPromises.readdir(runtimeDirectory), []);
});
