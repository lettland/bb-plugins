import path from "node:path";
import { mkdir, rm, writeFile } from "node:fs/promises";

import {
  createWaitReporter,
  inspectLegacyLockDirectory,
  inspectOwnerClaim,
  installOwnerClaim,
  recoverOwnerClaim,
  sameClaimIdentity,
  scavengeInitializationDebris,
  waitOnClaimHolder,
} from "./lock-claims.mjs";

async function installStateGate(gatePath, claim) {
  try {
    await mkdir(gatePath, { mode: 0o700 });
  } catch (error) {
    if (error?.code === "EEXIST") {
      return false;
    }
    throw error;
  }
  try {
    await writeFile(
      path.join(gatePath, "owner.json"),
      `${JSON.stringify(claim.owner)}\n`,
      { mode: 0o600 },
    );
    return true;
  } catch (error) {
    await rm(gatePath, { recursive: true, force: true });
    throw error;
  }
}

async function replaceStateGate(gatePath, claimPath, claim, signal) {
  const legacyState = await inspectLegacyLockDirectory(gatePath, ["owner.json"], signal);
  if (!legacyState.replace) {
    return false;
  }
  const verifiedClaim = await inspectOwnerClaim(claimPath);
  if (!sameClaimIdentity(verifiedClaim, claim)) {
    return false;
  }
  await rm(gatePath, { recursive: true, force: true });
  try {
    return await installStateGate(gatePath, claim);
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
    return false;
  }
}

export async function acquireStateGate(lockPath, signal, options = {}) {
  const gatePath = path.join(lockPath, "gate.lock");
  const claimPath = `${gatePath}.owner.json`;
  const reportWait = createWaitReporter(options);
  await scavengeInitializationDebris(lockPath);
  while (true) {
    if (signal?.aborted) {
      throw signal.reason ?? new Error("operation aborted while waiting for lock");
    }
    let claim;
    try {
      claim = await installOwnerClaim(claimPath);
    } catch (error) {
      if (error?.code === "ENOENT") {
        return null;
      }
      throw error;
    }
    if (claim === null) {
      await waitOnClaimHolder(claimPath, reportWait, 25);
      continue;
    }

    let keepClaim = false;
    try {
      const currentClaim = await inspectOwnerClaim(claimPath);
      if (!sameClaimIdentity(currentClaim, claim)) {
        continue;
      }
      if (await replaceStateGate(gatePath, claimPath, claim, signal)) {
        keepClaim = true;
        return async () => {
          await rm(gatePath, { recursive: true, force: true });
          await recoverOwnerClaim(claimPath, claim);
        };
      }
    } catch (error) {
      if (error?.code === "ENOENT") {
        continue;
      }
      throw error;
    } finally {
      if (!keepClaim) {
        await recoverOwnerClaim(claimPath, claim);
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
