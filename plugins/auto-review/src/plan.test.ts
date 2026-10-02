import { describe, expect, it } from "vitest";
import {
  isCommitPlan,
  isImmediateReactionToDeny,
  planApprovalOf,
  planGateAction,
  userQuestionOf,
} from "./plan.js";

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

describe("isCommitPlan", () => {
  it("matches the sentinel on a line of its own, anywhere in the plan", () => {
    expect(isCommitPlan("# Plan\n\n## Commit Plan\n<!-- devkit:commit-plan -->\n- a")).toBe(true);
    expect(isCommitPlan("  <!--devkit:commit-plan-->  \r\nrest")).toBe(true);
    expect(isCommitPlan("<!-- k0d3:commit-plan -->")).toBe(true);
  });

  it("ignores an in-prose mention or a near miss", () => {
    expect(isCommitPlan("see <!-- devkit:commit-plan --> above")).toBe(false);
    expect(isCommitPlan("<!-- devkit:commit-planner -->")).toBe(false);
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

  it("is true with no events, or only reasoning/agent talk and the question's own item", () => {
    expect(isImmediateReactionToDeny([])).toBe(true);
    expect(
      isImmediateReactionToDeny([
        itemStarted({ type: "reasoning" }),
        itemStarted({ type: "agentMessage" }),
        itemStarted({ type: "toolCall", tool: "AskUserQuestion" }),
      ]),
    ).toBe(true);
  });

  it("ignores non-item/started events", () => {
    expect(isImmediateReactionToDeny([{ type: "system/thread/interrupted", data: {} } as never])).toBe(
      true,
    );
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
  it("reviews the first presentation and releases the next", () => {
    expect(planGateAction({ phase: "idle" }, "# Plan")).toBe("review");
    expect(planGateAction({ phase: "idle", planReviewArmedAt: 1 }, "# Plan")).toBe("release");
  });

  it("holds a re-presentation while the review is still queued", () => {
    expect(
      planGateAction({ phase: "idle", planReviewArmedAt: 1, planReviewEntryId: "qm" }, "# Plan"),
    ).toBe("hold");
  });

  it("passes a commit plan without touching the gate", () => {
    expect(planGateAction({ phase: "idle" }, "<!-- devkit:commit-plan -->")).toBe("commit-plan");
  });
});
