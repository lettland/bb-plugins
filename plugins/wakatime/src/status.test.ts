import { describe, expect, it } from "vitest";
import { visibleError } from "./status.js";
import type { WakatimeStatus } from "./rpc-contract.js";

type Error = NonNullable<WakatimeStatus["lastError"]>;

function status(lastError: Error | null, lastHeartbeatAt: number | null) {
  return { lastError, lastHeartbeatAt };
}

const failure: Error = { kind: "network", exitCode: 112, at: 100 };

describe("visibleError", () => {
  it("shows nothing when there is no error", () => {
    expect(visibleError(status(null, 50))).toBeNull();
  });

  it("shows an error when no heartbeat has ever succeeded", () => {
    expect(visibleError(status(failure, null))).toBe(failure);
  });

  it("shows an error newer than the last successful heartbeat", () => {
    expect(visibleError(status(failure, 99))).toBe(failure);
  });

  it("hides an error a later heartbeat has recovered from", () => {
    expect(visibleError(status(failure, 100))).toBeNull();
    expect(visibleError(status(failure, 101))).toBeNull();
  });

  it("compares a missing-cli error from a spawn ENOENT, which has no problem, with the last success", () => {
    const spawnError: Error = { kind: "missing-cli", exitCode: null, at: 100 };
    expect(visibleError(status(spawnError, null))).toBe(spawnError);
    expect(visibleError(status(spawnError, 99))).toBe(spawnError);
    expect(visibleError(status(spawnError, 100))).toBeNull();
  });

  it("keeps a path problem visible until the runner clears it", () => {
    const problem: Error = { kind: "missing-cli", exitCode: null, at: 100, problem: "not-found" };
    expect(visibleError(status(problem, 500))).toBe(problem);
  });
});
