import path from "node:path";
import { randomUUID } from "node:crypto";
import { readdir, rename, rm, writeFile } from "node:fs/promises";

import { readProcessIdentity, ownerProcessExists } from "./process-identity.mjs";
import {
  lockMode,
  createLockOwner,
  reportLockWait,
  waitForMemoryLock,
} from "./lock-state.mjs";
import { safeLockKey, readLockOwner } from "./lock-claims.mjs";
import { ensureFilesystemLockState } from "./filesystem-lock-state.mjs";
import { acquireStateGate } from "./state-gate.mjs";

async function activeFilesystemLeases(directory) {
  let names;
  try {
    names = await readdir(directory);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return [];
    }
    throw error;
  }
  const leases = [];
  for (const name of names) {
    const leasePath = path.join(directory, name);
    try {
      const owner = await readLockOwner(leasePath);
      if (
        typeof owner.id !== "string" ||
        owner.id === "" ||
        !Number.isFinite(owner.createdAt)
      ) {
        throw new Error("lock lease metadata is invalid");
      }
      if (await ownerProcessExists(owner)) {
        leases.push({ ...owner, leasePath });
      } else {
        await rm(leasePath, { force: true });
      }
    } catch {
      await rm(leasePath, { force: true });
    }
  }
  return leases.sort(
    (left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id),
  );
}

async function releaseFilesystemLease(lockPath, leasePath) {
  while (true) {
    const releaseGate = await acquireStateGate(lockPath);
    if (releaseGate === null) {
      return;
    }
    let removedState = false;
    try {
      await rm(leasePath, { force: true });
      const readers = await activeFilesystemLeases(path.join(lockPath, "readers"));
      const writers = await activeFilesystemLeases(path.join(lockPath, "writers"));
      if (readers.length === 0 && writers.length === 0) {
        const retiredPath = `${lockPath}.retired-${randomUUID()}`;
        await rename(lockPath, retiredPath);
        removedState = true;
        await rm(retiredPath, { recursive: true, force: true });
      }
      return;
    } finally {
      if (!removedState) {
        await releaseGate();
      }
    }
  }
}

async function acquireFilesystemLock(key, options) {
  const mode = lockMode(options);
  const owner = createLockOwner(options, mode);
  const processIdentity = await readProcessIdentity(process.pid);
  if (processIdentity !== null) {
    owner.processIdentity = processIdentity;
  }
  let leasePath = null;
  let lastWaitOwner = null;
  try {
    while (true) {
      if (options.signal?.aborted) {
        throw options.signal.reason ?? new Error("operation aborted while waiting for lock");
      }
      const lockPath = await ensureFilesystemLockState(key, options.signal, options);
      const releaseGate = await acquireStateGate(lockPath, options.signal, options);
      if (releaseGate === null) {
        continue;
      }
      let stateRetired = false;
      let waitOwner = null;
      try {
        const readersDirectory = path.join(lockPath, "readers");
        const writersDirectory = path.join(lockPath, "writers");
        const readers = await activeFilesystemLeases(readersDirectory);
        let writers = await activeFilesystemLeases(writersDirectory);
        if (mode === "shared") {
          if (writers.length === 0) {
            leasePath = path.join(readersDirectory, `${safeLockKey(owner.id)}.json`);
            await writeFile(leasePath, `${JSON.stringify(owner)}\n`, { mode: 0o600 });
            return async () => releaseFilesystemLease(lockPath, leasePath);
          }
          waitOwner = writers[0];
        } else {
          if (leasePath === null) {
            leasePath = path.join(writersDirectory, `${safeLockKey(owner.id)}.json`);
            await writeFile(leasePath, `${JSON.stringify(owner)}\n`, { mode: 0o600 });
            writers = await activeFilesystemLeases(writersDirectory);
          }
          if (writers[0]?.id === owner.id && readers.length === 0) {
            return async () => releaseFilesystemLease(lockPath, leasePath);
          }
          waitOwner = writers[0]?.id === owner.id ? readers[0] : writers[0];
        }
      } catch (error) {
        if (error?.code !== "ENOENT") {
          throw error;
        }
        leasePath = null;
        stateRetired = true;
      } finally {
        await releaseGate();
      }
      if (stateRetired) {
        continue;
      }
      const waitSignature = JSON.stringify([
        waitOwner?.pid,
        waitOwner?.createdAt,
        waitOwner?.environmentId,
        waitOwner?.operation,
      ]);
      if (waitOwner !== null && waitSignature !== lastWaitOwner) {
        reportLockWait(options, waitOwner);
        lastWaitOwner = waitSignature;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  } catch (error) {
    if (leasePath !== null) {
      await releaseFilesystemLease(path.dirname(path.dirname(leasePath)), leasePath);
    }
    throw error;
  }
}

export async function withProjectLock(key, operation, options = {}) {
  const release = options.lockAdapter
    ? await waitForMemoryLock(key, options.lockAdapter, options)
    : await acquireFilesystemLock(key, options);
  try {
    return await operation();
  } finally {
    await release();
  }
}
