import assert from "node:assert/strict";
import * as fsPromises from "node:fs/promises";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { mock } from "node:test";
import { fileURLToPath } from "node:url";

// The asset directory and launcher marker paths are fixed constants, so the
// fs seams below inject the failure states (a vanished assets directory, an
// unreadable launcher marker) that cannot be produced against the real
// checkout. Every seam is restored after each test.
const fsHooks = {};
const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function hookedFs(name, ...args) {
  const implementation = fsHooks[name];
  return implementation ? implementation(...args) : fsPromises[name](...args);
}

mock.module("node:fs/promises", {
  namedExports: {
    ...fsPromises,
    readFile: (...args) => hookedFs("readFile", ...args),
    readdir: (...args) => hookedFs("readdir", ...args),
  },
});

const { ensureIsolationLauncher, ensureRuntimeAssets } = await import(
  "../src/isolation-launcher.mjs"
);

test.afterEach(() => {
  for (const name of Object.keys(fsHooks)) {
    delete fsHooks[name];
  }
});

function policyFor(primaryRoot) {
  return { primaryRoot };
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

test("an unreadable launcher marker surfaces the error after the assets refresh", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "launcher-mocks-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  fsHooks.readFile = async (filePath, ...rest) => {
    if (filePath === path.join(root, ".bb-runtime", "landlock-run.sha256")) {
      throw Object.assign(new Error("denied"), { code: "EACCES" });
    }
    return fsPromises.readFile(filePath, ...rest);
  };
  await assert.rejects(
    ensureIsolationLauncher(policyFor(root), {
      run: async () => {
        throw new Error("the launcher build must not run");
      },
    }),
    { code: "EACCES" },
  );
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
