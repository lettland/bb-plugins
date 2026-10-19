import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { describe, expect, it } from "vitest";
import { endedTurn, EVENT_PAGE_MAX, NoTurnCompletedError, UnreadTurnError } from "./detect-events.js";

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
      expect(await endedTurn(bb, "thr", 0, (turns - 1) * 3 + 2)).toEqual({ users: true, completedSeq: turns * 3 + 2 });
    },
  );

  it("asks for one more page when a page comes back exactly full, and stops at the first short one", async () => {
    const { bb, pageSizes } = threadWith(EVENT_PAGE_MAX);
    await endedTurn(bb, "thr", 0, (EVENT_PAGE_MAX - 1) * 3 + 2);
    // Accepted inputs and requests are read from the cursor: each full page is followed by an empty one.
    expect(pageSizes.filter((size) => size === EVENT_PAGE_MAX)).toHaveLength(2);
    expect(pageSizes.filter((size) => size === 0)).toHaveLength(2);
  });

  it("is not the user's when the last turn's request was a wake-up", async () => {
    const { bb } = threadWith(3, false);
    expect(await endedTurn(bb, "thr", 0, 8)).toEqual({ users: false, completedSeq: 11 });
  });

  it("reads the first turn to complete after the last one handled, not the newest", async () => {
    const { bb } = threadWith(3);
    expect(await endedTurn(bb, "thr", 0, 0)).toEqual({ users: false, completedSeq: 5 });
    expect(await endedTurn(bb, "thr", 0, 5)).toEqual({ users: false, completedSeq: 8 });
  });

  it("is not the user's when a turn completed but no input was accepted into it since the cursor", async () => {
    const { bb } = logOf([request(3, "creq-1", "user"), accepted(4, "turn-1", "creq-1"), completed(5, "turn-1"), completed(8, "turn-2")]);
    expect(await endedTurn(bb, "thr", 5)).toEqual({ users: false, completedSeq: 8 });
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
});
