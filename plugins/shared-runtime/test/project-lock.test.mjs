import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp as realMkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { mock } from "node:test";

import * as fsPromises from "node:fs/promises";
import { readProcessIdentity } from "../src/process-identity.mjs";

// Filesystem project locks race against other processes; the fs seams below
// inject the vanished-and-failing states those races produce. Every seam is
// restored after each test, and everything else passes through to the real fs.
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
    readdir: (...args) => hookedFs("readdir", ...args),
  },
});

const { withProjectLock } = await import("../src/project-lock.mjs");

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


async function makeRoot(t, prefix = "project-lock-") {
  const root = await realMkdtemp(path.join(tmpdir(), prefix));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function writePublishedState(root, key = "key") {
  const lockPath = path.join(root, `${key}.lock`);
  await mkdir(path.join(lockPath, "readers"), { recursive: true });
  await mkdir(path.join(lockPath, "writers"));
  await writeFile(path.join(lockPath, "rw.json"), '{"version":1}\n', { mode: 0o600 });
  return lockPath;
}

test("an already-aborted signal refuses to acquire a filesystem lock", async (t) => {
  const root = await makeRoot(t);
  await assert.rejects(
    withProjectLock("key", async () => assert.fail("must not run"), {
      lockRoot: root,
      signal: AbortSignal.abort(),
    }),
    { name: "AbortError" },
  );
});

test("acquiring a shared lease cleans up unusable reader leases", async (t) => {
  const root = await makeRoot(t);
  const lockPath = await writePublishedState(root);
  const readers = path.join(lockPath, "readers");
  await writeFile(path.join(readers, "no-id.json"), `${JSON.stringify({ pid: 4_242 })}\n`, {
    mode: 0o600,
  });
  await writeFile(
    path.join(readers, "dead-owner.json"),
    `${JSON.stringify({
      createdAt: 1,
      id: "dead-lease",
      pid: 2_147_483_647,
      processIdentity: "gone",
    })}\n`,
    { mode: 0o600 },
  );
  await writeFile(path.join(readers, "garbage.json"), "{ not json\n", { mode: 0o600 });

  await withProjectLock(
    "key",
    async () => {
      const names = await fsPromises.readdir(readers);
      assert.equal(names.length, 1, "only our own lease survives the cleanup");
    },
    { lockRoot: root, mode: "shared", owner: { environmentId: "env_a", operation: "tests" } },
  );
  await assert.rejects(
    lstat(lockPath),
    { code: "ENOENT" },
    "the last lease retires the state",
  );
});

test("a release whose gate cannot be claimed leaves the lease in place", async (t) => {
  const root = await makeRoot(t);
  const lockPath = await writePublishedState(root);
  const writers = path.join(lockPath, "writers");
  await withProjectLock(
    "key",
    async () => {
      fsHooks.mkdtemp = async (prefix) => {
        if (path.basename(prefix).startsWith(".gate.lock.owner.json.init-")) {
          throw fault("ENOENT");
        }
        return fsPromises.mkdtemp(prefix);
      };
    },
    { lockRoot: root, owner: { environmentId: "env_a", operation: "tests" } },
  );
  assert.equal(
    (await fsPromises.readdir(writers)).length,
    1,
    "the lease survives a failed gate",
  );
});

test("a vanished lock state during acquisition is retried with a fresh claim", async (t) => {
  const root = await makeRoot(t);
  const lockPath = await writePublishedState(root);
  const readers = path.join(lockPath, "readers");
  let scans = 0;
  fsHooks.readdir = async (directory, options) => {
    if (directory === readers) {
      scans += 1;
      if (scans === 1) {
        throw fault("ENOENT");
      }
    }
    return fsPromises.readdir(directory, options);
  };

  let ran = false;
  await withProjectLock(
    "key",
    async () => {
      ran = true;
    },
    { lockRoot: root, owner: { environmentId: "env_a", operation: "tests" } },
  );
  assert.equal(ran, true);
  assert.equal(scans >= 2, true, "the retired state was re-established");
});

test("an unexpected lease error surfaces instead of retrying", async (t) => {
  const root = await makeRoot(t);
  const lockPath = await writePublishedState(root);
  fsHooks.writeFile = async (target, ...rest) => {
    if (target.startsWith(path.join(lockPath, "writers"))) {
      throw fault("EACCES");
    }
    return fsPromises.writeFile(target, ...rest);
  };
  await assert.rejects(
    withProjectLock(
      "key",
      async () => assert.fail("must not run"),
      { lockRoot: root, owner: { environmentId: "env_a", operation: "tests" } },
    ),
    { code: "EACCES" },
  );
  await assert.rejects(lstat(lockPath), { code: "ENOENT" }, "the lease failure retires the state");
});

test("a vanished readers directory during release still retires the state", async (t) => {
  const root = await makeRoot(t);
  const lockPath = await writePublishedState(root);
  await withProjectLock(
    "key",
    async () => {
      fsHooks.readdir = async (directory, options) => {
        if (directory === path.join(lockPath, "readers")) {
          throw fault("ENOENT");
        }
        return fsPromises.readdir(directory, options);
      };
    },
    { lockRoot: root, owner: { environmentId: "env_a", operation: "tests" } },
  );
  await assert.rejects(lstat(lockPath), { code: "ENOENT" });
});

async function waitFor(predicate, label, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${label}`);
}

test("a shared waiter reports the exclusive holder and runs after it", async (t) => {
  const root = await makeRoot(t);
  await writePublishedState(root);
  const events = [];
  let releaseWriter;
  const writerGate = new Promise((resolve) => {
    releaseWriter = resolve;
  });
  const writer = withProjectLock(
    "key",
    async () => {
      events.push("writer:start");
      await writerGate;
      events.push("writer:end");
    },
    { lockRoot: root, owner: { environmentId: "env_writer", operation: "sync" } },
  );
  // Start the reader only once the writer provably holds the lock, so the
  // reader can never win the race and get granted first.
  await waitFor(() => events.includes("writer:start"), "the writer to start");
  const waits = [];
  const reader = withProjectLock(
    "key",
    async () => {
      events.push("reader");
    },
    {
      lockRoot: root,
      mode: "shared",
      owner: { environmentId: "env_reader", operation: "tests" },
      onWait: (message) => waits.push(message),
    },
  );
  await waitFor(
    () => waits.some((message) => /env_writer running sync/.test(message)),
    "the reader to report the writer lease",
  );
  assert.match(
    waits.find((message) => /env_writer running sync/.test(message)),
    /Shared runtime waiting for lock held by env_writer running sync since /,
  );
  assert.deepEqual(events, ["writer:start"], "the reader is still blocked");
  releaseWriter();
  await Promise.all([writer, reader]);
  assert.deepEqual(events, ["writer:start", "writer:end", "reader"]);
});

test("lease sorting breaks ties between identical creation timestamps", async (t) => {
  const root = await makeRoot(t);
  const lockPath = await writePublishedState(root);
  const writers = path.join(lockPath, "writers");
  const tied = {
    createdAt: 1_700_000_000_000,
    pid: process.pid,
    processIdentity: await readProcessIdentity(process.pid),
  };
  const lease = (id) => `${JSON.stringify({ ...tied, id })}\n`;
  await writeFile(path.join(writers, "tie-a.json"), lease("tie-a"), { mode: 0o600 });
  await writeFile(path.join(writers, "tie-b.json"), lease("tie-b"), { mode: 0o600 });

  await assert.rejects(
    withProjectLock(
      "key",
      async () => {
        assert.fail("must not run while the tied leases hold the queue");
      },
      {
        lockRoot: root,
        signal: AbortSignal.timeout(400),
        owner: { environmentId: "env_a", operation: "tests" },
      },
    ),
    { name: "TimeoutError" },
    "the tied live leases keep the writer queued until they are removed",
  );
});
