import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp as realMkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { mock } from "node:test";

import * as childProcess from "node:child_process";
import * as fsPromises from "node:fs/promises";

// Lock claims race against other processes; the fs seams below inject the
// vanished-and-replaced states those races produce. Liveness is decided by
// the real process identity checks. Every seam is restored after each test.
const fsHooks = {};
const spawnHooks = { spawn: null };

function hookedFs(name, ...args) {
  const implementation = fsHooks[name];
  return implementation ? implementation(...args) : fsPromises[name](...args);
}

mock.module("node:fs/promises", {
  namedExports: {
    ...fsPromises,
    readFile: (...args) => hookedFs("readFile", ...args),
    lstat: (...args) => hookedFs("lstat", ...args),
    mkdtemp: (...args) => hookedFs("mkdtemp", ...args),
    link: (...args) => hookedFs("link", ...args),
    open: (...args) => hookedFs("open", ...args),
  },
});
mock.module("node:child_process", {
  namedExports: {
    ...childProcess,
    spawn: (...args) => hookedSpawn(...args),
  },
});

function hookedSpawn(...args) {
  const implementation = spawnHooks.spawn;
  return implementation ? implementation(...args) : childProcess.spawn(...args);
}

// Imported after the builtin mocks so its /proc reads and ps spawns flow
// through the seams below.
const { readProcessIdentity } = await import("../src/process-identity.mjs");

const lockClaims = await import("../src/lock-claims.mjs");

const liveIdentity = await readProcessIdentity(process.pid);

test.afterEach(() => {
  for (const name of Object.keys(fsHooks)) {
    delete fsHooks[name];
  }
  spawnHooks.spawn = null;
});

const STALE_OWNER = { createdAt: 1, id: "stale-owner", pid: 2_147_483_647, processIdentity: "gone" };
const liveOwner = (id) => ({
  createdAt: Date.now(),
  id,
  pid: process.pid,
  processIdentity: liveIdentity,
});

async function makeRoot(t, prefix = "lock-claims-") {
  const root = await realMkdtemp(path.join(tmpdir(), prefix));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function writeOwner(ownerPath, owner) {
  await writeFile(ownerPath, `${JSON.stringify(owner)}\n`, { mode: 0o600 });
}

test("a lock owner with a malformed pid is refused", async (t) => {
  const root = await makeRoot(t);
  const ownerPath = path.join(root, "claim.owner.json");
  await writeOwner(ownerPath, { pid: "not-a-pid" });
  await assert.rejects(lockClaims.readLockOwner(ownerPath), /lock owner pid is invalid/);
});

test("an unparseable claim reports a stale owner without an identity", async (t) => {
  const root = await makeRoot(t);
  const ownerPath = path.join(root, "claim.owner.json");
  await writeFile(ownerPath, "{ not json\n", { mode: 0o600 });
  const observed = await lockClaims.inspectOwnerClaim(ownerPath);
  assert.equal(observed.owner, null);
  assert.equal(Number.isInteger(observed.identity.device), true);
  assert.equal(Number.isInteger(observed.identity.inode), true);
});

test("recovery of a claim that vanished returns false", async (t) => {
  const root = await makeRoot(t);
  assert.equal(
    await lockClaims.recoverOwnerClaim(path.join(root, "absent.owner.json"), {
      identity: { device: 1, inode: 1 },
    }),
    false,
  );
});

test("recovery bails out when the recovery claim cannot be staged", async (t) => {
  const root = await makeRoot(t);
  const ownerPath = path.join(root, "claim.owner.json");
  await writeOwner(ownerPath, STALE_OWNER);
  const observed = await lockClaims.inspectOwnerClaim(ownerPath);
  fsHooks.mkdtemp = async (prefix) => {
    if (path.basename(prefix).startsWith(".claim.owner.json.recover-")) {
      const error = new Error("gone");
      error.code = "ENOENT";
      throw error;
    }
    return fsPromises.mkdtemp(prefix);
  };
  assert.equal(await lockClaims.recoverOwnerClaim(ownerPath, observed), false);
  await fsPromises.readFile(ownerPath, "utf8");
});

test("recovery bails out when the recovery claim loses the link race", async (t) => {
  const root = await makeRoot(t);
  const ownerPath = path.join(root, "claim.owner.json");
  await writeOwner(ownerPath, STALE_OWNER);
  const observed = await lockClaims.inspectOwnerClaim(ownerPath);
  fsHooks.link = async (source, target) => {
    if (path.basename(target).startsWith("claim.owner.json.recover-")) {
      const error = new Error("exists");
      error.code = "EEXIST";
      throw error;
    }
    return fsPromises.link(source, target);
  };
  assert.equal(await lockClaims.recoverOwnerClaim(ownerPath, observed), false);
  await fsPromises.readFile(ownerPath, "utf8");
});

test("claim installation propagates link failures other than EEXIST", async (t) => {
  const root = await makeRoot(t);
  fsHooks.link = async () => {
    const error = new Error("denied");
    error.code = "EACCES";
    throw error;
  };
  await assert.rejects(
    lockClaims.installOwnerClaim(path.join(root, "claim.owner.json")),
    { code: "EACCES" },
  );
});

test("an unreadable legacy lock directory surfaces the read error", async (t) => {
  const root = await makeRoot(t);
  const directory = path.join(root, "legacy.lock");
  await mkdir(directory);
  fsHooks.readFile = async (filePath) => {
    if (filePath === path.join(directory, "owner.json")) {
      const error = new Error("denied");
      error.code = "EACCES";
      throw error;
    }
    return fsPromises.readFile(filePath);
  };
  await assert.rejects(
    lockClaims.inspectLegacyLockDirectory(directory, ["owner.json"], undefined),
    { code: "EACCES" },
  );
});

test("a legacy owner that appears as live between the two reads is preserved", async (t) => {
  const root = await makeRoot(t);
  const directory = path.join(root, "legacy.lock");
  await mkdir(directory);
  const legacyLiveOwner = liveOwner("legacy-live");
  await writeOwner(path.join(directory, "owner.json"), { broken: true });
  let reads = 0;
  fsHooks.readFile = async (filePath) => {
    if (filePath === path.join(directory, "owner.json")) {
      reads += 1;
      if (reads === 1) {
        return fsPromises.readFile(filePath, "utf8");
      }
      return `${JSON.stringify(legacyLiveOwner)}\n`;
    }
    return fsPromises.readFile(filePath);
  };
  const state = await lockClaims.inspectLegacyLockDirectory(directory, ["owner.json"], undefined);
  assert.deepEqual(state, { owner: legacyLiveOwner, replace: false });
});

test("a stable legacy directory with a corrupt owner is replaceable", async (t) => {
  const root = await makeRoot(t);
  const directory = path.join(root, "legacy.lock");
  await mkdir(directory);
  await writeFile(path.join(directory, "owner.json"), "{ broken\n", { mode: 0o600 });
  const state = await lockClaims.inspectLegacyLockDirectory(directory, ["owner.json"], undefined);
  assert.deepEqual(state, { owner: null, replace: true });
});

test("legacy inspection aborts when the grace wait is interrupted", async (t) => {
  const root = await makeRoot(t);
  const directory = path.join(root, "legacy.lock");
  await mkdir(directory);
  await writeFile(path.join(directory, "owner.json"), "{ broken\n", { mode: 0o600 });
  await assert.rejects(
    lockClaims.inspectLegacyLockDirectory(directory, ["owner.json"], AbortSignal.abort()),
    { name: "AbortError" },
  );
});

test("legacy inspection surfaces directory stat failures", async (t) => {
  const root = await makeRoot(t);
  const directory = path.join(root, "legacy.lock");
  await mkdir(directory);
  fsHooks.lstat = async (target) => {
    if (target === directory) {
      const error = new Error("denied");
      error.code = "EACCES";
      throw error;
    }
    return fsPromises.lstat(target);
  };
  await assert.rejects(
    lockClaims.inspectLegacyLockDirectory(directory, ["owner.json"], undefined),
    { code: "EACCES" },
  );
});

test("legacy inspection surfaces marker stat failures", async (t) => {
  const root = await makeRoot(t);
  const directory = path.join(root, "legacy.lock");
  await mkdir(directory);
  const markerPath = path.join(directory, "owner.json");
  fsHooks.lstat = async (target) => {
    if (target === markerPath) {
      const error = new Error("denied");
      error.code = "EACCES";
      throw error;
    }
    return fsPromises.lstat(target);
  };
  await assert.rejects(
    lockClaims.inspectLegacyLockDirectory(directory, ["owner.json"], undefined),
    { code: "EACCES" },
  );
});

test("waiting on a claim that vanishes is a no-op", async (t) => {
  const root = await makeRoot(t);
  const waits = [];
  await lockClaims.waitOnClaimHolder(path.join(root, "absent.owner.json"), waits.push, 1);
  assert.deepEqual(waits, []);
});

test("recovery skips contenders that vanish during the scan", async (t) => {
  const root = await makeRoot(t);
  const ownerPath = path.join(root, "claim.owner.json");
  await writeOwner(ownerPath, STALE_OWNER);
  const observed = await lockClaims.inspectOwnerClaim(ownerPath);
  const vanished = path.join(
    root,
    `claim.owner.json.recover-${observed.identity.device}-${observed.identity.inode}-vanished`,
  );
  await writeOwner(vanished, STALE_OWNER);
  fsHooks.open = async (filePath) => {
    if (filePath === vanished) {
      const error = new Error("vanished");
      error.code = "ENOENT";
      throw error;
    }
    return fsPromises.open(filePath);
  };
  assert.equal(await lockClaims.recoverOwnerClaim(ownerPath, observed), true);
  await assert.rejects(fsPromises.readFile(ownerPath, "utf8"), { code: "ENOENT" });
  await fsPromises.readFile(vanished, "utf8");
});

test("recovery leaves the claim when it vanishes before the re-inspection", async (t) => {
  const root = await makeRoot(t);
  const ownerPath = path.join(root, "claim.owner.json");
  await writeOwner(ownerPath, STALE_OWNER);
  const observed = await lockClaims.inspectOwnerClaim(ownerPath);
  let opens = 0;
  fsHooks.open = async (filePath) => {
    if (filePath === ownerPath) {
      opens += 1;
      if (opens >= 2) {
        const error = new Error("vanished");
        error.code = "ENOENT";
        throw error;
      }
    }
    return fsPromises.open(filePath);
  };
  assert.equal(await lockClaims.recoverOwnerClaim(ownerPath, observed), false);
  await fsPromises.readFile(ownerPath, "utf8");
});

test("recovery leaves a claim that was replaced before the re-inspection", async (t) => {
  const root = await makeRoot(t);
  const ownerPath = path.join(root, "claim.owner.json");
  await writeOwner(ownerPath, STALE_OWNER);
  const observed = await lockClaims.inspectOwnerClaim(ownerPath);
  let opens = 0;
  fsHooks.open = async (filePath) => {
    const handle = await fsPromises.open(filePath);
    if (filePath === ownerPath) {
      opens += 1;
      if (opens >= 2) {
        const realStat = handle.stat.bind(handle);
        handle.stat = async () => ({ ...(await realStat()), ino: observed.identity.inode + 1 });
      }
    }
    return handle;
  };
  assert.equal(await lockClaims.recoverOwnerClaim(ownerPath, observed), false);
  delete fsHooks.open;
  const current = await lockClaims.inspectOwnerClaim(ownerPath);
  assert.deepEqual(current.identity, observed.identity);
});

test("recovery removes a dead contender and honours the election hook", async (t) => {
  const root = await makeRoot(t);
  const ownerPath = path.join(root, "claim.owner.json");
  await writeOwner(ownerPath, STALE_OWNER);
  const observed = await lockClaims.inspectOwnerClaim(ownerPath);
  const deadContender = path.join(
    root,
    `claim.owner.json.recover-${observed.identity.device}-${observed.identity.inode}-dead`,
  );
  await writeOwner(deadContender, STALE_OWNER);
  let elections = 0;
  assert.equal(
    await lockClaims.recoverOwnerClaim(ownerPath, observed, {
      afterElection: () => {
        elections += 1;
      },
    }),
    true,
  );
  assert.equal(elections, 1);
  await assert.rejects(fsPromises.readFile(ownerPath, "utf8"), { code: "ENOENT" });
  await assert.rejects(fsPromises.readFile(deadContender, "utf8"), { code: "ENOENT" });
});

test("recovery outranks a live contender without a creation timestamp", async (t) => {
  const root = await makeRoot(t);
  const ownerPath = path.join(root, "claim.owner.json");
  await writeOwner(ownerPath, STALE_OWNER);
  const observed = await lockClaims.inspectOwnerClaim(ownerPath);
  const timeless = path.join(
    root,
    `claim.owner.json.recover-${observed.identity.device}-${observed.identity.inode}-timeless`,
  );
  await writeOwner(timeless, { id: "timeless-lease", pid: process.pid });
  assert.equal(await lockClaims.recoverOwnerClaim(ownerPath, observed), true);
  await assert.rejects(fsPromises.readFile(ownerPath, "utf8"), { code: "ENOENT" });
  await fsPromises.readFile(timeless, "utf8");
});

test("waiting on a claim that cannot be inspected surfaces the error", async (t) => {
  const root = await makeRoot(t);
  const ownerPath = path.join(root, "claim.owner.json");
  await writeOwner(ownerPath, STALE_OWNER);
  fsHooks.open = async (...args) => {
    if (args[0] === ownerPath) {
      const error = new Error("denied");
      error.code = "EACCES";
      throw error;
    }
    return fsPromises.open(...args);
  };
  await assert.rejects(
    lockClaims.waitOnClaimHolder(ownerPath, () => {}, 1),
    { code: "EACCES" },
  );
});

test("waiting on a live claim without a timestamp reports an unknown time", async (t) => {
  const root = await makeRoot(t);
  const ownerPath = path.join(root, "claim.owner.json");
  await writeOwner(ownerPath, { id: "timeless", pid: process.pid });
  const reports = [];
  await lockClaims.waitOnClaimHolder(
    ownerPath,
    (owner, signature) => reports.push({ owner, signature }),
    1,
  );
  assert.equal(reports.length, 1);
  assert.equal(reports[0].owner.id, "timeless");
  assert.match(reports[0].signature, /\[\d+,null,"timeless"\]/);
});

test("scavenging an absent lock root is a no-op", async (t) => {
  const root = await makeRoot(t);
  await lockClaims.scavengeInitializationDebris(path.join(root, "absent"));
});

test("scavenging removes dead recovery debris", async (t) => {
  const root = await makeRoot(t);
  const dead = path.join(root, "state.lock.owner.json.recover-9-9-dead");
  await writeOwner(dead, STALE_OWNER);
  await lockClaims.scavengeInitializationDebris(root, Date.now() + 1_000);
  await assert.rejects(fsPromises.readFile(dead, "utf8"), { code: "ENOENT" });
});

test("scavenging skips debris that vanishes before inspection", async (t) => {
  const root = await makeRoot(t);
  const debris = path.join(root, ".state.lock.init-abandoned");
  await mkdir(debris);
  const retired = path.join(root, "state.lock.retired-abandoned");
  await mkdir(retired);
  let lstats = 0;
  fsHooks.lstat = async (target) => {
    lstats += 1;
    if (target === debris && lstats === 1) {
      const error = new Error("vanished");
      error.code = "ENOENT";
      throw error;
    }
    return fsPromises.lstat(target);
  };
  await lockClaims.scavengeInitializationDebris(root, Date.now() + 1_000);
  await assert.rejects(lstat(retired), { code: "ENOENT" }, "retired debris is removed");
  // The vanished debris is skipped, never removed.
  await lstat(debris);
});

test("claim installation refuses to run without a process identity", async (t) => {
  const root = await makeRoot(t);
  // With /proc unreadable and the ps fallback failing, no identity can be
  // resolved and the claim must be refused.
  fsHooks.readFile = async (filePath, ...rest) => {
    if (String(filePath).startsWith("/proc/")) {
      const error = new Error("missing procfs");
      error.code = "ENOENT";
      throw error;
    }
    return fsPromises.readFile(filePath, ...rest);
  };
  spawnHooks.spawn = () => ({
    stdout: { on() {} },
    once(event, listener) {
      if (event === "error") {
        setImmediate(() =>
          listener(Object.assign(new Error("ps unavailable"), { code: "ENOENT" })),
        );
      }
    },
  });
  await assert.rejects(
    lockClaims.installOwnerClaim(path.join(root, "claim.owner.json")),
    /cannot determine lock owner process identity/,
  );
});

test("recovery yields to tied live contenders deterministically", async (t) => {
  const root = await makeRoot(t);
  const ownerPath = path.join(root, "claim.owner.json");
  await writeOwner(ownerPath, STALE_OWNER);
  const observed = await lockClaims.inspectOwnerClaim(ownerPath);
  const pair = (id, stamp) => ({ ...liveOwner(id), createdAt: stamp });
  const contenderA = path.join(
    root,
    `claim.owner.json.recover-${observed.identity.device}-${observed.identity.inode}-tied-a`,
  );
  const contenderB = path.join(
    root,
    `claim.owner.json.recover-${observed.identity.device}-${observed.identity.inode}-tied-b`,
  );
  await writeOwner(contenderA, pair("tied-a", 1_000_000_000_000));
  await writeOwner(contenderB, pair("tied-b", 1_000_000_000_000));

  // With equal stamps the localeCompare tie-break ranks the tied pair,
  // and the pair outranks the later-staged recovery claim, so the claim
  // survives.
  assert.equal(await lockClaims.recoverOwnerClaim(ownerPath, observed), false);
  await fsPromises.readFile(ownerPath, "utf8");
  // Once both tied contenders carry a later stamp they lose to the
  // earlier recovery claim, which retires the claim and leaves them alone.
  await writeOwner(contenderA, pair("tied-a", 5_000_000_000_000));
  await writeOwner(contenderB, pair("tied-b", 5_000_000_000_000));
  assert.equal(await lockClaims.recoverOwnerClaim(ownerPath, observed), true);
  await assert.rejects(fsPromises.readFile(ownerPath, "utf8"), { code: "ENOENT" });
  await fsPromises.readFile(contenderA, "utf8");
  await fsPromises.readFile(contenderB, "utf8");
  await writeOwner(ownerPath, STALE_OWNER);
  const tieObserved = await lockClaims.inspectOwnerClaim(ownerPath);
  const tieContender = (suffix) =>
    path.join(
      root,
      `claim.owner.json.recover-${tieObserved.identity.device}-${tieObserved.identity.inode}-${suffix}`,
    );
  await writeOwner(tieContender("tied-a"), pair("tied-a", 4_000_000_000_000));
  await writeOwner(tieContender("tied-b"), pair("tied-b", 4_000_000_000_000));
  // With a three-way createdAt tie the election falls to localeCompare alone, where the recovery path's leading pid digit outranks the contenders' letters; a flipped comparator elects a contender and fails this phase.
  const realNow = Date.now;
  Date.now = () => 4_000_000_000_000;
  try {
    assert.equal(await lockClaims.recoverOwnerClaim(ownerPath, tieObserved), true);
  } finally {
    Date.now = realNow;
  }
  await assert.rejects(fsPromises.readFile(ownerPath, "utf8"), { code: "ENOENT" });
});
