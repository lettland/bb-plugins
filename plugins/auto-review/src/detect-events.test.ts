import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { describe, expect, it, vi } from "vitest";
import { AUTO_REVIEW_MARKER, CODE_REVIEW_OPENING } from "./prompt.js";
import {
  CHAT_APPROVAL_THRESHOLD,
  endedTurn,
  EVENT_PAGE_MAX,
  firstUserTurnSince,
  NoTurnCompletedError,
  planLatestDecisionApproves,
  quietSincePark,
  tryCaptureSinceSeq,
  UnreadTurnError,
} from "./detect-events.js";
import { planFormResolutionSince } from "./detect-plan-form.js";
import { PLAN_APPROVAL_TIMEOUT_MS } from "./plan-approval-form.js";

interface Row {
  seq: number;
  type: string;
  scope: { kind: "turn"; turnId: string } | { kind: "thread" };
  data: Record<string, unknown>;
}

/**
 * A fake thread whose event log is `rows`; `pageSizes` records how many events each page request returned.
 * `metadata` is the thread's plugin state (an Error is thrown by the read); `warnings` collects the plugin's warnings.
 */
function logOf(
  rows: readonly Row[],
  metadata: unknown = {},
): { bb: BbPluginApi; pageSizes: number[]; warnings: string[] } {
  const pageSizes: number[] = [];
  const warnings: string[] = [];
  const list = async (args: { afterSeq?: string; types?: string[]; limit?: string }) => {
    const page = rows
      .filter((row) => row.seq > Number(args.afterSeq ?? 0) && args.types?.includes(row.type) === true)
      .slice(0, Number(args.limit));
    pageSizes.push(page.length);
    return page;
  };
  const getPluginMetadata = async () => {
    if (metadata instanceof Error) {
      throw metadata;
    }
    return metadata;
  };
  return {
    bb: {
      log: { warn: (message: string) => warnings.push(message) },
      sdk: { threads: { events: { list }, getPluginMetadata } },
    } as unknown as BbPluginApi,
    pageSizes,
    warnings,
  };
}

const request = (seq: number, requestId: string, initiator: string): Row => ({
  seq,
  type: "client/turn/requested",
  scope: { kind: "thread" },
  data: { requestId, initiator, target: { kind: "new-turn" }, input: [{ type: "text", text: "go" }] },
});
const accepted = (seq: number, turnId: string, clientRequestId: string): Row => ({
  seq,
  type: "turn/input/accepted",
  scope: { kind: "turn", turnId },
  data: { clientRequestId },
});
const completed = (seq: number, turnId: string): Row => ({ seq, type: "turn/completed", scope: { kind: "turn", turnId }, data: {} });

/**
 * A `system/interaction/lifecycle` row for a plan approval resolved inside
 * `turnId`, as core logged it for the incident this fix replays (local bb
 * thread, id redacted: `resolving` at seq 1296, `resolved` at seq 1297). The
 * decision defaults to `allow_once`; `subject` reshapes the approval's subject
 * and `resolution` `null` leaves it unresolved.
 */
const lifecycle = (
  seq: number,
  turnId: string,
  status: string,
  resolution: unknown = { decision: "allow_once" },
  subject: Record<string, unknown> = { kind: "plan", itemId: "i", plan: "# Plan", planFilePath: null },
): Row => ({
  seq,
  type: "system/interaction/lifecycle",
  scope: { kind: "turn", turnId },
  data: {
    interaction: {
      id: "pint-1",
      status,
      statusReason: null,
      payload: { kind: "approval", availableDecisions: ["allow_once", "deny"], reason: null, subject },
      resolution,
    },
  },
});

/**
 * A `system/interaction/lifecycle` row for this plugin's plan-approval form,
 * resolved as approved by default. `scope` is turn-scoped when the host held
 * the tool call and thread-scoped when the call detached (bb core
 * `pending-interaction-timeline.ts`, `interactionScope`); `over` reshapes the interaction.
 */
const form = (seq: number, scope: Row["scope"] = { kind: "turn", turnId: "turn-1" }, over: Record<string, unknown> = {}): Row => ({
  seq,
  type: "system/interaction/lifecycle",
  scope,
  data: {
    interaction: {
      id: "pint-form",
      status: "resolved",
      statusReason: null,
      origin: { kind: "plugin", pluginId: "auto-review", rendererId: "plan-approval" },
      payload: { kind: "plugin", title: "Plan approval", data: { planFilePath: "/w/p.md", reviewed: true } },
      resolution: { kind: "plugin_submitted", description: { title: "Approved", payload: { approved: true } }, answeredVia: "app" },
      ...over,
    },
  },
});

/** A thread whose last turn is the user's (or, with `lastIsUser` false, a wake-up), after `turns - 1` wake-up turns: each turn logs a request, its accepted input and its end. */
function threadWith(turns: number, lastIsUser = true): { bb: BbPluginApi; pageSizes: number[] } {
  const rows: Row[] = [];
  for (let turn = 1; turn <= turns; turn += 1) {
    const requestId = `creq-${turn}`;
    rows.push(
      request(turn * 3, requestId, lastIsUser && turn === turns ? "user" : "system"),
      accepted(turn * 3 + 1, `turn-${turn}`, requestId),
      completed(turn * 3 + 2, `turn-${turn}`),
    );
  }
  return logOf(rows);
}

describe("endedTurn", () => {
  it.each([1, EVENT_PAGE_MAX - 1, EVENT_PAGE_MAX, EVENT_PAGE_MAX + 1, 2 * EVENT_PAGE_MAX + 5])(
    "finds the last turn and its user request among %i turns",
    async (turns) => {
      const { bb } = threadWith(turns);
      expect(await endedTurn(bb, "thr", 0, (turns - 1) * 3 + 2)).toEqual({
        users: true,
        completedSeq: turns * 3 + 2,
        approvedPlans: [],
        reviewTurn: false,
      });
    },
  );

  it("asks for one more page when a page comes back exactly full, and stops at the first short one", async () => {
    const { bb, pageSizes } = threadWith(EVENT_PAGE_MAX);
    await endedTurn(bb, "thr", 0, (EVENT_PAGE_MAX - 1) * 3 + 2);
    // Accepted inputs, requests and lifecycle events are read from the cursor: each full page is followed by an empty one.
    expect(pageSizes.filter((size) => size === EVENT_PAGE_MAX)).toHaveLength(2);
    expect(pageSizes.filter((size) => size === 0)).toHaveLength(3);
  });

  it("is not the user's when the last turn's request was a wake-up", async () => {
    const { bb } = threadWith(3, false);
    expect(await endedTurn(bb, "thr", 0, 8)).toEqual({ users: false, completedSeq: 11, approvedPlans: [], reviewTurn: false });
  });

  it("reads the first turn to complete after the last one handled, not the newest", async () => {
    const { bb } = threadWith(3);
    expect(await endedTurn(bb, "thr", 0, 0)).toEqual({ users: false, completedSeq: 5, approvedPlans: [], reviewTurn: false });
    expect(await endedTurn(bb, "thr", 0, 5)).toEqual({ users: false, completedSeq: 8, approvedPlans: [], reviewTurn: false });
  });

  it("is not the user's when a turn completed but no input was accepted into it since the cursor", async () => {
    const { bb } = logOf([request(3, "creq-1", "user"), accepted(4, "turn-1", "creq-1"), completed(5, "turn-1"), completed(8, "turn-2")]);
    expect(await endedTurn(bb, "thr", 5)).toEqual({ users: false, completedSeq: 8, approvedPlans: [], reviewTurn: false });
  });

  it("throws, carrying the turn's end, when an accepted input has no request row", async () => {
    const { bb } = logOf([accepted(4, "turn-1", "creq-1"), completed(5, "turn-1")]);
    const error = await endedTurn(bb, "thr", 0).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(UnreadTurnError);
    expect(error).toMatchObject({ message: expect.stringContaining("no turn request creq-1"), completedSeq: 5 });
  });

  it("throws, carrying the turn's end, when a lookup fails after the turn was found", async () => {
    const { bb } = logOf([completed(5, "turn-1")]);
    const failing = { sdk: { threads: { events: { list: async (args: { types?: string[] }) => {
      if (args.types?.includes("turn/input/accepted") === true) {
        throw new Error("events unavailable");
      }
      return bb.sdk.threads.events.list(args as never);
    } } } } } as unknown as BbPluginApi;
    expect(await endedTurn(failing, "thr", 0).catch((thrown: unknown) => thrown)).toMatchObject({ completedSeq: 5 });
  });

  it("throws, carrying the turn's end, when a completed turn's event names no turn", async () => {
    const { bb } = logOf([{ seq: 5, type: "turn/completed", scope: { kind: "thread" }, data: {} }]);
    const error = await endedTurn(bb, "thr", 0).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(UnreadTurnError);
    expect(error).toMatchObject({ completedSeq: 5 });
  });

  it("finds no turn when the last one handled is the last to complete, whatever the cursor", async () => {
    const { bb } = threadWith(2);
    await expect(endedTurn(bb, "thr", 0, 8)).rejects.toBeInstanceOf(NoTurnCompletedError);
  });

  it("throws when nothing completed since the cursor", async () => {
    const { bb } = threadWith(2);
    await expect(endedTurn(bb, "thr", 100)).rejects.toThrow("no turn completed");
  });

  it.each(["allow_once", "allow_for_session"] as const)(
    "lists a plan approval the turn resolved %s, at the seq of its resolved event",
    async (decision) => {
      const { bb } = logOf([
        request(3, "creq-1", "user"),
        accepted(4, "turn-1", "creq-1"),
        completed(5, "turn-1"),
        lifecycle(1295, "turn-1", "pending", null),
        lifecycle(1296, "turn-1", "resolving", null),
        lifecycle(1297, "turn-1", "resolved", { decision }),
      ]);
      expect(await endedTurn(bb, "thr", 0)).toEqual({
        users: true,
        completedSeq: 5,
        approvedPlans: [{ id: "pint-1", seq: 1297, requestedSeq: 1295 }],
        reviewTurn: false,
      });
    },
  );

  it("lists a plan approval even when no input was accepted into the turn since the cursor", async () => {
    // The pending request sat in another turn's scope: it is matched by
    // interaction id, not by the ended turn.
    const { bb } = logOf([completed(8, "turn-2"), lifecycle(1296, "turn-1", "pending", null), lifecycle(1297, "turn-2", "resolved")]);
    expect(await endedTurn(bb, "thr", 5)).toEqual({
      users: false,
      completedSeq: 8,
      approvedPlans: [{ id: "pint-1", seq: 1297, requestedSeq: 1296 }],
      reviewTurn: false,
    });
  });

  it("leaves an approval's request seq undefined when no pending event is in the window", async () => {
    const { bb } = logOf([completed(8, "turn-2"), lifecycle(1297, "turn-2", "resolved")]);
    expect(await endedTurn(bb, "thr", 5)).toEqual({
      users: false,
      completedSeq: 8,
      approvedPlans: [{ id: "pint-1", seq: 1297, requestedSeq: undefined }],
      reviewTurn: false,
    });
  });

  it("keeps the earliest pending seq when an interaction id is pending twice", async () => {
    // The caller judges the request against the review's delivery cursor and
    // fails open: a re-emitted `pending` after it must not read as the request.
    const { bb } = logOf([
      request(3, "creq-1", "user"),
      accepted(4, "turn-1", "creq-1"),
      completed(5, "turn-1"),
      // Out of seq order, so keeping the first one seen instead of the minimum would fail here.
      lifecycle(1300, "turn-1", "pending", null),
      lifecycle(1295, "turn-1", "pending", null),
      lifecycle(1301, "turn-1", "resolved"),
    ]);
    expect(await endedTurn(bb, "thr", 0)).toEqual({
      users: true,
      completedSeq: 5,
      approvedPlans: [{ id: "pint-1", seq: 1301, requestedSeq: 1295 }],
      reviewTurn: false,
    });
  });

  it("lists neither a denied, a non-plan, nor another turn's approval", async () => {
    const { bb } = logOf([
      request(3, "creq-1", "user"),
      accepted(4, "turn-1", "creq-1"),
      completed(5, "turn-1"),
      lifecycle(6, "turn-1", "resolved", { decision: "deny" }),
      lifecycle(7, "turn-1", "resolved", { decision: "allow_once" }, { kind: "command", itemId: "i" }),
      lifecycle(8, "turn-1", "resolving", null),
      lifecycle(9, "turn-2", "resolved"),
    ]);
    expect(await endedTurn(bb, "thr", 0)).toEqual({ users: true, completedSeq: 5, approvedPlans: [], reviewTurn: false });
  });

  it("throws, carrying the turn's end, when the lifecycle events cannot be read", async () => {
    const { bb } = logOf([completed(5, "turn-1")]);
    const failing = { sdk: { threads: { events: { list: async (args: { types?: string[] }) => {
      if (args.types?.includes("system/interaction/lifecycle") === true) {
        throw new Error("events unavailable");
      }
      return bb.sdk.threads.events.list(args as never);
    } } } } } as unknown as BbPluginApi;
    const error = await endedTurn(failing, "thr", 0).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(UnreadTurnError);
    expect(error).toMatchObject({ completedSeq: 5 });
  });

  it("is the review's own turn when its request carried the code-review prompt's opening", async () => {
    const { bb } = logOf([
      { ...request(3, "creq-1", "user"), data: { ...request(3, "creq-1", "user").data, input: [{ type: "text", text: `${CODE_REVIEW_OPENING} Review them, apply fixes, and record the result.` }] } },
      accepted(4, "turn-1", "creq-1"),
      completed(5, "turn-1"),
    ]);
    expect(await endedTurn(bb, "thr", 0)).toEqual({ users: false, completedSeq: 5, approvedPlans: [], reviewTurn: true });
  });

  it("is the review's own turn when the review prompt was steered into it", async () => {
    // From a real thread: the review's request expects the running turn, and the provider accepts it into that turn.
    const reviewRequest = { ...request(3, "creq-1", "user") };
    (reviewRequest.data as Record<string, unknown>).target = { kind: "auto", expectedTurnId: "turn-1" };
    (reviewRequest.data as Record<string, unknown>).input = [{ type: "text", text: `${CODE_REVIEW_OPENING} Review them.` }];
    const { bb } = logOf([reviewRequest, accepted(4, "turn-1", "creq-1"), completed(5, "turn-1")]);
    expect(await endedTurn(bb, "thr", 0)).toEqual({ users: false, completedSeq: 5, approvedPlans: [], reviewTurn: true });
  });

  it("is not the review's own turn when the request carried a plan-review prompt", async () => {
    const { bb } = logOf([
      { ...request(3, "creq-1", "user"), data: { ...request(3, "creq-1", "user").data, input: [{ type: "text", text: `${AUTO_REVIEW_MARKER} Your plan was held back for review before it reaches the user.` }] } },
      accepted(4, "turn-1", "creq-1"),
      completed(5, "turn-1"),
    ]);
    expect(await endedTurn(bb, "thr", 0)).toEqual({ users: false, completedSeq: 5, approvedPlans: [], reviewTurn: false });
  });
});

describe("planLatestDecisionApproves", () => {
  it("finds a plan approved, across turns", async () => {
    const { bb } = logOf([
      request(3, "creq-1", "user"),
      accepted(4, "turn-1", "creq-1"),
      completed(5, "turn-1"),
      lifecycle(20, "turn-1", "pending", null),
      lifecycle(21, "turn-2", "resolved"),
    ]);
    expect(await planLatestDecisionApproves(bb, "thr")).toBe(true);
  });

  // thr_ztxgu84xib (11-09): a follow-up request moved the old window past the plan's approval, so the
  // missing-plan Blocker fired on every follow-up under an approved plan. An earlier approval still counts.
  it("still counts an approval from an earlier turn, however many requests came after it", async () => {
    const { bb } = logOf([lifecycle(8, "turn-1", "resolved"), request(30, "creq-9", "user"), request(40, "creq-10", "user")]);
    expect(await planLatestDecisionApproves(bb, "thr")).toBe(true);
  });

  it("counts neither a deny nor a non-plan approval", async () => {
    const { bb } = logOf([
      lifecycle(6, "turn-1", "resolved", { decision: "deny" }),
      lifecycle(7, "turn-1", "resolved", { decision: "allow_once" }, { kind: "command", itemId: "i" }),
    ]);
    expect(await planLatestDecisionApproves(bb, "thr")).toBe(false);
  });

  it("finds nothing on a thread with no lifecycle events", async () => {
    expect(await planLatestDecisionApproves(logOf([]).bb, "thr")).toBe(false);
  });
});

describe("a held plan approval form", () => {
  const held = { kind: "turn", turnId: "turn-1" } as const;
  const detached = { kind: "thread" } as const;

  it("counts as a plan approval in the walk, with the form's interaction id", async () => {
    const { bb } = logOf([form(12, held)]);
    expect(await planLatestDecisionApproves(bb, "thr")).toBe(true);
  });

  it.each([
    ["detached (thread-scoped)", form(12, detached)],
    ["answered approved: false", form(12, held, { resolution: { kind: "plugin_submitted", description: { title: "Changes requested", payload: { approved: false } } } })],
    ["described without a payload", form(12, held, { resolution: { kind: "plugin_submitted", description: { title: "Approved" } } })],
    ["described with no description at all", form(12, held, { resolution: { kind: "plugin_submitted" } })],
    ["described approved with a non-boolean", form(12, held, { resolution: { kind: "plugin_submitted", description: { payload: { approved: "yes" } } } })],
    ["from another plugin", form(12, held, { origin: { kind: "plugin", pluginId: "other", rendererId: "plan-approval" } })],
    ["of another renderer", form(12, held, { origin: { kind: "plugin", pluginId: "auto-review", rendererId: "other" } })],
    ["of provider origin", form(12, held, { origin: { kind: "provider", providerId: "p", providerRequestId: "r" } })],
    ["still pending", form(12, held, { status: "pending", resolution: null })],
    ["still resolving", form(12, held, { status: "resolving", resolution: null })],
    ["cancelled (interrupted)", form(12, held, { status: "interrupted", resolution: null })],
    ["resolved by a native decision", form(12, held, { resolution: { decision: "allow_once" } })],
    ["resolved with another kind", form(12, held, { resolution: { kind: "user_answer" } })],
  ])("does not count when %s", async (_name, row) => {
    const { bb } = logOf([row]);
    expect(await planLatestDecisionApproves(bb, "thr")).toBe(false);
  });

  const answered = (answer: Record<string, unknown>) =>
    form(12, held, { resolution: { kind: "plugin_submitted", description: { title: "Approved", payload: { approved: true } }, ...answer } });

  it.each([
    ["missing", {}],
    ["api", { answeredVia: "api" }],
    ["unexpected (desktop)", { answeredVia: "desktop" }],
  ])("does not count an approval whose answeredVia is %s, in the walk or in a turn's approved plans", async (_name, answer) => {
    expect(await planLatestDecisionApproves(logOf([answered(answer)]).bb, "thr")).toBe(false);
    expect((await endedTurn(logOf([completed(15, "turn-1"), answered(answer)]).bb, "thr", 0)).approvedPlans).toEqual([]);
  });

  it("counts an approval whose answeredVia is app, in the walk and in a turn's approved plans", async () => {
    const app = answered({ answeredVia: "app" });
    expect(await planLatestDecisionApproves(logOf([app]).bb, "thr")).toBe(true);
    expect((await endedTurn(logOf([completed(15, "turn-1"), app]).bb, "thr", 0)).approvedPlans).toEqual([
      { id: "pint-form", seq: 12, requestedSeq: undefined },
    ]);
  });

  it("is listed among a turn's approved plans, so the continuation counts it as the user's", async () => {
    const { bb } = logOf([completed(5, "turn-1"), form(4, held)]);
    expect(await endedTurn(bb, "thr", 0)).toEqual({
      users: false,
      completedSeq: 5,
      approvedPlans: [{ id: "pint-form", seq: 4, requestedSeq: undefined }],
      reviewTurn: false,
    });
  });

  it("is not listed for a turn when the form detached (thread-scoped)", async () => {
    const { bb } = logOf([completed(5, "turn-1"), form(4, detached)]);
    expect((await endedTurn(bb, "thr", 0)).approvedPlans).toEqual([]);
  });
});

describe("planFormResolutionSince", () => {
  const held = { kind: "turn", turnId: "turn-1" } as const;

  it("is null when no form resolved after the cursor", async () => {
    expect(await planFormResolutionSince(logOf([form(4, held)]).bb, "thr", 4)).toBeNull();
    expect(await planFormResolutionSince(logOf([]).bb, "thr", 0)).toBeNull();
  });

  it("reads whether the latest resolution was held, described as approved and answered in the app", async () => {
    const changes = form(9, { kind: "thread" }, { resolution: { kind: "plugin_submitted", description: { payload: { approved: false } } } });
    expect(await planFormResolutionSince(logOf([form(5, held)]).bb, "thr", 0)).toEqual({ held: true, approved: true, app: true });
    expect(await planFormResolutionSince(logOf([form(5, held), changes]).bb, "thr", 0)).toEqual({ held: false, approved: false, app: false });
  });

  it.each([
    ["missing", undefined],
    ["api", "api"],
    ["unexpected (desktop)", "desktop"],
  ])("reads an answeredVia that is %s as not an app answer", async (_name, answeredVia) => {
    const row = form(5, held, {
      resolution: { kind: "plugin_submitted", description: { payload: { approved: true } }, ...(answeredVia === undefined ? {} : { answeredVia }) },
    });
    expect(await planFormResolutionSince(logOf([row]).bb, "thr", 0)).toEqual({ held: true, approved: true, app: false });
  });

  it("ignores native approvals and forms that are still open", async () => {
    const rows = [lifecycle(5, "turn-1", "resolved"), form(6, held, { status: "pending", resolution: null })];
    expect(await planFormResolutionSince(logOf(rows).bb, "thr", 0)).toBeNull();
  });
});

describe("planLatestDecisionApproves's auto-approve fallback", () => {
  it("credits a recorded auto-approval", async () => {
    const { bb } = logOf([], { presentPlanAutoApprovedSeq: 11 });
    expect(await planLatestDecisionApproves(bb, "thr")).toBe(true);
  });

  it("credits an auto-approval at any seq: there is no window start", async () => {
    expect(await planLatestDecisionApproves(logOf([], { presentPlanAutoApprovedSeq: 0 }).bb, "thr")).toBe(true);
  });

  it("credits nothing when no auto-approval was recorded", async () => {
    expect(await planLatestDecisionApproves(logOf([], {}).bb, "thr")).toBe(false);
  });

  it("reads unparseable state as idle: nothing is credited, and it warns", async () => {
    const { bb, warnings } = logOf([], { phase: "bogus", presentPlanAutoApprovedSeq: 99 });
    expect(await planLatestDecisionApproves(bb, "thr")).toBe(false);
    expect(warnings[0]).toContain("unparseable thread state");
  });

  it("throws when the state read fails, so the gate fails closed", async () => {
    await expect(planLatestDecisionApproves(logOf([], new Error("state down")).bb, "thr")).rejects.toThrow("state down");
  });

  it("never reads the state when the walk's latest decision is an approval", async () => {
    const { bb } = logOf([lifecycle(21, "turn-1", "resolved")], new Error("state down"));
    expect(await planLatestDecisionApproves(bb, "thr")).toBe(true);
  });

  it("reads the state, and fails the read when it fails, when the walk's latest decision is not an approval", async () => {
    const { bb } = logOf([lifecycle(5, "turn-1", "resolved"), lifecycle(9, "turn-1", "resolved", { decision: "deny" })], new Error("state down"));
    await expect(planLatestDecisionApproves(bb, "thr")).rejects.toThrow("state down");
  });
});

// The thread's latest plan decision decides, not the newest approval after a window. thr_ztxgu84xib (11-09):
// the false missing-plan Blocker on follow-ups; thr_27zu8ukmfg (11-07): no approval at all, which must still fire it.
describe("planLatestDecisionApproves's latest decision", () => {
  const held = { kind: "turn", turnId: "turn-1" } as const;
  const approval = (seq: number) => lifecycle(seq, "turn-1", "resolved");
  const denial = (seq: number) => lifecycle(seq, "turn-1", "resolved", { decision: "deny" });
  const changesRequested = (seq: number, scope: Row["scope"] = held) =>
    form(seq, scope, { resolution: { kind: "plugin_submitted", description: { title: "Changes requested", payload: { approved: false } }, answeredVia: "app" } });
  const approves = async (rows: Row[], metadata: unknown = {}) => planLatestDecisionApproves(logOf(rows, metadata).bb, "thr");

  it.each([
    ["a native allow_once", approval(5), true],
    ["a native allow_for_session", lifecycle(5, "turn-1", "resolved", { decision: "allow_for_session" }), true],
    ["a credited form approval", form(5), true],
    ["a native deny", denial(5), false],
    ["a held changes-requested form", changesRequested(5), false],
    ["a thread-scoped changes-requested form", changesRequested(5, { kind: "thread" }), false],
    ["an uncredited form approval (detached)", form(5, { kind: "thread" }), false],
    ["an uncredited form approval (answered via api)", form(5, held, { resolution: { kind: "plugin_submitted", description: { payload: { approved: true } }, answeredVia: "api" } }), false],
    ["a resolving row", lifecycle(5, "turn-1", "resolving", null), false],
    ["a resolving row already carrying a deny", lifecycle(5, "turn-1", "resolving", { decision: "deny" }), false],
    ["a non-plan approval", lifecycle(5, "turn-1", "resolved", { decision: "allow_once" }, { kind: "command", itemId: "i" }), false],
    ["a non-plan deny", lifecycle(5, "turn-1", "resolved", { decision: "deny" }, { kind: "command", itemId: "i" }), false],
  ])("counts %s alone", async (_name, row, expected) => {
    expect(await approves([row])).toBe(expected);
  });

  it.each([
    ["a native deny", denial(9)],
    ["a held changes-requested form", changesRequested(9)],
    ["a thread-scoped changes-requested form", changesRequested(9, { kind: "thread" })],
  ])("%s after an approval cancels it", async (_name, later) => {
    expect(await approves([approval(5), later])).toBe(false);
  });

  it.each([
    ["an uncredited form approval", form(9, { kind: "thread" })],
    ["a resolving row", lifecycle(9, "turn-1", "resolving", { decision: "deny" })],
    ["a non-plan deny", lifecycle(9, "turn-1", "resolved", { decision: "deny" }, { kind: "command", itemId: "i" })],
  ])("%s after an approval leaves it standing", async (_name, later) => {
    expect(await approves([approval(5), later])).toBe(true);
  });

  it("a later approval clears an earlier denial, and an earlier denial does not cancel a later approval", async () => {
    expect(await approves([approval(3), denial(5), approval(9)])).toBe(true);
    expect(await approves([denial(5), approval(9)])).toBe(true);
  });

  it("the auto-approval cursor counts as an approval at its seq, against the denials around it", async () => {
    expect(await approves([denial(5)], { presentPlanAutoApprovedSeq: 9 })).toBe(true);
    expect(await approves([denial(12)], { presentPlanAutoApprovedSeq: 9 })).toBe(false);
  });

  it("a denial at the same seq as the auto-approval wins", async () => {
    expect(await approves([denial(9)], { presentPlanAutoApprovedSeq: 9 })).toBe(false);
  });

  it("a denial and an approval at the same seq: the denial wins", async () => {
    expect(await approves([approval(9), denial(9)])).toBe(false);
  });

  it("is not approved on a thread with no plan decision at all (thr_27zu8ukmfg)", async () => {
    expect(await approves([])).toBe(false);
  });

  it("fails the read when the page cap is hit, so the caller fails closed", async () => {
    const rows = Array.from({ length: 50 * EVENT_PAGE_MAX + 1 }, (_value, i) => lifecycle(i + 1, "turn-1", "resolving", null));
    await expect(approves(rows)).rejects.toThrow("more than");
  });
});

// Regression ledger: bb core facts learned in thread thr_w92i8w56wb. These run
// against plugin fixtures and guard the plugin's handling of them, not core
// drift; the live check is the end-to-end run in that thread's plan.
describe("regression ledger (thr_w92i8w56wb)", () => {
  it("plugins cannot create plan-approval interactions, so the plugin opens its own form", () => {
    // bb core `apps/server/src/routes/threads/interactions.ts` offers answer/cancel only,
    // and the SDK's `threads.interactions` area has no `create`. A type-level guard: if
    // the SDK ever adds `create`, this stops compiling and the plan can use a native approval.
    const probe = (bb: BbPluginApi) => {
      // @ts-expect-error `create` is not on the SDK's interactions area
      return bb.sdk.threads.interactions.create;
    };
    expect(typeof probe).toBe("function");
  });

  it("only an answer the app gave is credited: answeredVia is read off the plugin_submitted resolution, which the pinned SDK types lack", async () => {
    // bb core `packages/domain/src/pending-interactions.ts` (the `plugin_submitted` resolution) and
    // `apps/server/src/routes/threads/interactions.ts` (`answeredVia`: "app" for desktop, web and mobile,
    // "api" for anything else, a missing header included). The pinned SDK 0.6.79 has no such field, so
    // the plugin reads it by narrowing; the fixtures below carry what a fork build writes.
    const resolution = (answeredVia?: string) => ({
      kind: "plugin_submitted",
      description: { title: "Approved", payload: { approved: true } },
      ...(answeredVia === undefined ? {} : { answeredVia }),
    });
    const credited = async (answeredVia?: string) =>
      (await planLatestDecisionApproves(logOf([form(12, { kind: "turn", turnId: "turn-1" }, { resolution: resolution(answeredVia) })]).bb, "thr")) ;
    expect(await credited("app")).toBe(true);
    expect(await credited()).toBe(false);
    expect(await credited("api")).toBe(false);
    expect(await credited("desktop")).toBe(false);
  });

  it("a held form's lifecycle event is turn-scoped and a detached one thread-scoped; only the first is credited", async () => {
    // bb core `apps/server/src/services/interactions/pending-interaction-timeline.ts`
    // `interactionScope`: `turnId === null ? threadScope() : turnScope(turnId)`.
    expect(await planLatestDecisionApproves(logOf([form(12, { kind: "turn", turnId: "turn-1" })]).bb, "thr")).toBe(true);
    expect(await planLatestDecisionApproves(logOf([form(12, { kind: "thread" })]).bb, "thr")).toBe(false);
  });

  it("the detached delivery text carries no `[bb ` prefix, so it cannot be told from the user's own words", async () => {
    // bb core `apps/server/src/services/plugins/detached-tool-result-delivery.ts`:
    // "Your earlier <tool> tool call has finished. Its result: …". With no prefix, a
    // request carrying it counts as the user's turn, which is why a detached
    // form is never credited and only a turn-scoped one is.
    const delivery = "Your earlier PresentPlan tool call has finished. Its result: approved";
    expect(delivery.startsWith("[bb ")).toBe(false);
    expect(delivery.startsWith(AUTO_REVIEW_MARKER)).toBe(false);
    const { bb } = logOf([
      { seq: 3, type: "client/turn/requested", scope: { kind: "thread" }, data: { requestId: "creq-1", initiator: "user", target: { kind: "new-turn" }, input: [{ type: "text", text: delivery }] } },
    ]);
    expect(await firstUserTurnSince(bb, "thr", 0)).toBe(3);
  });

  it("the fork daemon aborts forwarded tool calls after 65 minutes, so the form waits 60", () => {
    // bb core `apps/host-daemon/src/server-client.fork.ts` `TOOL_CALL_TIMEOUT_MS = 65 * 60 * 1000`:
    // past it the held request aborts and the plugin's own cancel text cannot reach the agent.
    expect(PLAN_APPROVAL_TIMEOUT_MS).toBe(60 * 60 * 1000);
    expect(PLAN_APPROVAL_TIMEOUT_MS).toBeLessThan(65 * 60 * 1000);
  });
});

describe("quietSincePark", () => {
  const started = (seq: number, turnId: string): Row => ({ seq, type: "turn/started", scope: { kind: "turn", turnId }, data: {} });

  it("is quiet when the thread has no events", async () => {
    expect(await quietSincePark(logOf([]).bb, "thr", 5)).toBe(true);
  });

  it("is quiet when the parked turn's own request, start and end are at or before the cursor", async () => {
    const { bb } = logOf([request(3, "creq-1", "user"), started(4, "turn-1"), completed(5, "turn-1")]);
    expect(await quietSincePark(bb, "thr", 5)).toBe(true);
  });

  it.each([
    ["a wake-up request", [request(6, "creq-2", "system")]],
    [
      "a request auto-review sent itself",
      [{ ...request(6, "creq-2", "user"), data: { ...request(6, "creq-2", "user").data, input: [{ type: "text", text: `${AUTO_REVIEW_MARKER} review` }] } }],
    ],
    ["a turn start whose request landed before the cursor", [request(4, "creq-2", "system"), started(6, "turn-2")]],
    ["a turn end whose request landed before the cursor", [request(4, "creq-2", "system"), completed(6, "turn-2")]],
  ])("is not quiet after %s", async (_name, rows) => {
    expect(await quietSincePark(logOf(rows).bb, "thr", 5)).toBe(false);
  });

  it("is not quiet when the log cannot be read", async () => {
    const bb = {
      sdk: {
        threads: {
          events: {
            list: async () => {
              throw new Error("events unavailable");
            },
          },
        },
      },
    } as unknown as BbPluginApi;
    expect(await quietSincePark(bb, "thr", 5)).toBe(false);
  });
});

describe("detect-events coverage of failure shapes", () => {
  it("reports a cursor it cannot read, whatever the error", async () => {
    const warnings: string[] = [];
    const bb = {
      sdk: { threads: { timeline: async () => { throw "kaboom"; } } },
      log: { warn: (message: string) => warnings.push(message) },
    } as unknown as BbPluginApi;
    expect(await tryCaptureSinceSeq(bb, "thr", "the test cursor")).toBeUndefined();
    expect(warnings[0]).toContain("kaboom");
  });

  it("ignores rows of another type that a page returns unasked", async () => {
    const bb = {
      sdk: {
        threads: {
          events: {
            list: async () => [
              { seq: 2, type: "turn/started", scope: { kind: "turn", turnId: "turn-0" }, data: {} },
              request(3, "creq-1", "user"),
            ],
          },
        },
      },
    } as unknown as BbPluginApi;
    expect(await firstUserTurnSince(bb, "thr", 0)).toBe(3);
  });

  it("keeps the earliest pending seq of an interaction whatever order the lifecycle rows came in", async () => {
    const { bb } = logOf([
      request(3, "creq-1", "user"),
      accepted(4, "turn-1", "creq-1"),
      completed(5, "turn-1"),
      lifecycle(20, "turn-1", "pending"),
      lifecycle(25, "turn-1", "pending"),
      lifecycle(40, "turn-1", "resolved"),
    ]);
    expect(await endedTurn(bb, "thr", 0)).toEqual({
      users: true,
      completedSeq: 5,
      approvedPlans: [{ id: "pint-1", seq: 40, requestedSeq: 20 }],
      reviewTurn: false,
    });
  });

  it("an unreadable turn names the turn's end and the raw failure, whatever the error", async () => {
    const bb = {
      sdk: {
        threads: {
          events: {
            list: async (args: { types?: string[] }) => {
              if (args.types?.[0] !== "turn/completed") {
                throw "kaboom";
              }
              return [completed(5, "turn-1")];
            },
          },
        },
      },
    } as unknown as BbPluginApi;
    const failure = await endedTurn(bb, "thr", 0).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(UnreadTurnError);
    expect((failure as UnreadTurnError).completedSeq).toBe(5);
    expect((failure as Error).message).toBe("kaboom");
  });
});

/**
 * A chat-released plan, replayed from the shape of thr_w7c3pt43uv (2026-11-09):
 * `PresentPlan` released the plan to a chat approval mid-turn (cursor 15), the
 * turn ended at seq 20, and the user typed "approvee" as request 30, accepted
 * into turn-2. The advisor's own queue message (`originPluginId: "advisor"`,
 * `initiator: "user"`) had the same shape as a typed one.
 */
describe("planLatestDecisionApproves's typed approval in chat", () => {
  const RELEASED = 15;
  const projectId = "proj-1";

  /** A typed request; `over` reshapes its data, `text` its only input part. */
  const reply = (seq: number, id: string, text: string, over: Record<string, unknown> = {}): Row => ({
    seq,
    type: "client/turn/requested",
    scope: { kind: "thread" },
    data: { requestId: id, initiator: "user", target: { kind: "new-turn" }, input: [{ type: "text", text }], originPluginId: null, senderThreadId: null, ...over },
  });
  const withoutFields = (row: Row): Row => {
    const { originPluginId: _origin, senderThreadId: _sender, ...data } = row.data;
    return { ...row, data };
  };
  const fileChange = (seq: number) => ({ kind: "work", workKind: "file-change", sourceSeqStart: seq, change: { path: "a.ts", movePath: null } });
  const command = (seq: number, text: string) => ({ kind: "work", workKind: "command", sourceSeqStart: seq, command: text });
  const typed = (seq = 30, id = "creq-2", text = "approvee") => [reply(seq, id, text), accepted(seq + 1, "turn-2", id)];
  /** The release turn's end, then the typed reply `approvee` and its turn. */
  const BASE: Row[] = [request(10, "creq-1", "user"), accepted(11, "turn-1", "creq-1"), completed(20, "turn-1"), ...typed(), completed(35, "turn-2")];

  interface Options {
    metadata?: Record<string, unknown>;
    approves?: Array<number | null | Error | { throws: unknown }>;
    timeline?: unknown[] | Error | { throws: unknown } | "truncated";
  }

  function chat(rows: readonly Row[], options: Options = {}) {
    const metadata: Record<string, unknown> = { presentPlanChatReleasedSeq: RELEASED, ...options.metadata };
    const answers = [...(options.approves ?? [0.9])];
    const callRpc = vi.fn(async (_args: unknown) => {
      const answer = answers.length > 1 ? answers.shift()! : answers[0]!;
      if (answer instanceof Error) {
        throw answer;
      }
      if (answer !== null && typeof answer === "object") {
        throw answer.throws;
      }
      return { approves: answer };
    });
    const infos: string[] = [];
    const base = logOf(rows, metadata);
    const { timeline = [] } = options;
    const bb = {
      log: { warn: (message: string) => base.warnings.push(message), info: (message: string) => infos.push(message) },
      sdk: {
        threads: {
          ...(base.bb.sdk.threads as object),
          updatePluginMetadata: async (args: { set?: Record<string, unknown> }) => Object.assign(metadata, args.set ?? {}),
          get: async () => ({ projectId }),
          timeline: async () => {
            if (timeline instanceof Error) {
              throw timeline;
            }
            if (typeof timeline === "object" && "throws" in timeline) {
              throw timeline.throws;
            }
            return {
              rows: timeline === "truncated" ? [] : timeline,
              maxSeq: 99,
              timelinePage: timeline === "truncated" ? { olderCursor: { anchorId: "a", anchorSeq: 1 }, olderRowsSourceSeqEnd: 999 } : { olderCursor: null },
            };
          },
        },
        plugins: { callRpc },
      },
    } as unknown as BbPluginApi;
    return { bb, metadata, callRpc, infos, warnings: base.warnings, approves: () => planLatestDecisionApproves(bb, "thr") };
  }

  const calledWith = (text: string) => ({ pluginId: "typesafe", method: "planApproval", input: { projectId, text } });
  const noCreditLine = "your reply after the plan was not judged as approval (or TypeSafe was unavailable); ask the agent to present the plan again";

  describe("credits", () => {
    it("a typed reply TypeSafe approves, and sends exactly that reply with the project id", async () => {
      const { approves, callRpc, infos } = chat(BASE);
      expect(await approves()).toBe(true);
      expect(callRpc).toHaveBeenCalledTimes(1);
      expect(callRpc).toHaveBeenCalledWith(expect.objectContaining(calledWith("approvee")));
      expect(infos.join("\n")).toContain("the reply at seq 30 in thr was judged as approval of the plan (approves 0.9)");
    });

    it("exactly at the threshold, and not below it", async () => {
      expect(CHAT_APPROVAL_THRESHOLD).toBe(0.6);
      expect(await chat(BASE, { approves: [0.6] }).approves()).toBe(true);
      expect(await chat(BASE, { approves: [0.59] }).approves()).toBe(false);
    });

    it("the second reply, when the first was a question that is not approval", async () => {
      const { approves, callRpc, metadata } = chat(
        [request(10, "creq-1", "user"), accepted(11, "turn-1", "creq-1"), completed(20, "turn-1"), ...typed(30, "creq-2", "why step 3?"), completed(35, "turn-2"), ...typed(40, "creq-3", "ok, go"), completed(45, "turn-3")],
        { approves: [0.1, 0.95] },
      );
      expect(await approves()).toBe(true);
      expect(callRpc.mock.calls.map(([args]) => (args as { input: { text: string } }).input.text)).toEqual(["why step 3?", "ok, go"]);
      expect(metadata.presentPlanChatVerdicts).toEqual({ "30": 0.1, "40": 0.95 });
    });

    it("stops judging at the first credited reply, oldest first", async () => {
      const { approves, callRpc } = chat(
        [...BASE, ...typed(40, "creq-3", "yes please"), completed(45, "turn-3")],
        { approves: [0.8, 0.9] },
      );
      expect(await approves()).toBe(true);
      expect(callRpc).toHaveBeenCalledTimes(1);
    });

    it("a reply whose origin and sender fields are missing, as well as null", async () => {
      const rows = BASE.map((row) => (row.seq === 30 ? withoutFields(row) : row));
      expect(await chat(rows).approves()).toBe(true);
      expect(await chat(BASE).approves()).toBe(true);
    });

    it("the text of a reply that also carries an attachment, and nothing but the text", async () => {
      const rows = BASE.map((row) =>
        row.seq === 30 ? { ...row, data: { ...row.data, input: [{ type: "localImage", path: "/tmp/a.png" }, { type: "text", text: "approvee" }] } } : row,
      );
      const { approves, callRpc } = chat(rows);
      expect(await approves()).toBe(true);
      expect(callRpc).toHaveBeenCalledWith(expect.objectContaining(calledWith("approvee")));
    });

    it("an `auto` request whose expected turn had ended, which landed in a turn of its own", async () => {
      const rows = BASE.map((row) => (row.seq === 30 ? { ...row, data: { ...row.data, target: { kind: "auto", expectedTurnId: "turn-1" } } } : row));
      expect(await chat(rows).approves()).toBe(true);
    });

    it("work that came after the reply, however much", async () => {
      expect(await chat(BASE, { timeline: [fileChange(40), command(41, "sed -i s/a/b/ a.ts")] }).approves()).toBe(true);
    });

    it("work from before the release, and reads and checks after it", async () => {
      const timeline = [fileChange(5), command(25, "git status"), command(26, "cat a.ts"), command(27, "echo hi > /tmp/note")];
      expect(await chat(BASE, { timeline }).approves()).toBe(true);
    });

    it("a denial before the approval", async () => {
      expect(await chat([lifecycle(5, "turn-0", "resolved", { decision: "deny" }), ...BASE]).approves()).toBe(true);
    });
  });

  describe("does not credit", () => {
    it("a reply TypeSafe judges not approval, and says why in the log", async () => {
      const { approves, infos } = chat(BASE, { approves: [0.3] });
      expect(await approves()).toBe(false);
      expect(infos.join("\n")).toContain(noCreditLine);
      expect(infos.join("\n")).toContain("no reply judged as approval; approves [0.3]");
    });

    it("an answer of null, which is not cached", async () => {
      const { approves, infos, metadata } = chat(BASE, { approves: [null] });
      expect(await approves()).toBe(false);
      expect(metadata.presentPlanChatVerdicts).toBeUndefined();
      expect(infos.join("\n")).toContain("approves [null]");
    });

    it("a call that throws, which is not cached and stops the walk", async () => {
      const { approves, infos, metadata, callRpc } = chat(
        [...BASE, ...typed(40, "creq-3", "ok, go"), completed(45, "turn-3")],
        { approves: [new Error("no such plugin")] },
      );
      expect(await approves()).toBe(false);
      expect(callRpc).toHaveBeenCalledTimes(1);
      expect(metadata.presentPlanChatVerdicts).toBeUndefined();
      expect(infos.join("\n")).toContain("the typesafe planApproval call failed: no such plugin");
    });

    it("a call that throws a non-Error", async () => {
      const { approves, infos } = chat(BASE, { approves: [{ throws: "down" }] });
      expect(await approves()).toBe(false);
      expect(infos.join("\n")).toContain("the typesafe planApproval call failed: down");
    });

    it.each([
      ["an advisor-origin request", { originPluginId: "advisor" }, "approvee"],
      ["a child thread's request", { senderThreadId: "thr_child" }, "approvee"],
      ["an auto-review request, by its marker", {}, `${AUTO_REVIEW_MARKER} approvee`],
      ["a wake-up (not the user's initiator)", { initiator: "system" }, "approvee"],
    ])("%s", async (_name, over, text) => {
      const rows = [request(10, "creq-1", "user"), accepted(11, "turn-1", "creq-1"), completed(20, "turn-1"), reply(30, "creq-2", text, over), accepted(31, "turn-2", "creq-2")];
      const { approves, callRpc, infos } = chat(rows);
      expect(await approves()).toBe(false);
      expect(callRpc).not.toHaveBeenCalled();
      expect(infos.join("\n")).toContain("no typed reply to judge");
    });

    it("a steer into the running turn, and an `auto` request that landed as one", async () => {
      const rows = [
        request(10, "creq-1", "user"),
        accepted(11, "turn-1", "creq-1"),
        completed(20, "turn-1"),
        ...typed(30, "creq-2", "why step 3?"),
        reply(32, "creq-3", "ok, go", { target: { kind: "steer", expectedTurnId: "turn-2" } }),
        accepted(33, "turn-2", "creq-3"),
        reply(34, "creq-4", "yes", { target: { kind: "auto", expectedTurnId: "turn-2" } }),
        accepted(35, "turn-2", "creq-4"),
        completed(36, "turn-2"),
      ];
      const { approves, callRpc } = chat(rows, { approves: [0.1] });
      expect(await approves()).toBe(false);
      expect(callRpc).toHaveBeenCalledTimes(1);
    });

    it("a reply from before the release, and one queued during the release turn", async () => {
      const rows = [
        reply(5, "creq-0", "approvee"),
        accepted(6, "turn-0", "creq-0"),
        request(10, "creq-1", "user"),
        accepted(11, "turn-1", "creq-1"),
        reply(17, "creq-q", "approvee"),
        completed(20, "turn-1"),
        accepted(21, "turn-2", "creq-q"),
        completed(25, "turn-2"),
      ];
      const { approves, callRpc } = chat(rows);
      expect(await approves()).toBe(false);
      expect(callRpc).not.toHaveBeenCalled();
    });

    it("a reply never accepted into a turn, and a reply with no text", async () => {
      const rows = [request(10, "creq-1", "user"), accepted(11, "turn-1", "creq-1"), completed(20, "turn-1"), reply(30, "creq-2", "approvee"), reply(32, "creq-3", "  "), accepted(33, "turn-3", "creq-3")];
      const { approves, callRpc } = chat(rows);
      expect(await approves()).toBe(false);
      expect(callRpc).not.toHaveBeenCalled();
    });

    it("a reply whose accepted input is not scoped to a turn", async () => {
      const rows = [request(10, "creq-1", "user"), accepted(11, "turn-1", "creq-1"), completed(20, "turn-1"), reply(30, "creq-2", "approvee"), { ...accepted(31, "turn-2", "creq-2"), scope: { kind: "thread" as const } }];
      const { approves, callRpc } = chat(rows);
      expect(await approves()).toBe(false);
      expect(callRpc).not.toHaveBeenCalled();
    });

    it("a thread whose release turn has not ended", async () => {
      const { approves, callRpc, infos } = chat([...typed(30)]);
      expect(await approves()).toBe(false);
      expect(callRpc).not.toHaveBeenCalled();
      expect(infos.join("\n")).toContain("the turn that released the plan has not ended");
    });

    it("a file change between the release and the reply", async () => {
      const { approves, callRpc } = chat(BASE, { timeline: [fileChange(25)] });
      expect(await approves()).toBe(false);
      expect(callRpc).not.toHaveBeenCalled();
    });

    it.each(["sed -i s/a/b/ a.ts", "echo x > out.txt", "git commit -m x", "make build"])("a shell write between the release and the reply: %s", async (text) => {
      const { approves, callRpc } = chat(BASE, { timeline: [command(25, text)] });
      expect(await approves()).toBe(false);
      expect(callRpc).not.toHaveBeenCalled();
    });

    it("work nested in a delegation, found through its rows", async () => {
      const { approves } = chat(BASE, { timeline: [{ kind: "work", workKind: "delegation", sourceSeqStart: 22, childRows: [fileChange(24)] }] });
      expect(await approves()).toBe(false);
    });

    it("a reply after the first change, but still judges the ones before it", async () => {
      const rows = [...BASE.slice(0, 3), ...typed(30, "creq-2", "why step 3?"), completed(35, "turn-2"), ...typed(40, "creq-3", "ok, go"), completed(45, "turn-3")];
      const { approves, callRpc } = chat(rows, { timeline: [fileChange(37)], approves: [0.1, 0.9] });
      expect(await approves()).toBe(false);
      expect(callRpc).toHaveBeenCalledTimes(1);
    });

    it("a truncated timeline read, and a failed one", async () => {
      const truncated = chat(BASE, { timeline: "truncated" });
      expect(await truncated.approves()).toBe(false);
      expect(truncated.callRpc).not.toHaveBeenCalled();
      expect(truncated.infos.join("\n")).toContain("the reply could not be read: the thread's timeline since the plan was released is truncated");
      const failed = chat(BASE, { timeline: new Error("timeline down") });
      expect(await failed.approves()).toBe(false);
      expect(failed.callRpc).not.toHaveBeenCalled();
      expect(failed.infos.join("\n")).toContain("the reply could not be read: ");
    });

    it("a failed read that throws a non-Error", async () => {
      const { approves, infos } = chat(BASE, { timeline: { throws: "boom" } });
      expect(await approves()).toBe(false);
      expect(infos.join("\n")).toContain("the reply could not be read: boom");
    });

    it("an approval a later denial supersedes, which is not even sent", async () => {
      const later = chat([...BASE, lifecycle(50, "turn-3", "resolved", { decision: "deny" })]);
      expect(await later.approves()).toBe(false);
      expect(later.callRpc).not.toHaveBeenCalled();
    });

    it("judges the reply after a denial that came after the release, and not the one before it", async () => {
      const rows = [...BASE.slice(0, 3), ...typed(30, "creq-2", "ok, go"), completed(35, "turn-2"), lifecycle(37, "turn-2", "resolved", { decision: "deny" }), ...typed(40, "creq-3", "ok, go now"), completed(45, "turn-3")];
      const { approves, callRpc } = chat(rows);
      expect(await approves()).toBe(true);
      expect(callRpc).toHaveBeenCalledTimes(1);
      expect(callRpc).toHaveBeenCalledWith(expect.objectContaining(calledWith("ok, go now")));
    });

    it("anything when the release cursor is not set, without calling TypeSafe", async () => {
      const { approves, callRpc } = chat(BASE, { metadata: { presentPlanChatReleasedSeq: undefined } });
      expect(await approves()).toBe(false);
      expect(callRpc).not.toHaveBeenCalled();
    });
  });

  describe("caching", () => {
    it("reuses a numeric cached verdict without a second call, whether it approved or not", async () => {
      const first = chat(BASE, { approves: [0.9] });
      expect(await first.approves()).toBe(true);
      expect(first.metadata.presentPlanChatVerdicts).toEqual({ "30": 0.9 });
      const again = chat(BASE, { metadata: { presentPlanChatVerdicts: first.metadata.presentPlanChatVerdicts } });
      expect(await again.approves()).toBe(true);
      expect(again.callRpc).not.toHaveBeenCalled();
      const denied = chat(BASE, { metadata: { presentPlanChatVerdicts: { "30": 0.2 } } });
      expect(await denied.approves()).toBe(false);
      expect(denied.callRpc).not.toHaveBeenCalled();
    });

    it("judges a reply again on the next call after TypeSafe gave no answer, and credits it once TypeSafe approves", async () => {
      const { approves, callRpc, metadata } = chat(BASE, { approves: [null, 0.9] });
      expect(await approves()).toBe(false);
      expect(callRpc).toHaveBeenCalledTimes(1);
      expect(metadata.presentPlanChatVerdicts).toBeUndefined();
      expect(await approves()).toBe(true);
      expect(callRpc).toHaveBeenCalledTimes(2);
      expect(metadata.presentPlanChatVerdicts).toEqual({ "30": 0.9 });
      expect(await approves()).toBe(true);
      expect(callRpc).toHaveBeenCalledTimes(2);
    });

    it("judges only the reply that is not cached yet", async () => {
      const rows = [...BASE.slice(0, 3), ...typed(30, "creq-2", "why step 3?"), completed(35, "turn-2"), ...typed(40, "creq-3", "ok, go"), completed(45, "turn-3")];
      const { approves, callRpc, metadata } = chat(rows, { metadata: { presentPlanChatVerdicts: { "30": 0.1 } }, approves: [0.9] });
      expect(await approves()).toBe(true);
      expect(callRpc).toHaveBeenCalledTimes(1);
      expect(callRpc).toHaveBeenCalledWith(expect.objectContaining(calledWith("ok, go")));
      expect(metadata.presentPlanChatVerdicts).toEqual({ "30": 0.1, "40": 0.9 });
    });
  });
});
