import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { describe, expect, it } from "vitest";
import { AUTO_REVIEW_MARKER, CODE_REVIEW_OPENING } from "./prompt.js";
import { endedTurn, EVENT_PAGE_MAX, NoTurnCompletedError, quietSincePark, UnreadTurnError } from "./detect-events.js";

interface Row {
  seq: number;
  type: string;
  scope: { kind: "turn"; turnId: string } | { kind: "thread" };
  data: Record<string, unknown>;
}

/** A fake thread whose event log is `rows`; `pageSizes` records how many events each page request returned. */
function logOf(rows: readonly Row[]): { bb: BbPluginApi; pageSizes: number[] } {
  const pageSizes: number[] = [];
  const list = async (args: { afterSeq?: string; types?: string[]; limit?: string }) => {
    const page = rows
      .filter((row) => row.seq > Number(args.afterSeq ?? 0) && args.types?.includes(row.type) === true)
      .slice(0, Number(args.limit));
    pageSizes.push(page.length);
    return page;
  };
  return { bb: { sdk: { threads: { events: { list } } } } as unknown as BbPluginApi, pageSizes };
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
 * `turnId`, as core logged it for the incident this fix replays (thread
 * `thr_3w9ztbnir9`: `resolving` at seq 1296, `resolved` at seq 1297). The
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
