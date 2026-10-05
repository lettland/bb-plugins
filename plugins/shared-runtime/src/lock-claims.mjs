import path from "node:path";
import { constants } from "node:fs";
import { lstat, link, mkdtemp, open, readFile, readdir, rm, writeFile } from "node:fs/promises";

import { nextLockSequence, reportLockWait } from "./lock-state.mjs";
import { readProcessIdentity, ownerProcessExists } from "./process-identity.mjs";

export function safeLockKey(key) {
  return key.replaceAll(/[^a-zA-Z0-9_.-]/g, "_");
}

function parseLockOwner(serialized) {
  const owner = JSON.parse(serialized);
  if (!Number.isInteger(owner.pid) || owner.pid <= 0) {
    throw new Error("lock owner pid is invalid");
  }
  return owner;
}

export async function readLockOwner(ownerPath) {
  return parseLockOwner(await readFile(ownerPath, "utf8"));
}

async function readOptionalLockOwner(ownerPath) {
  let serialized;
  try {
    serialized = await readFile(ownerPath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { kind: "missing", owner: null };
    }
    throw error;
  }
  try {
    return { kind: "valid", owner: parseLockOwner(serialized) };
  } catch {
    return { kind: "invalid", owner: null };
  }
}

export async function inspectOwnerClaim(ownerPath) {
  const handle = await open(ownerPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const identity = await handle.stat();
    const serialized = await handle.readFile("utf8");
    let owner = null;
    try {
      owner = parseLockOwner(serialized);
    } catch {
      // Unparseable owner file: leave owner null so callers treat the claim as stale.
    }
    return {
      identity: { device: identity.dev, inode: identity.ino },
      owner,
    };
  } finally {
    await handle.close();
  }
}

export function sameClaimIdentity(left, right) {
  return (
    left?.identity?.device === right?.identity?.device &&
    left?.identity?.inode === right?.identity?.inode
  );
}

export async function recoverOwnerClaim(ownerPath, observed, hooks = {}) {
  let current;
  try {
    current = await inspectOwnerClaim(ownerPath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return false;
    }
    throw error;
  }
  if (!sameClaimIdentity(current, observed)) {
    return false;
  }
  const recoveryPrefix = `${path.basename(ownerPath)}.recover-${observed.identity.device}-${observed.identity.inode}-`;
  const recoveryPath = path.join(
    path.dirname(ownerPath),
    `${recoveryPrefix}${process.pid}-${Date.now()}-${nextLockSequence()}`,
  );
  let contender;
  try {
    contender = await installOwnerClaim(recoveryPath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return false;
    }
    throw error;
  }
  if (contender === null) {
    return false;
  }
  try {
    await new Promise((resolve) => setTimeout(resolve, 25));
    const contenders = [];
    const names = await readdir(path.dirname(ownerPath));
    for (const name of names) {
      if (!name.startsWith(recoveryPrefix)) {
        continue;
      }
      const contenderPath = path.join(path.dirname(ownerPath), name);
      try {
        const candidate = await inspectOwnerClaim(contenderPath);
        if (candidate.owner !== null && (await ownerProcessExists(candidate.owner))) {
          contenders.push({
            createdAt: Number.isFinite(candidate.owner.createdAt)
              ? candidate.owner.createdAt
              : Number.POSITIVE_INFINITY,
            path: contenderPath,
          });
        } else {
          await rm(contenderPath, { force: true });
        }
      } catch (inspectionError) {
        if (inspectionError?.code === "ENOENT") {
          continue;
        }
        throw inspectionError;
      }
    }
    contenders.sort(
      (left, right) => left.createdAt - right.createdAt || left.path.localeCompare(right.path),
    );
    if (contenders[0]?.path !== recoveryPath) {
      return false;
    }
    await hooks.afterElection?.();
    try {
      current = await inspectOwnerClaim(ownerPath);
    } catch (error) {
      if (error?.code === "ENOENT") {
        return false;
      }
      throw error;
    }
    if (!sameClaimIdentity(current, observed)) {
      return false;
    }
    await rm(ownerPath, { force: true });
    await hooks.afterRemove?.();
    return true;
  } finally {
    await rm(recoveryPath, { force: true });
  }
}

export async function installOwnerClaim(ownerPath) {
  const temporaryDirectory = await mkdtemp(
    path.join(path.dirname(ownerPath), `.${path.basename(ownerPath)}.init-`),
  );
  try {
    const temporaryOwnerPath = path.join(temporaryDirectory, "owner.json");
    const processIdentity = await readProcessIdentity(process.pid);
    if (processIdentity === null) {
      throw new Error("cannot determine lock owner process identity");
    }
    const owner = {
      createdAt: Date.now(),
      id: `${process.pid}-${Date.now()}-${nextLockSequence()}`,
      pid: process.pid,
      processIdentity,
    };
    await writeFile(
      temporaryOwnerPath,
      `${JSON.stringify(owner)}\n`,
      { mode: 0o600 },
    );
    const temporaryIdentity = await lstat(temporaryOwnerPath);
    try {
      await link(temporaryOwnerPath, ownerPath);
      return {
        identity: { device: temporaryIdentity.dev, inode: temporaryIdentity.ino },
        owner,
      };
    } catch (error) {
      if (error?.code === "EEXIST") {
        return null;
      }
      throw error;
    }
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

async function stableDirectoryCanBeReplaced(
  directory,
  markerNames,
  signal,
  graceMs = 1_000,
) {
  const snapshot = async () => {
    let directoryStat;
    try {
      directoryStat = await lstat(directory);
    } catch (error) {
      if (error?.code === "ENOENT") {
        return null;
      }
      throw error;
    }
    const markers = [];
    for (const markerName of markerNames) {
      try {
        const marker = await lstat(path.join(directory, markerName));
        markers.push({
          device: marker.dev,
          inode: marker.ino,
          modifiedAt: marker.mtimeMs,
          size: marker.size,
        });
      } catch (error) {
        if (error?.code !== "ENOENT") {
          throw error;
        }
        markers.push(null);
      }
    }
    return {
      device: directoryStat.dev,
      inode: directoryStat.ino,
      markers,
      modifiedAt: directoryStat.mtimeMs,
    };
  };
  const before = await snapshot();
  if (before === null) {
    return true;
  }
  await new Promise((resolve) => setTimeout(resolve, graceMs));
  if (signal?.aborted) {
    throw signal.reason ?? new Error("operation aborted while waiting for lock");
  }
  const after = await snapshot();
  return after === null || JSON.stringify(before) === JSON.stringify(after);
}

export function createWaitReporter(options) {
  let lastSignature = null;
  return (owner, signature) => {
    if (signature !== lastSignature) {
      reportLockWait(options, owner);
      lastSignature = signature;
    }
  };
}

export async function waitOnClaimHolder(claimPath, reportWait, pollMs) {
  let observed;
  try {
    observed = await inspectOwnerClaim(claimPath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return;
    }
    throw error;
  }
  if (observed.owner === null || !(await ownerProcessExists(observed.owner))) {
    await recoverOwnerClaim(claimPath, observed);
    return;
  }
  reportWait(
    observed.owner,
    JSON.stringify([observed.owner.pid, observed.owner.createdAt, observed.owner.id]),
  );
  await new Promise((resolve) => setTimeout(resolve, pollMs));
}

export async function inspectLegacyLockDirectory(directory, markerNames, signal) {
  let ownerState = await readOptionalLockOwner(path.join(directory, "owner.json"));
  if (ownerState.kind === "valid") {
    if (await ownerProcessExists(ownerState.owner)) {
      return { owner: ownerState.owner, replace: false };
    }
    return { owner: null, replace: true };
  }
  if (!(await stableDirectoryCanBeReplaced(directory, markerNames, signal))) {
    return { owner: null, replace: false };
  }
  ownerState = await readOptionalLockOwner(path.join(directory, "owner.json"));
  if (ownerState.kind === "valid" && (await ownerProcessExists(ownerState.owner))) {
    return { owner: ownerState.owner, replace: false };
  }
  return { owner: null, replace: true };
}

export async function scavengeInitializationDebris(
  directory,
  staleBefore = Date.now() - 300_000,
) {
  let names;
  try {
    names = await readdir(directory);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return;
    }
    throw error;
  }
  for (const name of names) {
    const isInitializationDebris =
      name.startsWith(".") && (name.includes(".init-") || name.includes(".init."));
    const isRecoveryDebris = name.includes(".owner.json.recover-");
    const isRetiredState = name.includes(".lock.retired-");
    if (!isInitializationDebris && !isRecoveryDebris && !isRetiredState) {
      continue;
    }
    const debrisPath = path.join(directory, name);
    try {
      const debris = await lstat(debrisPath);
      if (isInitializationDebris || isRetiredState) {
        if (debris.mtimeMs < staleBefore) {
          await rm(debrisPath, { recursive: true, force: true });
        }
      } else if (isRecoveryDebris) {
        const recovery = await inspectOwnerClaim(debrisPath);
        if (recovery.owner === null || !(await ownerProcessExists(recovery.owner))) {
          await rm(debrisPath, { force: true });
        }
      }
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
    }
  }
}
