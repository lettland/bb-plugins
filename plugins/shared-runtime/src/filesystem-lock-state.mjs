import path from "node:path";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";

import { defaultRuntimeRoot } from "./registry.mjs";
import { deny } from "./runtime-common.mjs";
import {
  createWaitReporter,
  inspectLegacyLockDirectory,
  inspectOwnerClaim,
  installOwnerClaim,
  recoverOwnerClaim,
  safeLockKey,
  sameClaimIdentity,
  scavengeInitializationDebris,
  waitOnClaimHolder,
} from "./lock-claims.mjs";

async function installFilesystemLockState(lockPath, claim) {
  try {
    await mkdir(lockPath, { mode: 0o700 });
  } catch (error) {
    if (error?.code === "EEXIST") {
      return false;
    }
    throw error;
  }
  try {
    await writeFile(
      path.join(lockPath, "owner.json"),
      `${JSON.stringify(claim.owner)}\n`,
      { mode: 0o600 },
    );
    await mkdir(path.join(lockPath, "readers"), { mode: 0o700 });
    await mkdir(path.join(lockPath, "writers"), { mode: 0o700 });
    await writeFile(
      path.join(lockPath, "rw.json"),
      `${JSON.stringify({ version: 1 })}\n`,
      { mode: 0o600 },
    );
    return true;
  } catch (error) {
    await rm(lockPath, { recursive: true, force: true });
    throw error;
  }
}

async function readStateMarker(lockPath) {
  try {
    await readFile(path.join(lockPath, "rw.json"), "utf8");
    return "ready";
  } catch (stateError) {
    if (stateError?.code === "ENOENT") {
      return "missing";
    }
    await rm(lockPath, { recursive: true, force: true });
    return "removed";
  }
}

async function replaceLockState(lockPath, claimPath, claim) {
  const verifiedClaim = await inspectOwnerClaim(claimPath);
  if (!sameClaimIdentity(verifiedClaim, claim)) {
    return false;
  }
  await rm(lockPath, { recursive: true, force: true });
  return installFilesystemLockState(lockPath, claim);
}

async function populateClaimedLockState(lockPath, claimPath, claim, signal) {
  let legacyOwner = null;
  try {
    const currentClaim = await inspectOwnerClaim(claimPath);
    if (!sameClaimIdentity(currentClaim, claim)) {
      return { legacyOwner: null, ready: false };
    }
    if ((await readStateMarker(lockPath)) === "ready") {
      return { legacyOwner: null, ready: true };
    }
    const legacyState = await inspectLegacyLockDirectory(
      lockPath,
      ["owner.json", "rw.json"],
      signal,
    );
    legacyOwner = legacyState.owner;
    if (legacyState.replace && (await replaceLockState(lockPath, claimPath, claim))) {
      return { legacyOwner: null, ready: true };
    }
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { legacyOwner: null, ready: false };
    }
    throw error;
  } finally {
    await recoverOwnerClaim(claimPath, claim);
  }
  return { legacyOwner, ready: false };
}

export async function ensureFilesystemLockState(key, signal, options) {
  const safeKey = safeLockKey(key);
  const lockRoot = options.lockRoot ?? path.join(defaultRuntimeRoot(), "locks");
  if (!path.isAbsolute(lockRoot)) {
    deny("lock root is not absolute");
  }
  await mkdir(lockRoot, { recursive: true, mode: 0o700 });
  await scavengeInitializationDebris(lockRoot);
  const lockPath = path.join(lockRoot, `${safeKey}.lock`);
  const claimPath = `${lockPath}.owner.json`;
  const reportWait = createWaitReporter(options);
  while (true) {
    if (signal?.aborted) {
      throw signal.reason ?? new Error("operation aborted while waiting for lock");
    }
    const marker = await readStateMarker(lockPath);
    if (marker === "ready") {
      return lockPath;
    }
    if (marker === "removed") {
      continue;
    }
    const claim = await installOwnerClaim(claimPath);
    if (claim === null) {
      await waitOnClaimHolder(claimPath, reportWait, 100);
      continue;
    }
    const state = await populateClaimedLockState(lockPath, claimPath, claim, signal);
    if (state.ready) {
      return lockPath;
    }
    if (state.legacyOwner !== null) {
      reportWait(
        state.legacyOwner,
        JSON.stringify([state.legacyOwner.pid, state.legacyOwner.createdAt]),
      );
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}
