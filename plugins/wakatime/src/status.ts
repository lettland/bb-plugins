import type { WakatimeStatus } from "./rpc-contract.js";

/**
 * The error worth showing: one newer than the last success of the job that
 * failed. Anything older has been recovered from. A path problem has no
 * success to compare with, so it shows until the path check passes (which
 * clears it).
 */
export function visibleError(status: Pick<WakatimeStatus, "lastError" | "lastHeartbeatAt" | "lastSyncAt">) {
  const { lastError } = status;
  if (lastError === null) return null;
  if (lastError.problem !== undefined) return lastError;
  const lastSuccessAt = lastError.job === "sync" ? status.lastSyncAt : status.lastHeartbeatAt;
  return lastSuccessAt === null || lastError.at > lastSuccessAt ? lastError : null;
}
