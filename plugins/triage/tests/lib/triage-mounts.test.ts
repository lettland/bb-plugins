import { describe, expect, test } from "vitest";

import { claimTriageRefresh } from "../../lib/triage-mounts.ts";

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
