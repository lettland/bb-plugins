import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp as realMkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { mock } from "node:test";

import * as fsPromises from "node:fs/promises";

// The state gate races against other publishers; the fs seams below inject
// the conflicting states those races produce. Every seam is restored after
// each test, and everything else passes through to the real fs.
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
    open: (...args) => hookedFs("open", ...args),
  },
});

const stateGate = await import("../src/state-gate.mjs");

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

async function makeLockDirectory(t, prefix = "state-gate-") {
  const root = await realMkdtemp(path.join(tmpdir(), prefix));
  t.after(() => rm(root, { recursive: true, force: true }));
  const lockPath = path.join(root, "lock.lock");
  await mkdir(lockPath);
  return lockPath;
}

test("an already-aborted signal refuses to start the gate loop", async (t) => {
  const root = await realMkdtemp(path.join(tmpdir(), "state-gate-abort-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(
    stateGate.acquireStateGate(path.join(root, "lock.lock"), AbortSignal.abort()),
    { name: "AbortError" },
  );
});

test("an unstaged claim directory yields no gate", async (t) => {
  const lockPath = await makeLockDirectory(t);
  fsHooks.mkdtemp = async (prefix) => {
    if (path.basename(prefix).startsWith(".gate.lock.owner.json.init-")) {
      throw fault("ENOENT");
    }
    return fsPromises.mkdtemp(prefix);
  };
  assert.equal(await stateGate.acquireStateGate(lockPath), null);
});

test("a gate claim that cannot be staged at all surfaces the error", async (t) => {
  const lockPath = await makeLockDirectory(t);
  fsHooks.mkdtemp = async (prefix) => {
    if (path.basename(prefix).startsWith(".gate.lock.owner.json.init-")) {
      throw fault("EACCES");
    }
    return fsPromises.mkdtemp(prefix);
  };
  await assert.rejects(stateGate.acquireStateGate(lockPath), { code: "EACCES" });
});

test("a lost gate directory race is retried with a fresh claim", async (t) => {
  const lockPath = await makeLockDirectory(t);
  const gatePath = path.join(lockPath, "gate.lock");
  let gateMkdirs = 0;
  fsHooks.mkdir = async (directory, options) => {
    if (directory === gatePath) {
      gateMkdirs += 1;
      if (gateMkdirs === 1) {
        throw fault("EEXIST");
      }
    }
    return fsPromises.mkdir(directory, options);
  };
  const release = await stateGate.acquireStateGate(lockPath);
  assert.equal(typeof release, "function");
  assert.equal(gateMkdirs, 2, "the second attempt recreates the gate");
  await release();
  await assert.rejects(lstat(path.join(lockPath, "gate.lock")), { code: "ENOENT" });
});

test("a failed gate owner write removes the gate and surfaces the error", async (t) => {
  const lockPath = await makeLockDirectory(t);
  const gatePath = path.join(lockPath, "gate.lock");
  fsHooks.writeFile = async (target, ...rest) => {
    if (target === path.join(gatePath, "owner.json")) {
      throw fault("EACCES");
    }
    return fsPromises.writeFile(target, ...rest);
  };
  await assert.rejects(stateGate.acquireStateGate(lockPath), { code: "EACCES" });
  await assert.rejects(lstat(gatePath), { code: "ENOENT" }, "the failed gate is cleaned up");
});

test("a gate directory that vanishes before publication keeps the old claim", async (t) => {
  const lockPath = await makeLockDirectory(t);
  const gatePath = path.join(lockPath, "gate.lock");
  let gateMkdirs = 0;
  fsHooks.mkdir = async (directory, options) => {
    if (directory === gatePath) {
      gateMkdirs += 1;
      if (gateMkdirs === 1) {
        throw fault("ENOENT");
      }
    }
    return fsPromises.mkdir(directory, options);
  };
  const release = await stateGate.acquireStateGate(lockPath);
  assert.equal(typeof release, "function");
  await release();
  await assert.rejects(lstat(path.join(lockPath, "gate.lock")), { code: "ENOENT" });
});

test("a claim replaced before the ownership re-check is recovered and retried", async (t) => {
  const lockPath = await makeLockDirectory(t);
  const claimPath = path.join(lockPath, "gate.lock.owner.json");
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
  const release = await stateGate.acquireStateGate(lockPath);
  assert.equal(typeof release, "function");
  assert.equal(opens >= 3, true, "the mismatched claim was recovered and replaced");
  await release();
  await assert.rejects(lstat(path.join(lockPath, "gate.lock")), { code: "ENOENT" });
});

test("a claim replaced before gate publication abandons that attempt", async (t) => {
  const lockPath = await makeLockDirectory(t);
  const claimPath = path.join(lockPath, "gate.lock.owner.json");
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
  const release = await stateGate.acquireStateGate(lockPath);
  assert.equal(typeof release, "function");
  assert.equal(opens >= 4, true, "the mismatched attempt was recovered and retried");
  await release();
  await assert.rejects(lstat(path.join(lockPath, "gate.lock")), { code: "ENOENT" });
});

test("an unreadable claim during the ownership re-check surfaces the error", async (t) => {
  const lockPath = await makeLockDirectory(t);
  const claimPath = path.join(lockPath, "gate.lock.owner.json");
  fsHooks.open = async (...args) => {
    if (args[0] === claimPath) {
      throw fault("EACCES");
    }
    return fsPromises.open(...args);
  };
  await assert.rejects(stateGate.acquireStateGate(lockPath), { code: "EACCES" });
});
