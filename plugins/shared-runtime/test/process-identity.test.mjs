import assert from "node:assert/strict";
import * as childProcess from "node:child_process";
import * as fsPromises from "node:fs/promises";
import test, { mock } from "node:test";

// The module branches on /proc reads and /bin/ps spawning, never on
// process.platform, so both builtins are mocked with delegating seams and
// every seam is restored to the real builtin after each test.
const fsHooks = {};
const spawnHooks = { spawn: null };

function hookedFs(name, ...args) {
  const implementation = fsHooks[name];
  return implementation ? implementation(...args) : fsPromises[name](...args);
}

function hookedSpawn(...args) {
  const implementation = spawnHooks.spawn;
  return implementation ? implementation(...args) : childProcess.spawn(...args);
}

mock.module("node:fs/promises", {
  namedExports: {
    ...fsPromises,
    readFile: (...args) => hookedFs("readFile", ...args),
  },
});
mock.module("node:child_process", {
  namedExports: {
    ...childProcess,
    spawn: (...args) => hookedSpawn(...args),
  },
});

const processIdentity = await import("../src/process-identity.mjs");

test.afterEach(() => {
  for (const name of Object.keys(fsHooks)) {
    delete fsHooks[name];
  }
  spawnHooks.spawn = null;
});

const livePid = process.pid;
const BOOT_ID = "9f4a2c88-1d55-4f61-a4ef-1d77d6c81b21\n";


// /proc/<pid>/stat: the parsed fields start at the state (field 3), and the
// start time in clock ticks is field 22, so parsed index 19.
function procStat(startTicks) {
  const fields = Array.from({ length: 40 }, (_, index) => String(index));
  fields[18] = String(startTicks);
  return ` 4242 (node) S ${fields.join(" ")}\n`;
}

function serveProcfs({ startTicks = 0, uptime = null, liveStat = true } = {}) {
  fsHooks.readFile = async (filePath, ...rest) => {
    if (filePath === "/proc/sys/kernel/random/boot_id") {
      return BOOT_ID;
    }
    if (filePath === `/proc/${process.pid}/stat`) {
      if (liveStat) {
        return procStat(startTicks);
      }
    }
    if (filePath === "/proc/uptime") {
      if (uptime === null) {
        const error = new Error("no uptime");
        error.code = "EACCES";
        throw error;
      }
      return uptime;
    }
    if (String(filePath).startsWith("/proc/")) {
      const error = new Error("missing procfs");
      error.code = "ENOENT";
      throw error;
    }
    return fsPromises.readFile(filePath, ...rest);
  };
}

function fakeChild({ stdout = "", code = 0, error = null } = {}) {
  const listeners = { data: [], error: [], close: [] };
  const child = {
    stdout: {
      on(event, listener) {
        listeners[event].push(listener);
      },
    },
    once(event, listener) {
      listeners[event].push(listener);
    },
  };
  setImmediate(() => {
    if (error !== null) {
      for (const listener of listeners.error) {
        listener(error);
      }
      return;
    }
    for (const listener of listeners.data) {
      listener(Buffer.from(stdout));
    }
    for (const listener of listeners.close) {
      listener(code, null);
    }
  });
  return child;
}

test("a readable /proc yields the boot-id and start-tick identity", async (t) => {
  serveProcfs({ startTicks: 1_234_567 });
  assert.equal(
    await processIdentity.readProcessIdentity(livePid),
    `proc:${BOOT_ID.trim()}:1234567`,
  );
});

test("a /proc stat without start ticks falls back to ps output", async (t) => {
  fsHooks.readFile = async (filePath, ...rest) => {
    if (filePath === "/proc/sys/kernel/random/boot_id") {
      return BOOT_ID;
    }
    if (filePath === "/proc/4242/stat") {
      return " 4242 (node) S 0 1 2\n";
    }
    return fsPromises.readFile(filePath, ...rest);
  };
  spawnHooks.spawn = (command, args) => {
    assert.equal(command, "/bin/ps");
    assert.deepEqual(args, ["-o", "lstart=", "-p", "4242"]);
    return fakeChild({ stdout: "Mon Oct 24 10:11:12 2026\n" });
  };
  assert.equal(await processIdentity.readProcessIdentity(4242), "Mon Oct 24 10:11:12 2026");
});

test("a failed ps run yields no identity", async (t) => {
  serveProcfs({ startTicks: 1 });
  spawnHooks.spawn = () => fakeChild({ stdout: "", code: 1 });
  assert.equal(await processIdentity.readProcessIdentity(4242), null);
});

test("a spawn failure yields no identity", async (t) => {
  serveProcfs({ startTicks: 1 });
  spawnHooks.spawn = () =>
    fakeChild({ error: Object.assign(new Error("no ps"), { code: "ENOENT" }) });
  assert.equal(await processIdentity.readProcessIdentity(4242), null);
});

test("a proc identity is stale when the claim predates the process start", async (t) => {
  // Start ticks far in the future put the computed start time ahead of any
  // realistic claim timestamp.
  serveProcfs({ startTicks: 1_000_000_000, uptime: "500.25 1000.5\n" });
  assert.equal(
    await processIdentity.ownerProcessExists({ pid: livePid, createdAt: 1 }),
    false,
  );
});

test("a proc identity within the two second grace keeps its owner alive", async (t) => {
  // Start ticks zero with 500s uptime puts the start time 500s in the past;
  // a claim made one second ago stays valid.
  serveProcfs({ startTicks: 0, uptime: "500.25 1000.5\n" });
  assert.equal(
    await processIdentity.ownerProcessExists({
      pid: livePid,
      createdAt: Date.now() - 1_000,
    }),
    true,
  );
});

test("an owner without a finite creation timestamp stays alive", async (t) => {
  serveProcfs({ startTicks: 1_000_000_000, uptime: "500.25 1000.5\n" });
  assert.equal(
    await processIdentity.ownerProcessExists({ pid: livePid }),
    true,
  );
});

test("an unreadable /proc/uptime keeps the owner alive", async (t) => {
  serveProcfs({ startTicks: 1_000_000 });
  assert.equal(
    await processIdentity.ownerProcessExists({
      pid: livePid,
      createdAt: 1,
      processIdentity: `proc:${BOOT_ID.trim()}:1000000`,
    }),
    true,
  );
});

test("a proc identity with non-numeric ticks keeps the owner alive", async (t) => {
  serveProcfs({ startTicks: "not-ticks", uptime: "500.25 1000.5\n" });
  assert.equal(
    await processIdentity.ownerProcessExists({
      pid: livePid,
      createdAt: Date.now(),
      processIdentity: `proc:${BOOT_ID.trim()}:not-ticks`,
    }),
    true,
  );
});

test("an identity-less owner claim stays alive", async (t) => {
  serveProcfs({ startTicks: 1 });
  spawnHooks.spawn = () =>
    fakeChild({ error: Object.assign(new Error("no ps"), { code: "ENOENT" }) });
  assert.equal(await processIdentity.ownerProcessExists({ pid: livePid }), true);
});

test("a legacy ps identity matches and mismatches against stored owners", async (t) => {
  // The live pid itself resolves through ps, not /proc.
  serveProcfs({ startTicks: 1, liveStat: false });
  spawnHooks.spawn = () => fakeChild({ stdout: "Mon Oct 24 10:11:12 2026\n" });
  const identity = await processIdentity.readProcessIdentity(livePid);
  assert.equal(identity, "Mon Oct 24 10:11:12 2026");
  assert.equal(
    await processIdentity.ownerProcessExists({
      pid: livePid,
      processIdentity: identity,
    }),
    true,
  );
  assert.equal(
    await processIdentity.ownerProcessExists({
      pid: livePid,
      processIdentity: "somewhere else entirely",
    }),
    false,
  );
});

test("an unparsable legacy ps timestamp keeps the owner alive", async (t) => {
  serveProcfs({ startTicks: 1 });
  spawnHooks.spawn = () => fakeChild({ stdout: "not a parseable date\n" });
  assert.equal(
    await processIdentity.ownerProcessExists({
      pid: livePid,
      createdAt: 1,
      processIdentity: undefined,
    }),
    true,
  );
});

test("owner liveness denies non-integer and dead pids without identity reads", async (t) => {
  for (const owner of [null, {}, { pid: "4242" }, { pid: 2_147_483_647 }]) {
    assert.equal(await processIdentity.ownerProcessExists(owner), false);
  }
});

