import { describe, expect, it } from "vitest";
import {
  isImmediateReactionToDeny,
  planApprovalOf,
  planGateAction,
  userQuestionOf,
} from "./plan.js";
import { STALE_WINDOW_MS } from "./state.js";

function approval(overrides: Record<string, unknown> = {}, subject: Record<string, unknown> = {}) {
  return {
    id: "pint-1",
    status: "pending",
    payload: {
      kind: "approval",
      availableDecisions: ["allow_once", "deny"],
      reason: null,
      subject: { kind: "plan", itemId: "i", plan: "# Plan", planFilePath: "/p.md", ...subject },
    },
    ...overrides,
  } as never;
}

describe("planApprovalOf", () => {
  it("extracts a pending, deniable plan approval", () => {
    expect(planApprovalOf(approval())).toEqual({
      interactionId: "pint-1",
      plan: "# Plan",
      planFilePath: "/p.md",
    });
  });

  it("ignores settled, non-plan, and undeniable approvals", () => {
    expect(planApprovalOf(approval({ status: "resolved" }))).toBeNull();
    expect(planApprovalOf(approval({}, { kind: "command" }))).toBeNull();
    const undeniable = approval();
    (undeniable as { payload: { availableDecisions: string[] } }).payload.availableDecisions = ["allow_once"];
    expect(planApprovalOf(undeniable)).toBeNull();
    expect(planApprovalOf({ id: "x", status: "pending", payload: { kind: "user_question" } } as never)).toBeNull();
  });
});

function question(
  overrides: Record<string, unknown> = {},
  questions: Array<Record<string, unknown>> = [{ id: "q1", allowFreeText: true }],
) {
  return {
    id: "uq-1",
    status: "pending",
    payload: { kind: "user_question", questions },
    ...overrides,
  } as never;
}

describe("userQuestionOf", () => {
  it("extracts a pending question whose options all allow free text", () => {
    const interaction = question({}, [
      { id: "q1", allowFreeText: true },
      { id: "q2", allowFreeText: true },
    ]);
    expect(userQuestionOf(interaction)).toEqual({
      interactionId: "uq-1",
      questionIds: ["q1", "q2"],
    });
  });

  it("ignores settled, non-question, and partially free-text-less interactions", () => {
    expect(userQuestionOf(question({ status: "resolved" }))).toBeNull();
    expect(
      userQuestionOf({ id: "x", status: "pending", payload: { kind: "approval" } } as never),
    ).toBeNull();
    expect(
      userQuestionOf(
        question({}, [
          { id: "q1", allowFreeText: true },
          { id: "q2", allowFreeText: false },
        ]),
      ),
    ).toBeNull();
  });
});

describe("isImmediateReactionToDeny", () => {
  function itemStarted(item: Record<string, unknown>) {
    return { type: "item/started", data: { item } } as never;
  }

  it("is true with no events, or only reasoning and the question's own native item", () => {
    expect(isImmediateReactionToDeny([])).toBe(true);
    expect(
      isImmediateReactionToDeny([
        itemStarted({ type: "reasoning" }),
        itemStarted({ type: "toolCall", tool: "AskUserQuestion" }),
      ]),
    ).toBe(true);
  });

  it("ignores non-item/started events", () => {
    expect(isImmediateReactionToDeny([{ type: "system/thread/interrupted", data: {} } as never])).toBe(
      true,
    );
  });

  it("is false once agent text closed the turn the steer rides in on", () => {
    expect(isImmediateReactionToDeny([itemStarted({ type: "agentMessage" })])).toBe(false);
  });

  it("is false for an MCP AskUserQuestion, which cannot take this resolution", () => {
    expect(
      isImmediateReactionToDeny([
        itemStarted({ type: "toolCall", tool: "AskUserQuestion", server: "bb-bridge" }),
      ]),
    ).toBe(false);
  });

  it("is false once a real tool call happened", () => {
    expect(isImmediateReactionToDeny([itemStarted({ type: "commandExecution" })])).toBe(false);
    expect(
      isImmediateReactionToDeny([itemStarted({ type: "toolCall", tool: "Bash" })]),
    ).toBe(false);
    expect(isImmediateReactionToDeny([itemStarted({ type: "userMessage" })])).toBe(false);
  });
});

describe("planGateAction", () => {
  const NOW = STALE_WINDOW_MS * 10;

  it("reviews the first presentation and releases the next", () => {
    expect(planGateAction({ phase: "idle" }, NOW)).toBe("review");
    expect(planGateAction({ phase: "idle", planReviewArmedAt: NOW - 1_000 }, NOW)).toBe(
      "release",
    );
  });

  it("holds a re-presentation while the review is still queued", () => {
    expect(
      planGateAction(
        { phase: "idle", planReviewArmedAt: NOW - 1_000, planReviewEntryId: "qm" },
        NOW,
      ),
    ).toBe("hold");
  });

  it("treats a presentation after the hold has gone stale as a fresh review, not a release", () => {
    expect(
      planGateAction(
        { phase: "idle", planReviewArmedAt: NOW - STALE_WINDOW_MS - 1 },
        NOW,
      ),
    ).toBe("review");
  });

  it("still releases right at the edge of the stale window", () => {
    expect(
      planGateAction({ phase: "idle", planReviewArmedAt: NOW - STALE_WINDOW_MS }, NOW),
    ).toBe("release");
  });
});
