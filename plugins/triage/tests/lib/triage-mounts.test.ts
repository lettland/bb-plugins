import { describe, expect, test, vi } from "vitest";

import { claimReconnectRefresh, claimTriageRefresh } from "../../lib/triage-mounts.ts";

describe("claimTriageRefresh", () => {
  test("unstamped payloads always claim", () => {
    expect(claimTriageRefresh(undefined)).toBe(true);
    expect(claimTriageRefresh(null)).toBe(true);
    expect(claimTriageRefresh({})).toBe(true);
    expect(claimTriageRefresh({ at: "soon" })).toBe(true);
  });

  test("a stamped payload claims once; a new stamp claims again", () => {
    expect(claimTriageRefresh({ at: 100 })).toBe(true);
    expect(claimTriageRefresh({ at: 100 })).toBe(false);
    expect(claimTriageRefresh({ at: 200 })).toBe(true);
    expect(claimTriageRefresh({ at: 200 })).toBe(false);
  });
});

describe("claimReconnectRefresh", () => {
  test("the first call ever in a fresh module never claims", async () => {
    vi.resetModules();
    const fresh = await import("../../lib/triage-mounts.ts");
    expect(fresh.claimReconnectRefresh("connected")).toBe(false);
  });

  test("a return from reconnecting claims once", () => {
    claimReconnectRefresh("reconnecting");
    expect(claimReconnectRefresh("connected")).toBe(true);
    expect(claimReconnectRefresh("connected")).toBe(false);
  });

  test("the initial connecting to connected claims", () => {
    claimReconnectRefresh("connecting");
    expect(claimReconnectRefresh("connected")).toBe(true);
  });

  test("staying connected never claims", () => {
    claimReconnectRefresh("connected");
    expect(claimReconnectRefresh("connected")).toBe(false);
  });

  test("a non-connected state never claims", () => {
    claimReconnectRefresh("connected");
    expect(claimReconnectRefresh("reconnecting")).toBe(false);
    expect(claimReconnectRefresh("connecting")).toBe(false);
  });
});
