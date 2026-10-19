import type { WakatimeStatus } from "./rpc-contract.js";

/**
 * The error worth showing: one newer than the last successful heartbeat.
 * Anything older has been recovered from. A path problem has no success to
 * compare with, so it shows until the path check passes (which clears it).
 */
export function visibleError(status: Pick<WakatimeStatus, "lastError" | "lastHeartbeatAt">) {
  const { lastError, lastHeartbeatAt } = status;
  if (lastError === null) return null;
  if (lastError.problem !== undefined) return lastError;
  return lastHeartbeatAt === null || lastError.at > lastHeartbeatAt ? lastError : null;
}
