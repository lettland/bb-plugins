import { describe, expect, it } from "vitest";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import {
  isStale,
  PLAN_DENY_ANSWER_WINDOW_MS,
  PLAN_GATE_KEYS,
  planDenyFresh,
  planHoldExpired,
  presentPlanArmed,
  PRESENT_PLAN_KEYS,
  readState,
  resetToIdlePatch,
  STALE_WINDOW_MS,
  threadStateSchema,
  withThreadLock,
  writeState,
} from "./state.js";

function fakeBb(raw: unknown) {
  const warnings: string[] = [];
  const updates: unknown[] = [];
  const bb = {
    sdk: {
      threads: {
        getPluginMetadata: async () => raw,
        updatePluginMetadata: async (args: unknown) => {
          updates.push(args);
          return {};
        },
      },
    },
    log: {
      warn: (message: string) => {
        warnings.push(message);
      },
    },
  } as unknown as BbPluginApi;
  return { bb, warnings, updates };
}

describe("threadStateSchema", () => {
  it("defaults phase to idle for an empty namespace", () => {
    const parsed = threadStateSchema.parse({});
    expect(parsed.phase).toBe("idle");
  });

  it("strips a leftover skip flag from old stored state", () => {
    const parsed = threadStateSchema.parse({ skip: true });
    expect(parsed).toEqual({ phase: "idle" });
  });

  it("round-trips a full latched state", () => {
    const state = {
      phase: "pending-dispatch" as const,
      turnStart: { sinceSeq: 12 },
      pendingEntryId: "qm_1",
      dispatchedAt: 1000,
    };
    expect(threadStateSchema.parse(state)).toEqual(state);
  });
});

describe("isStale", () => {
  it("is never stale while idle", () => {
    expect(isStale({ phase: "idle", dispatchedAt: 0 }, STALE_WINDOW_MS * 10)).toBe(
      false,
    );
  });

  it("is not stale within the window", () => {
    expect(
      isStale({ phase: "awaiting-review", dispatchedAt: 1000 }, 1000 + 5),
    ).toBe(false);
  });

  it("is stale past the window", () => {
    expect(
      isStale(
        { phase: "awaiting-review", dispatchedAt: 1000 },
        1000 + STALE_WINDOW_MS + 1,
      ),
    ).toBe(true);
  });

  it("is not stale without a dispatch timestamp", () => {
    expect(isStale({ phase: "pending-dispatch" }, STALE_WINDOW_MS * 10)).toBe(
      false,
    );
  });
});

describe("resetToIdlePatch", () => {
  it("sets idle and removes latch keys", () => {
    const patch = resetToIdlePatch();
    expect(patch.set).toEqual({ phase: "idle" });
    expect(patch.remove).toEqual([
      "turnStart",
      "pendingEntryId",
      "dispatchedAt",
      "deferredSince",
      "turnDecided",
      "heldBy",
    ]);
  });
});

describe("planHoldExpired", () => {
  it("is false when no plan review is armed", () => {
    expect(planHoldExpired({ phase: "idle" }, Date.now())).toBe(false);
  });

  it("is false inside the window and true past it", () => {
    const now = STALE_WINDOW_MS * 10;
    expect(
      planHoldExpired({ phase: "idle", planReviewArmedAt: now - 1_000 }, now),
    ).toBe(false);
    expect(
      planHoldExpired(
        { phase: "idle", planReviewArmedAt: now - STALE_WINDOW_MS - 1 },
        now,
      ),
    ).toBe(true);
  });
});

describe("PLAN_GATE_KEYS", () => {
  it("is the native gate's own keys, not PresentPlan's", () => {
    expect(PLAN_GATE_KEYS).toEqual([
      "planReviewArmedAt",
      "planReviewEntryId",
      "planDenied",
    ]);
  });
});

describe("PRESENT_PLAN_KEYS", () => {
  it("is PresentPlan's own keys, kept separate from the native gate's", () => {
    expect(PRESENT_PLAN_KEYS).toEqual(["presentPlanArmedAt", "presentPlanArmedPath"]);
  });
});

describe("presentPlanArmed", () => {
  it("is false when PresentPlan never armed", () => {
    expect(presentPlanArmed({ phase: "idle" }, "a.md", Date.now())).toBe(false);
  });

  it("is true inside the window and false past it, for the armed path", () => {
    const now = STALE_WINDOW_MS * 10;
    expect(
      presentPlanArmed(
        { phase: "idle", presentPlanArmedAt: now - 1_000, presentPlanArmedPath: "a.md" },
        "a.md",
        now,
      ),
    ).toBe(true);
    expect(
      presentPlanArmed(
        {
          phase: "idle",
          presentPlanArmedAt: now - STALE_WINDOW_MS - 1,
          presentPlanArmedPath: "a.md",
        },
        "a.md",
        now,
      ),
    ).toBe(false);
  });

  it("is false for a different path than the one armed, even while fresh", () => {
    const now = STALE_WINDOW_MS * 10;
    expect(
      presentPlanArmed(
        { phase: "idle", presentPlanArmedAt: now - 1_000, presentPlanArmedPath: "a.md" },
        "b.md",
        now,
      ),
    ).toBe(false);
  });
});

describe("planDenyFresh", () => {
  it("is false when no plan deny is recorded", () => {
    expect(planDenyFresh({ phase: "idle" }, Date.now())).toBe(false);
  });

  it("is false for a future at (clock skew)", () => {
    const now = 10_000;
    expect(
      planDenyFresh({ phase: "idle", planDenied: { at: now + 1, sinceSeq: 1 } }, now),
    ).toBe(false);
  });

  it("is true at the window edge and false just past it", () => {
    const now = PLAN_DENY_ANSWER_WINDOW_MS * 10;
    expect(
      planDenyFresh(
        { phase: "idle", planDenied: { at: now - PLAN_DENY_ANSWER_WINDOW_MS, sinceSeq: 1 } },
        now,
      ),
    ).toBe(true);
    expect(
      planDenyFresh(
        { phase: "idle", planDenied: { at: now - PLAN_DENY_ANSWER_WINDOW_MS - 1, sinceSeq: 1 } },
        now,
      ),
    ).toBe(false);
  });
});

describe("withThreadLock", () => {
  it("serializes runs for the same thread", async () => {
    const order: number[] = [];
    const first = withThreadLock("thread-a", async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      order.push(1);
    });
    const second = withThreadLock("thread-a", async () => {
      order.push(2);
    });
    await Promise.all([first, second]);
    expect(order).toEqual([1, 2]);
  });

  it("does not let a rejection break the chain", async () => {
    const failing = withThreadLock("thread-b", async () => {
      throw new Error("boom");
    });
    await expect(failing).rejects.toThrow("boom");
    const value = await withThreadLock("thread-b", async () => 42);
    expect(value).toBe(42);
  });
});

describe("readState", () => {
  it("returns the parsed state", async () => {
    const { bb, warnings } = fakeBb({ phase: "deferred", deferredSince: 5 });
    expect(await readState(bb, "t")).toEqual({ phase: "deferred", deferredSince: 5 });
    expect(warnings).toEqual([]);
  });

  it("resets unparseable state to idle and says so", async () => {
    const { bb, warnings } = fakeBb({ phase: "exploded", skip: "yes" });
    expect(await readState(bb, "t")).toEqual({ phase: "idle" });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("discarding unparseable thread state for t");
  });

  it("falls back to idle silently when there is no metadata object at all", async () => {
    const { bb, warnings } = fakeBb(null);
    expect(await readState(bb, "t")).toEqual({ phase: "idle" });
    expect(warnings).toEqual([]);
  });

  it("returns a fresh idle object each time, never the shared constant", async () => {
    const { bb } = fakeBb(null);
    const first = await readState(bb, "t");
    first.turnDecided = true;
    expect(await readState(bb, "t")).toEqual({ phase: "idle" });
  });
});

describe("writeState", () => {
  it("omits the remove list when there is nothing to remove", async () => {
    const { bb, updates } = fakeBb({});
    await writeState(bb, "t", { turnDecided: true });
    expect(updates).toEqual([{ threadId: "t", set: { turnDecided: true } }]);
  });

  it("forwards the keys to remove", async () => {
    const { bb, updates } = fakeBb({});
    await writeState(bb, "t", {}, ["skip"]);
    expect(updates).toEqual([{ threadId: "t", set: {}, remove: ["skip"] }]);
  });
});
