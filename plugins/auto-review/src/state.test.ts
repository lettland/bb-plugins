import { describe, expect, it } from "vitest";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import {
  isStale,
  LATCH_KEYS,
  PLAN_DENY_ANSWER_WINDOW_MS,
  PLAN_GATE_KEYS,
  planDenyFresh,
  planHoldExpired,
  presentPlanArmed,
  presentPlanHoldActive,
  PRESENT_PLAN_KEYS,
  readState,
  resetToIdlePatch,
  REVIEW_CONTINUATION_CAP_MS,
  STALE_WINDOW_MS,
  threadStateSchema,
  withThreadLock,
  writeState,
} from "./state.js";

function fakeBb(raw: unknown) {
  const warnings: string[] = [];
  const updates: unknown[] = [];
  const published: Array<{ channel: string; payload: unknown }> = [];
  let publishThrows = false;
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
    realtime: {
      publish: (channel: string, payload: unknown) => {
        if (publishThrows) {
          throw new Error("realtime down");
        }
        published.push({ channel, payload });
      },
    },
  } as unknown as BbPluginApi;
  return { bb, warnings, updates, published, breakPublish: () => (publishThrows = true) };
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

  it("round-trips the last idle's cursor, time and tree", () => {
    const lastIdle = {
      sinceSeq: 130,
      startedAt: 1_000,
      tree: { headSha: "abc", files: { "src/a.ts": "1|h" }, commits: [] },
    };
    expect(threadStateSchema.parse({ phase: "idle", lastIdle }).lastIdle).toEqual(lastIdle);
  });

  it("round-trips the plan review's light-tier keys for both gates", () => {
    const state = { phase: "idle" as const, planReviewLight: true, presentPlanLight: false };
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
      "lastIdle",
      "heldBy",
      "reviewDeliveredAt",
      "reviewDeliveredSeq",
      "userTurnStart",
      "userTurnAuthored",
      "userStopFloorSeq",
      "handledTurnEndSeq",
      "reviewTurnEndSeq",
      "reviewSkillRequired",
    ]);
  });

  it("clears the last idle's snapshot", () => {
    expect(LATCH_KEYS).toContain("lastIdle");
    expect(resetToIdlePatch().remove).toContain("lastIdle");
  });

  it("keeps the last code review's cursor", () => {
    expect(resetToIdlePatch().remove).not.toContain("lastCodeReviewSeq");
    expect(LATCH_KEYS).not.toContain("lastCodeReviewSeq");
    expect(threadStateSchema.parse({ lastCodeReviewSeq: 7 }).lastCodeReviewSeq).toBe(7);
  });
});

describe("planHoldExpired", () => {
  it("is false when no plan review is armed", () => {
    expect(planHoldExpired({ phase: "idle" }, Date.now())).toBe(false);
  });

  it("is false inside the window and true past it for a queued arm", () => {
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

  it("lets a delivered arm run to the continuation cap, not the stale window", () => {
    const now = REVIEW_CONTINUATION_CAP_MS * 10;
    const state = {
      phase: "idle" as const,
      planReviewArmedAt: now - STALE_WINDOW_MS - 1,
      planReviewDeliveredSeq: 100,
    };
    expect(planHoldExpired(state, now)).toBe(false);
    expect(
      planHoldExpired(
        { ...state, planReviewArmedAt: now - REVIEW_CONTINUATION_CAP_MS - 1 },
        now,
      ),
    ).toBe(true);
  });

  it("keeps the stale window while the review is recorded as queued, delivery cursor or not", () => {
    const now = STALE_WINDOW_MS * 10;
    expect(
      planHoldExpired(
        {
          phase: "idle",
          planReviewArmedAt: now - STALE_WINDOW_MS - 1,
          planReviewEntryId: "qm-1",
          planReviewDeliveredSeq: 100,
        },
        now,
      ),
    ).toBe(true);
  });

  it("keeps a delivered arm at exactly the cap: elapsedBeyond is strict", () => {
    const now = REVIEW_CONTINUATION_CAP_MS * 10;
    expect(
      planHoldExpired(
        {
          phase: "idle",
          planReviewArmedAt: now - REVIEW_CONTINUATION_CAP_MS,
          planReviewDeliveredSeq: 100,
        },
        now,
      ),
    ).toBe(false);
  });

  it("is false on a PresentPlan arm alone, fresh or expired: the native arm unset keeps it false", () => {
    const now = REVIEW_CONTINUATION_CAP_MS * 10;
    expect(
      planHoldExpired({ phase: "idle", presentPlanArmedAt: now - 1_000 }, now),
    ).toBe(false);
    expect(
      planHoldExpired(
        { phase: "idle", presentPlanArmedAt: now - REVIEW_CONTINUATION_CAP_MS - 1 },
        now,
      ),
    ).toBe(false);
  });

  it("follows the native arm alone when both arms are set", () => {
    const now = STALE_WINDOW_MS * 10;
    // A leftover expired PresentPlan arm cannot expire a live native arm...
    expect(
      planHoldExpired(
        {
          phase: "idle",
          planReviewArmedAt: now - 1_000,
          presentPlanArmedAt: now - REVIEW_CONTINUATION_CAP_MS - 1,
        },
        now,
      ),
    ).toBe(false);
    // ...and a live one cannot keep a native arm past its window from expiring.
    expect(
      planHoldExpired(
        {
          phase: "idle",
          planReviewArmedAt: now - STALE_WINDOW_MS - 1,
          presentPlanArmedAt: now - 1_000,
        },
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
      "planReviewDeliveredSeq",
      "planReviewArmedSeq",
      "planReviewRedone",
      "planReviewLight",
    ]);
  });
});

describe("PRESENT_PLAN_KEYS", () => {
  it("is PresentPlan's own keys, kept separate from the native gate's", () => {
    expect(PRESENT_PLAN_KEYS).toEqual([
      "presentPlanArmedAt",
      "presentPlanArmedPath",
      "presentPlanArmedSeq",
      "presentPlanRedone",
      "presentPlanLight",
    ]);
  });
});

describe("presentPlanArmed", () => {
  it("is false when PresentPlan never armed", () => {
    expect(presentPlanArmed({ phase: "idle" }, "a.md", Date.now())).toBe(false);
  });

  it("is true inside the window and false past it, for the armed path", () => {
    const now = REVIEW_CONTINUATION_CAP_MS * 10;
    expect(
      presentPlanArmed(
        { phase: "idle", presentPlanArmedAt: now - 1_000, presentPlanArmedPath: "a.md" },
        "a.md",
        now,
      ),
    ).toBe(true);
    // The review rides the first call's tool result, so it gets the
    // continuation cap: still armed past the stale window.
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
    ).toBe(true);
    expect(
      presentPlanArmed(
        {
          phase: "idle",
          presentPlanArmedAt: now - REVIEW_CONTINUATION_CAP_MS - 1,
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

describe("presentPlanHoldActive", () => {
  const now = REVIEW_CONTINUATION_CAP_MS * 10;

  it("is false when PresentPlan never armed", () => {
    expect(presentPlanHoldActive({ phase: "idle" }, now)).toBe(false);
  });

  it("ignores the armed path: the suppression caller uses it path-free on purpose, an arm for any plan path holds the thread", () => {
    expect(
      presentPlanHoldActive(
        { phase: "idle", presentPlanArmedAt: now - 1_000, presentPlanArmedPath: "a.md" },
        now,
      ),
    ).toBe(true);
    expect(
      presentPlanHoldActive({ phase: "idle", presentPlanArmedAt: now - 1_000 }, now),
    ).toBe(true);
  });

  it("persists at exactly the cap and expires past it (elapsedBeyond is strict)", () => {
    expect(
      presentPlanHoldActive(
        { phase: "idle", presentPlanArmedAt: now - REVIEW_CONTINUATION_CAP_MS },
        now,
      ),
    ).toBe(true);
    expect(
      presentPlanHoldActive(
        { phase: "idle", presentPlanArmedAt: now - REVIEW_CONTINUATION_CAP_MS - 1 },
        now,
      ),
    ).toBe(false);
  });

  it("presentPlanArmed delegates its window here, so a cap change moves both", () => {
    const armed = {
      phase: "idle" as const,
      presentPlanArmedAt: now - REVIEW_CONTINUATION_CAP_MS,
      presentPlanArmedPath: "a.md",
    };
    expect(presentPlanArmed(armed, "a.md", now)).toBe(presentPlanHoldActive(armed, now));
    const expired = { ...armed, presentPlanArmedAt: now - REVIEW_CONTINUATION_CAP_MS - 1 };
    expect(presentPlanArmed(expired, "a.md", now)).toBe(presentPlanHoldActive(expired, now));
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

  it("publishes to the thread's realtime channel when the phase is written", async () => {
    const { bb, published } = fakeBb({});
    await writeState(bb, "t", { phase: "idle" }, ["turnStart"]);
    expect(published).toEqual([{ channel: "auto-review:thread:t", payload: {} }]);
  });

  it("does not publish for a write that leaves the phase alone", async () => {
    const { bb, published } = fakeBb({});
    await writeState(bb, "t", { turnDecided: true });
    await writeState(bb, "t", {}, ["turnStart"]);
    expect(published).toEqual([]);
  });

  it("logs and swallows a failed publish instead of failing the write", async () => {
    const { bb, warnings, updates, breakPublish } = fakeBb({});
    breakPublish();
    await expect(writeState(bb, "t", { phase: "awaiting-review" })).resolves.toBeUndefined();
    expect(updates).toHaveLength(1);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("could not publish the review update for t");
  });

  it("logs a failed publish whatever the error is", async () => {
    const warnings: string[] = [];
    const bb = {
      sdk: {
        threads: {
          getPluginMetadata: async () => ({}),
          updatePluginMetadata: async () => ({}),
        },
      },
      realtime: {
        publish: () => {
          throw "kaboom";
        },
      },
      log: { warn: (message: string) => warnings.push(message) },
    } as unknown as BbPluginApi;
    await expect(writeState(bb, "t", { phase: "idle" })).resolves.toBeUndefined();
    expect(warnings[0]).toContain("kaboom");
  });
});
