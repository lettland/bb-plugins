import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_LIMIT,
  DIRECTIONS,
  KEEPER_INTERVAL_MS,
  MAX_REASON_LENGTH,
  errorMessage,
  httpStatus,
  limitsSchema,
  pausedReason,
  queueEntriesSchema,
  queueIntentSchema,
  sleep,
  staleReason,
  waitDecision,
} from "./shared.js";

describe("errorMessage", () => {
  it("returns an Error's message", () => {
    expect(errorMessage(new Error("bad thing"))).toBe("bad thing");
  });

  it("stringifies values that are not Errors", () => {
    expect(errorMessage("plain string")).toBe("plain string");
    expect(errorMessage(42)).toBe("42");
  });
});

describe("httpStatus", () => {
  it("reads a numeric status", () => {
    expect(httpStatus({ status: 404 })).toBe(404);
  });

  it("returns null when the status is not a number", () => {
    expect(httpStatus({ status: "404" })).toBeNull();
  });

  it("returns null when there is no status", () => {
    expect(httpStatus(new Error("no status"))).toBeNull();
    expect(httpStatus(null)).toBeNull();
  });
});

describe("staleReason", () => {
  it("names a thread that is no longer pending", () => {
    expect(
      staleReason({ status: "idle", archivedAt: null, deletedAt: null }),
    ).toBe("thread is idle");
  });

  it("reports a deleted thread before an archived one", () => {
    expect(
      staleReason({ status: "pending", archivedAt: 5, deletedAt: 7 }),
    ).toBe("thread was deleted");
  });

  it("names an archived thread", () => {
    expect(
      staleReason({ status: "pending", archivedAt: 5, deletedAt: null }),
    ).toBe("thread was archived");
  });

  it("returns null for a live pending thread", () => {
    expect(
      staleReason({ status: "pending", archivedAt: null, deletedAt: null }),
    ).toBeNull();
  });
});

describe("queueEntriesSchema", () => {
  it("accepts ordered entries", () => {
    expect(
      queueEntriesSchema.safeParse([
        { threadId: "thr_a", providerId: "p1" },
        { threadId: "thr_b", providerId: "p2" },
      ]),
    ).toMatchObject({ success: true });
  });

  it.each([
    ["a bare string list", ["thr_a"]],
    ["an entry without a provider", [{ threadId: "thr_a" }]],
    ["an entry with an empty thread id", [{ threadId: "", providerId: "p1" }]],
    ["an entry with extra keys", [{ threadId: "thr_a", providerId: "p1", x: 1 }]],
    ["a non-array value", { threadId: "thr_a" }],
  ])("rejects %s", (_label, value) => {
    expect(queueEntriesSchema.safeParse(value).success).toBe(false);
  });
});

describe("limitsSchema", () => {
  it("accepts a map of non-negative integers", () => {
    expect(limitsSchema.safeParse({ p1: 0, p2: 3 })).toMatchObject({
      success: true,
    });
  });

  it.each([
    ["a negative limit", { p1: -1 }],
    ["a fractional limit", { p1: 1.5 }],
    ["a non-numeric limit", { p1: "2" }],
  ])("rejects %s", (_label, value) => {
    expect(limitsSchema.safeParse(value).success).toBe(false);
  });
});

describe("queueIntentSchema", () => {
  it("accepts the queue flag", () => {
    expect(queueIntentSchema.safeParse({ queue: true })).toMatchObject({
      success: true,
    });
  });

  it.each([
    ["a false flag", { queue: false }],
    ["a string flag", { queue: "true" }],
    ["extra keys", { queue: true, other: 1 }],
    ["a missing flag", {}],
  ])("rejects %s", (_label, value) => {
    expect(queueIntentSchema.safeParse(value).success).toBe(false);
  });
});

describe("waitDecision", () => {
  it("singularizes one running thread", () => {
    expect(waitDecision(1, "Codex", 2)).toBe(
      "1 thread running on Codex, limit 2",
    );
  });

  it("pluralizes several running threads", () => {
    expect(waitDecision(3, "Codex", DEFAULT_LIMIT)).toBe(
      "3 threads running on Codex, limit 2",
    );
  });

  it("keeps a short reason as is", () => {
    const reason = waitDecision(1, "x".repeat(150), 2);
    expect(reason).toBe(`1 thread running on ${"x".repeat(150)}, limit 2`);
    expect(reason.length).toBeLessThanOrEqual(MAX_REASON_LENGTH);
    expect(reason.endsWith("…")).toBe(false);
  });

  it("truncates a long reason", () => {
    const reason = waitDecision(1, "x".repeat(MAX_REASON_LENGTH * 2), 2);
    expect(reason.length).toBe(MAX_REASON_LENGTH);
    expect(reason.endsWith("…")).toBe(true);
  });

  it("truncates without splitting a surrogate pair", () => {
    const prefix = "1 thread running on ";
    const label =
      "x".repeat(MAX_REASON_LENGTH - prefix.length - 2) +
      "🚀" +
      "y".repeat(10);
    const reason = waitDecision(1, label, 2);
    expect(reason).toBe(
      prefix + "x".repeat(MAX_REASON_LENGTH - prefix.length - 2) + "…",
    );
    expect(reason.length).toBeLessThanOrEqual(MAX_REASON_LENGTH);
  });
});

describe("pausedReason", () => {
  it("names a paused provider", () => {
    expect(pausedReason("Codex")).toBe("Codex is paused (limit 0)");
  });

  it("truncates a long provider label", () => {
    const reason = pausedReason("x".repeat(MAX_REASON_LENGTH * 2));
    expect(reason.length).toBe(MAX_REASON_LENGTH);
    expect(reason.endsWith("…")).toBe(true);
  });
});

describe("DIRECTIONS", () => {
  it("lists the four move directions", () => {
    expect([...DIRECTIONS]).toEqual(["up", "down", "top", "bottom"]);
  });
});

describe("sleep", () => {
  it("resolves immediately for an already-aborted signal", async () => {
    await sleep(KEEPER_INTERVAL_MS * 100, AbortSignal.abort());
  });

  it("wakes early when the signal aborts mid-wait", async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const done = sleep(KEEPER_INTERVAL_MS, controller.signal);
      controller.abort();
      await vi.advanceTimersByTimeAsync(0);
      await done;
    } finally {
      vi.useRealTimers();
    }
  });

  it("resolves when the wait elapses", async () => {
    vi.useFakeTimers();
    try {
      const done = sleep(KEEPER_INTERVAL_MS, new AbortController().signal);
      await vi.advanceTimersByTimeAsync(KEEPER_INTERVAL_MS);
      await done;
    } finally {
      vi.useRealTimers();
    }
  });
});
