import { describe, expect, it } from "vitest";
import {
  isImmediateReactionToDeny,
  planApprovalOf,
  planGateAction,
  reviewReachedAgent,
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
      canApprove: true,
    });
  });

  it("reports whether the provider offers allow_once", () => {
    expect(
      planApprovalOf(
        approval({
          payload: {
            kind: "approval",
            availableDecisions: ["deny"],
            reason: null,
            subject: { kind: "plan", itemId: "i", plan: "# Plan", planFilePath: "/p.md" },
          },
        }),
      )?.canApprove,
    ).toBe(false);
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

describe("reviewReachedAgent", () => {
  const GATE_TOOLS = ["ExitPlanMode", "EnterPlanMode", "AskUserQuestion"];
  function itemEvent(type: string, item: Record<string, unknown>) {
    return { type, data: { item } } as never;
  }
  const read = (extra: Record<string, unknown> = {}) =>
    itemEvent("item/completed", { type: "toolCall", tool: "Read", ...extra });

  it("is false with no events, or only the gate's own completed tool calls", () => {
    expect(reviewReachedAgent([], GATE_TOOLS, true, false)).toBe(false);
    expect(
      reviewReachedAgent(
        [
          itemEvent("item/completed", { type: "toolCall", tool: "ExitPlanMode" }),
          itemEvent("item/completed", { type: "toolCall", tool: "AskUserQuestion" }),
        ],
        GATE_TOOLS,
        true,
        false,
      ),
    ).toBe(false);
  });

  it("is true once a completed tool call outside the gate tools followed", () => {
    expect(reviewReachedAgent([read()], GATE_TOOLS, true, false)).toBe(true);
  });

  it("is false for a tool call that started but never completed", () => {
    expect(
      reviewReachedAgent([itemEvent("item/started", { type: "toolCall", tool: "Read" })], GATE_TOOLS, true, false),
    ).toBe(false);
  });

  it("ignores completed items that are not tool calls", () => {
    expect(
      reviewReachedAgent([itemEvent("item/completed", { type: "agentMessage" })], GATE_TOOLS, true, false),
    ).toBe(false);
  });

  it("is false once any turn ended since the cursor, whatever completed", () => {
    // The turn boundary comes from its own query, so it holds with or without completed rows.
    expect(reviewReachedAgent([], GATE_TOOLS, true, true)).toBe(false);
    expect(reviewReachedAgent([read()], GATE_TOOLS, true, true)).toBe(false);
    expect(reviewReachedAgent([read()], GATE_TOOLS, false, true)).toBe(false);
  });

  it("counts a subagent's call only when asked to", () => {
    const subagent = read({ parentToolCallId: "toolu-parent" });
    expect(reviewReachedAgent([subagent], GATE_TOOLS, true, false)).toBe(true);
    expect(reviewReachedAgent([subagent], GATE_TOOLS, false, false)).toBe(false);
    expect(reviewReachedAgent([subagent, read()], GATE_TOOLS, false, false)).toBe(true);
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
