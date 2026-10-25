import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp as realMkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { mock } from "node:test";

import * as fsPromises from "node:fs/promises";
import { readProcessIdentity } from "../src/process-identity.mjs";

// Lock state publication races against other publishers; the fs seams below
// inject the conflicting states those races produce. Every seam is restored
// after each test, and everything else passes through to the real fs.
const fsHooks = {};

function hookedFs(name, ...args) {
  const implementation = fsHooks[name];
  return implementation ? implementation(...args) : fsPromises[name](...args);
}

mock.module("node:fs/promises", {
  namedExports: {
    ...fsPromises,
    mkdir: (...args) => hookedFs("mkdir", ...args),
    mkdtemp: (...args) => hookedFs("mkdtemp", ...args),
    writeFile: (...args) => hookedFs("writeFile", ...args),
    readFile: (...args) => hookedFs("readFile", ...args),
    open: (...args) => hookedFs("open", ...args),
  },
});

const { ensureFilesystemLockState } = await import("../src/filesystem-lock-state.mjs");

test.afterEach(() => {
  for (const name of Object.keys(fsHooks)) {
    delete fsHooks[name];
  }
});

function fault(code) {
  const error = new Error(`injected ${code}`);
  error.code = code;
  return error;
}


async function makeRoot(t, prefix = "filesystem-lock-state-") {
  const root = await realMkdtemp(path.join(tmpdir(), prefix));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("a relative lock root is denied", async (t) => {
  await makeRoot(t);
  await assert.rejects(
    ensureFilesystemLockState("key", undefined, { lockRoot: "relative/locks" }),
    /lock root is not absolute/,
  );
});

test("an already-aborted signal refuses to start the lock loop", async (t) => {
  const root = await makeRoot(t);
  await assert.rejects(
    ensureFilesystemLockState("key", AbortSignal.abort(), { lockRoot: root }),
    { name: "AbortError" },
  );
});

test("an unreadable state marker retires the state and republishes it", async (t) => {
  const root = await makeRoot(t);
  const lockPath = path.join(root, "key.lock");
  await mkdir(lockPath);
  await writeFile(path.join(lockPath, "rw.json"), "corrupt", { mode: 0o600 });
  let reads = 0;
  fsHooks.readFile = async (filePath, ...rest) => {
    if (filePath === path.join(lockPath, "rw.json")) {
      reads += 1;
      if (reads === 1) {
        throw fault("EACCES");
      }
    }
    return fsPromises.readFile(filePath, ...rest);
  };
  assert.equal(await ensureFilesystemLockState("key", undefined, { lockRoot: root }), lockPath);
  assert.match(await readFile(path.join(lockPath, "rw.json"), "utf8"), /^\{"version":1\}\n$/);
});

test("a failed state publication is cleaned up and surfaces the error", async (t) => {
  const root = await makeRoot(t);
  const lockPath = path.join(root, "key.lock");
  fsHooks.writeFile = async (target, ...rest) => {
    if (target === path.join(lockPath, "owner.json")) {
      throw fault("EACCES");
    }
    return fsPromises.writeFile(target, ...rest);
  };
  await assert.rejects(
    ensureFilesystemLockState("key", undefined, { lockRoot: root }),
    { code: "EACCES" },
  );
  await assert.rejects(lstat(lockPath), { code: "ENOENT" }, "the failed state is cleaned up");
});

test("a state published between the marker check and the claim is honoured", async (t) => {
  const root = await makeRoot(t);
  const lockPath = path.join(root, "key.lock");
  let reads = 0;
  fsHooks.readFile = async (filePath, ...rest) => {
    if (filePath === path.join(lockPath, "rw.json")) {
      reads += 1;
      if (reads === 2) {
        return '{"version":1}\n';
      }
    }
    return fsPromises.readFile(filePath, ...rest);
  };
  assert.equal(await ensureFilesystemLockState("key", undefined, { lockRoot: root }), lockPath);
  assert.equal(reads, 2, "the republished marker short-circuits the claim");
});

test("a claim replaced before the ownership re-check is recovered and retried", async (t) => {
  const root = await makeRoot(t);
  const lockPath = path.join(root, "key.lock");
  const claimPath = `${lockPath}.owner.json`;
  let opens = 0;
  fsHooks.open = async (...args) => {
    const handle = await fsPromises.open(...args);
    if (args[0] === claimPath) {
      opens += 1;
      if (opens === 1) {
        const realStat = handle.stat.bind(handle);
        handle.stat = async () => ({ ...(await realStat()), ino: 987_654_321 });
      }
    }
    return handle;
  };
  assert.equal(await ensureFilesystemLockState("key", undefined, { lockRoot: root }), lockPath);
  assert.equal(opens >= 3, true, "the mismatched claim was recovered and replaced");
});

test("a claim replaced before a legacy republication abandons that attempt", async (t) => {
  const root = await makeRoot(t);
  const lockPath = path.join(root, "key.lock");
  const claimPath = `${lockPath}.owner.json`;
  // An ownerless legacy state directory forces the republication path, whose
  // re-verification observes the replaced claim.
  await mkdir(lockPath);
  await writeFile(path.join(lockPath, "owner.json"), "{ broken\n", { mode: 0o600 });
  let opens = 0;
  fsHooks.open = async (...args) => {
    const handle = await fsPromises.open(...args);
    if (args[0] === claimPath) {
      opens += 1;
      if (opens === 2) {
        const realStat = handle.stat.bind(handle);
        handle.stat = async () => ({ ...(await realStat()), ino: 987_654_321 });
      }
    }
    return handle;
  };
  assert.equal(await ensureFilesystemLockState("key", AbortSignal.timeout(5_000), { lockRoot: root }), lockPath);
  assert.equal(opens >= 3, true, "the replaced attempt was recovered and retried");
});

test("a lost republication race is retried until the state is published", async (t) => {
  const root = await makeRoot(t);
  const lockPath = path.join(root, "key.lock");
  await mkdir(lockPath);
  await writeFile(path.join(lockPath, "owner.json"), "{ broken\n", { mode: 0o600 });
  let stateMkdirs = 0;
  fsHooks.mkdir = async (directory, options) => {
    if (directory === lockPath) {
      stateMkdirs += 1;
      if (stateMkdirs === 1) {
        throw fault("EEXIST");
      }
    }
    return fsPromises.mkdir(directory, options);
  };
  assert.equal(await ensureFilesystemLockState("key", AbortSignal.timeout(5_000), { lockRoot: root }), lockPath);
  assert.equal(stateMkdirs, 2, "the second attempt publishes the state");
});

test("a claim that vanishes before the ownership re-check is reinstalled", async (t) => {
  const root = await makeRoot(t);
  const lockPath = path.join(root, "key.lock");
  const claimPath = `${lockPath}.owner.json`;
  let opens = 0;
  fsHooks.open = async (...args) => {
    if (args[0] === claimPath) {
      opens += 1;
      if (opens === 1) {
        throw fault("ENOENT");
      }
    }
    return fsPromises.open(...args);
  };
  assert.equal(await ensureFilesystemLockState("key", undefined, { lockRoot: root }), lockPath);
  assert.match(await readFile(path.join(lockPath, "rw.json"), "utf8"), /^\{"version":1\}\n$/);
});

test("an unreadable claim during the ownership re-check surfaces the error", async (t) => {
  const root = await makeRoot(t);
  const lockPath = path.join(root, "key.lock");
  const claimPath = `${lockPath}.owner.json`;
  fsHooks.open = async (...args) => {
    if (args[0] === claimPath) {
      throw fault("EACCES");
    }
    return fsPromises.open(...args);
  };
  await assert.rejects(
    ensureFilesystemLockState("key", undefined, { lockRoot: root }),
    { code: "EACCES" },
  );
});

test("a stalled legacy wait is bounded by the signal", async (t) => {
  const root = await makeRoot(t);
  const lockPath = path.join(root, "key.lock");
  const liveOwner = {
    // A legacy owner without a parsable creation timestamp stays alive but is
    // reported at an unknown time.
    id: "legacy-live",
    pid: process.pid,
    processIdentity: await readProcessIdentity(process.pid),
  };
  await mkdir(lockPath);
  await writeFile(path.join(lockPath, "owner.json"), `${JSON.stringify(liveOwner)}\n`, { mode: 0o600 });
  // The legacy owner never dies and never publishes: the loop must report the
  // wait and then honour the abort instead of spinning forever.
  const waits = [];
  await assert.rejects(
    ensureFilesystemLockState("key", AbortSignal.timeout(500), {
      lockRoot: root,
      onWait: (message) => waits.push(message),
    }),
    { name: "TimeoutError" },
  );
  assert.equal(waits.length >= 1, true, "the live legacy owner was reported");
  assert.match(waits[0], /held by pid \d+ running an operation since /);
});
