import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { deliveredPatch, recordCancelledReview, recordUnfinishedReview, userStoppedReview } from "./review-outcome.js";
import type { ThreadState } from "./state.js";

const lookups = vi.hoisted(() => ({
  stoppedByUser: vi.fn(),
  tryCaptureSinceSeq: vi.fn(),
  reviewRecorded: vi.fn(),
  recordUnreported: vi.fn(),
  settleCodeBaseline: vi.fn(),
}));
vi.mock("./detect.js", async (original) => ({
  ...(await original<typeof import("./detect.js")>()),
  stoppedByUser: lookups.stoppedByUser,
  tryCaptureSinceSeq: lookups.tryCaptureSinceSeq,
}));
vi.mock("./findings.js", async (original) => ({
  ...(await original<typeof import("./findings.js")>()),
  reviewRecorded: lookups.reviewRecorded,
}));
vi.mock("./findings-store.js", async (original) => ({
  ...(await original<typeof import("./findings-store.js")>()),
  readFindings: vi.fn(async () => ({} as never)),
  recordUnreported: lookups.recordUnreported,
}));
vi.mock("./baseline-store.js", async (original) => ({
  ...(await original<typeof import("./baseline-store.js")>()),
  settleCodeBaseline: lookups.settleCodeBaseline,
}));

function fakeBb() {
  const warnings: string[] = [];
  const bb = { log: { warn: (message: string) => warnings.push(message) } } as unknown as BbPluginApi;
  return { bb, warnings };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("deliveredPatch", () => {
  it("carries the delivery time and the cursor when the cursor can be read", async () => {
    const { bb } = fakeBb();
    lookups.tryCaptureSinceSeq.mockResolvedValueOnce(9);
    const seq = await deliveredPatch(bb, "thr");
    expect(seq.reviewDeliveredSeq).toBe(9);
    expect(seq.reviewDeliveredAt).toBeGreaterThan(0);
  });

  it("a cursor that cannot be read leaves the patch with the time only", async () => {
    const { bb } = fakeBb();
    lookups.tryCaptureSinceSeq.mockResolvedValueOnce(undefined);
    const seq = await deliveredPatch(bb, "thr");
    expect(seq.reviewDeliveredSeq).toBeUndefined();
    expect(seq.reviewDeliveredAt).toBeGreaterThan(0);
  });
});

describe("userStoppedReview", () => {
  it("is false when neither a delivery cursor nor a stop floor nor a turn start exists", async () => {
    const { bb } = fakeBb();
    expect(await userStoppedReview(bb, "thr", { phase: "awaiting-review" } as ThreadState)).toBe(false);
    expect(lookups.stoppedByUser).not.toHaveBeenCalled();
  });

  it("asks about stops after the later of the delivery cursor and the stop floor", async () => {
    const { bb } = fakeBb();
    lookups.stoppedByUser.mockResolvedValueOnce(true);
    expect(
      await userStoppedReview(bb, "thr", {
        phase: "awaiting-review",
        reviewDeliveredSeq: 10,
        userStopFloorSeq: 14,
        turnStart: { sinceSeq: 3 },
      } as ThreadState),
    ).toBe(true);
    expect(lookups.stoppedByUser).toHaveBeenCalledWith(bb, "thr", 14);
  });

  it("a failed stop read is reported and reads as not stopped, whatever the error", async () => {
    const failing = fakeBb();
    lookups.stoppedByUser.mockRejectedValueOnce(new Error("read failed"));
    expect(await userStoppedReview(failing.bb, "thr", { phase: "awaiting-review", turnStart: { sinceSeq: 3 } } as ThreadState)).toBe(false);
    expect(failing.warnings[0]).toContain("read failed");
    const notAnError = fakeBb();
    lookups.stoppedByUser.mockRejectedValueOnce("kaboom");
    expect(await userStoppedReview(notAnError.bb, "thr", { phase: "awaiting-review", turnStart: { sinceSeq: 3 } } as ThreadState)).toBe(false);
    expect(notAnError.warnings[0]).toContain("kaboom");
  });
});

describe("recordUnfinishedReview", () => {
  it("a queued review stopped before it ran is recorded as stopped", async () => {
    const { bb } = fakeBb();
    lookups.recordUnreported.mockClear();
    lookups.settleCodeBaseline.mockClear();
    await recordUnfinishedReview(bb, "thr", { phase: "pending-dispatch" } as ThreadState, "stopped");
    expect(lookups.recordUnreported).toHaveBeenCalledWith(expect.anything(), "thr", {
      reviewId: expect.any(Number),
      outcome: "stopped",
      summary: "The queued review was stopped before it ran.",
    });
    expect(lookups.settleCodeBaseline).toHaveBeenCalledWith(bb, "thr", expect.any(Number));
  });

  it("an unreported review that simply ended gets an incident", async () => {
    const { bb } = fakeBb();
    lookups.recordUnreported.mockClear();
    lookups.reviewRecorded.mockReturnValueOnce(false);
    await recordUnfinishedReview(
      bb,
      "thr",
      { phase: "awaiting-review", reviewDeliveredAt: 21 } as ThreadState,
      "gone",
    );
    expect(lookups.recordUnreported).toHaveBeenCalledWith(expect.anything(), "thr", {
      reviewId: 21,
      outcome: "not-reported",
      summary: "The review ended without reporting.",
      incident: { kind: "not-reported", detail: expect.stringContaining("failed or was archived") },
    });
  });

  it("a reported review is left alone", async () => {
    const { bb } = fakeBb();
    lookups.recordUnreported.mockClear();
    lookups.reviewRecorded.mockReturnValueOnce(true);
    await recordUnfinishedReview(
      bb,
      "thr",
      { phase: "awaiting-review", reviewDeliveredAt: 21 } as ThreadState,
      "idle",
    );
    expect(lookups.recordUnreported).not.toHaveBeenCalled();
  });

  it("a recording failure is reported and the baseline still settles", async () => {
    const { bb, warnings } = fakeBb();
    lookups.recordUnreported.mockRejectedValueOnce("kaboom");
    lookups.reviewRecorded.mockReturnValueOnce(false);
    lookups.settleCodeBaseline.mockClear();
    await recordUnfinishedReview(
      bb,
      "thr",
      { phase: "awaiting-review", reviewDeliveredAt: 21 } as ThreadState,
      "idle",
    );
    expect(warnings[0]).toContain("kaboom");
    expect(lookups.settleCodeBaseline).toHaveBeenCalledTimes(1);
  });

  it("a user stop read from the delivery cursor records stopped", async () => {
    const { bb } = fakeBb();
    lookups.recordUnreported.mockClear();
    lookups.reviewRecorded.mockReturnValueOnce(false);
    lookups.stoppedByUser.mockResolvedValueOnce(true);
    await recordUnfinishedReview(
      bb,
      "thr",
      { phase: "awaiting-review", reviewDeliveredAt: 21, reviewDeliveredSeq: 8 } as ThreadState,
      "idle",
    );
    expect(lookups.recordUnreported).toHaveBeenCalledWith(expect.anything(), "thr", {
      reviewId: 21,
      outcome: "stopped",
      summary: "The review was stopped before it reported.",
    });
  });

  it("a phase that is not a delivered review records nothing", async () => {
    const { bb } = fakeBb();
    lookups.recordUnreported.mockClear();
    lookups.settleCodeBaseline.mockClear();
    await recordUnfinishedReview(bb, "thr", { phase: "idle" } as ThreadState, "gone");
    expect(lookups.recordUnreported).not.toHaveBeenCalled();
    expect(lookups.settleCodeBaseline).toHaveBeenCalledTimes(1);
  });
});

describe("recordCancelledReview", () => {
  it("records the cancel with the dispatch time when there is one", async () => {
    const { bb } = fakeBb();
    lookups.recordUnreported.mockClear();
    await recordCancelledReview(bb, "thr", { phase: "pending-dispatch", dispatchedAt: 33 } as ThreadState);
    expect(lookups.recordUnreported).toHaveBeenCalledWith(expect.anything(), "thr", {
      reviewId: 33,
      outcome: "stopped",
      summary: "The queued review was cancelled before it ran.",
    });
  });

  it("without a dispatch time it falls back to now", async () => {
    const { bb } = fakeBb();
    lookups.recordUnreported.mockClear();
    const before = Date.now();
    await recordCancelledReview(bb, "thr", { phase: "pending-dispatch" } as ThreadState);
    const reviewId = lookups.recordUnreported.mock.calls[0]?.[2].reviewId as number;
    expect(reviewId).toBeGreaterThanOrEqual(before);
  });
});
