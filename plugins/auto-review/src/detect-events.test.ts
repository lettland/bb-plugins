import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { describe, expect, it } from "vitest";
import { AUTO_REVIEW_MARKER, CODE_REVIEW_OPENING } from "./prompt.js";
import {
  approvedPlanSince,
  endedTurn,
  EVENT_PAGE_MAX,
  firstUserTurnSince,
  NoTurnCompletedError,
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

describe("approvedPlanSince", () => {
  it("finds a plan approved at or after the window's start, across turns", async () => {
    const { bb } = logOf([
      request(3, "creq-1", "user"),
      accepted(4, "turn-1", "creq-1"),
      completed(5, "turn-1"),
      lifecycle(20, "turn-1", "pending", null),
      lifecycle(21, "turn-2", "resolved"),
    ]);
    expect(await approvedPlanSince(bb, "thr", 10)).toEqual({ id: "pint-1", seq: 21, requestedSeq: undefined });
  });

  it("does not find an approval that predates the window", async () => {
    const { bb } = logOf([lifecycle(8, "turn-1", "resolved")]);
    expect(await approvedPlanSince(bb, "thr", 10)).toBeNull();
  });

  it("counts neither a deny nor a non-plan approval", async () => {
    const { bb } = logOf([
      lifecycle(6, "turn-1", "resolved", { decision: "deny" }),
      lifecycle(7, "turn-1", "resolved", { decision: "allow_once" }, { kind: "command", itemId: "i" }),
    ]);
    expect(await approvedPlanSince(bb, "thr", 0)).toBeNull();
  });

  it("finds nothing on a thread with no lifecycle events", async () => {
    expect(await approvedPlanSince(logOf([]).bb, "thr", 0)).toBeNull();
  });
});

describe("a held plan approval form", () => {
  const held = { kind: "turn", turnId: "turn-1" } as const;
  const detached = { kind: "thread" } as const;

  it("counts as a plan approval in the walk, with the form's interaction id", async () => {
    const { bb } = logOf([form(12, held)]);
    expect(await approvedPlanSince(bb, "thr", 10)).toEqual({ id: "pint-form", seq: 12, requestedSeq: undefined });
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
    expect(await approvedPlanSince(bb, "thr", 10)).toBeNull();
  });

  const answered = (answer: Record<string, unknown>) =>
    form(12, held, { resolution: { kind: "plugin_submitted", description: { title: "Approved", payload: { approved: true } }, ...answer } });

  it.each([
    ["missing", {}],
    ["api", { answeredVia: "api" }],
    ["unexpected (desktop)", { answeredVia: "desktop" }],
  ])("does not count an approval whose answeredVia is %s, in the walk or in a turn's approved plans", async (_name, answer) => {
    expect(await approvedPlanSince(logOf([answered(answer)]).bb, "thr", 10)).toBeNull();
    expect((await endedTurn(logOf([completed(15, "turn-1"), answered(answer)]).bb, "thr", 0)).approvedPlans).toEqual([]);
  });

  it("counts an approval whose answeredVia is app, in the walk and in a turn's approved plans", async () => {
    const app = answered({ answeredVia: "app" });
    expect(await approvedPlanSince(logOf([app]).bb, "thr", 10)).toEqual({ id: "pint-form", seq: 12, requestedSeq: undefined });
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

describe("approvedPlanSince's auto-approve fallback", () => {
  it("credits an auto-approval recorded after the window's start", async () => {
    const { bb } = logOf([], { presentPlanAutoApprovedSeq: 11 });
    expect(await approvedPlanSince(bb, "thr", 10)).toEqual({ id: "present-plan-auto-11", seq: 11, requestedSeq: undefined });
  });

  it.each([
    ["at the window's start", { presentPlanAutoApprovedSeq: 10 }],
    ["before the window", { presentPlanAutoApprovedSeq: 9 }],
    ["missing", {}],
  ])("does not credit an auto-approval %s", async (_name, metadata) => {
    expect(await approvedPlanSince(logOf([], metadata).bb, "thr", 10)).toBeNull();
  });

  it("reads unparseable state as idle: nothing is credited, and it warns", async () => {
    const { bb, warnings } = logOf([], { phase: "bogus", presentPlanAutoApprovedSeq: 99 });
    expect(await approvedPlanSince(bb, "thr", 10)).toBeNull();
    expect(warnings[0]).toContain("unparseable thread state");
  });

  it("throws when the state read fails, so the gate fails closed", async () => {
    await expect(approvedPlanSince(logOf([], new Error("state down")).bb, "thr", 10)).rejects.toThrow("state down");
  });

  it("prefers a lifecycle approval and never reads the state when the walk finds one", async () => {
    const { bb } = logOf([lifecycle(21, "turn-1", "resolved")], new Error("state down"));
    expect(await approvedPlanSince(bb, "thr", 10)).toEqual({ id: "pint-1", seq: 21, requestedSeq: undefined });
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
      (await approvedPlanSince(logOf([form(12, { kind: "turn", turnId: "turn-1" }, { resolution: resolution(answeredVia) })]).bb, "thr", 0)) !== null;
    expect(await credited("app")).toBe(true);
    expect(await credited()).toBe(false);
    expect(await credited("api")).toBe(false);
    expect(await credited("desktop")).toBe(false);
  });

  it("a held form's lifecycle event is turn-scoped and a detached one thread-scoped; only the first is credited", async () => {
    // bb core `apps/server/src/services/interactions/pending-interaction-timeline.ts`
    // `interactionScope`: `turnId === null ? threadScope() : turnScope(turnId)`.
    expect(await approvedPlanSince(logOf([form(12, { kind: "turn", turnId: "turn-1" })]).bb, "thr", 0)).not.toBeNull();
    expect(await approvedPlanSince(logOf([form(12, { kind: "thread" })]).bb, "thr", 0)).toBeNull();
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
