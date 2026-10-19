import { describe, expect, it } from "vitest";
import { visibleError } from "./status.js";
import type { WakatimeStatus } from "./rpc-contract.js";

type Error = NonNullable<WakatimeStatus["lastError"]>;

function status(lastError: Error | null, lastHeartbeatAt: number | null, lastSyncAt: number | null) {
  return { lastError, lastHeartbeatAt, lastSyncAt };
}

const heartbeatError: Error = { kind: "network", job: "heartbeat", exitCode: 112, at: 100 };
const syncError: Error = { kind: "auth", job: "sync", exitCode: 104, at: 100 };

describe("visibleError", () => {
  it("shows nothing when there is no error", () => {
    expect(visibleError(status(null, 50, 50))).toBeNull();
  });

  it("shows an error when its job has never succeeded", () => {
    expect(visibleError(status(heartbeatError, null, 500))).toBe(heartbeatError);
    expect(visibleError(status(syncError, 500, null))).toBe(syncError);
  });

  it("shows an error newer than its job's last success", () => {
    expect(visibleError(status(heartbeatError, 99, null))).toBe(heartbeatError);
    expect(visibleError(status(syncError, null, 99))).toBe(syncError);
  });

  it("hides an error its own job has since recovered from", () => {
    expect(visibleError(status(heartbeatError, 100, null))).toBeNull();
    expect(visibleError(status(heartbeatError, 101, null))).toBeNull();
    expect(visibleError(status(syncError, null, 150))).toBeNull();
  });

  it("compares with the failed job only, not the other one", () => {
    expect(visibleError(status(heartbeatError, null, 500))).toBe(heartbeatError);
    expect(visibleError(status(syncError, 500, null))).toBe(syncError);
  });

  it("compares a missing-cli error from a spawn ENOENT, which has no problem, with its job's last success", () => {
    const spawnError: Error = { kind: "missing-cli", job: "heartbeat", exitCode: null, at: 100 };
    expect(visibleError(status(spawnError, null, 500))).toBe(spawnError);
    expect(visibleError(status(spawnError, 99, null))).toBe(spawnError);
    expect(visibleError(status(spawnError, 100, null))).toBeNull();
    expect(visibleError(status({ ...spawnError, job: "sync" }, 500, 100))).toBeNull();
    expect(visibleError(status({ ...spawnError, job: "sync" }, 500, 99))).not.toBeNull();
  });

  it("keeps a path problem visible until the runner clears it", () => {
    const problem: Error = { kind: "missing-cli", job: "heartbeat", exitCode: null, at: 100, problem: "not-found" };
    expect(visibleError(status(problem, 500, 500))).toBe(problem);
  });
});
