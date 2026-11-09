import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { describe, expect, it, vi } from "vitest";
import { AUTO_REVIEW_MARKER } from "./prompt.js";
import { CHAT_APPROVAL_THRESHOLD } from "./detect-chat-approval.js";
import { planLatestDecisionApproves } from "./detect-events.js";
import { withThreadLock } from "./state.js";

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
    /** Runs inside the TypeSafe call, as an arm of a new plan would while a reply is judged. */
    onRpc?: (metadata: Record<string, unknown>) => void;
    /** Runs after each state write. */
    onWrite?: (metadata: Record<string, unknown>) => void;
  }

  function chat(rows: readonly Row[], options: Options = {}) {
    const metadata: Record<string, unknown> = { presentPlanChatReleasedSeq: RELEASED, ...options.metadata };
    const answers = [...(options.approves ?? [0.9])];
    const callRpc = vi.fn(async (_args: unknown) => {
      options.onRpc?.(metadata);
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
          updatePluginMetadata: async (args: { set?: Record<string, unknown> }) => {
            Object.assign(metadata, args.set ?? {});
            options.onWrite?.(metadata);
            return metadata;
          },
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
      // The shape of seq 239 of thr_w7c3pt43uv (2026-11-09): the advisor's queue message, `initiator: "user"` with `originPluginId: "advisor"`.
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

  describe("a credited reply", () => {
    it("is stored, so a later read counts it without a walk, a call or a timeline", async () => {
      const first = chat(BASE);
      expect(await first.approves()).toBe(true);
      expect(first.metadata.presentPlanChatApprovedSeq).toBe(30);
      const later = chat(BASE, { metadata: { presentPlanChatApprovedSeq: 30 }, timeline: "truncated" });
      expect(await later.approves()).toBe(true);
      expect(later.callRpc).not.toHaveBeenCalled();
      expect(later.infos).toEqual([]);
    });

    it("counts even when the thread's later timeline would truncate and the release cursor is gone", async () => {
      const { approves, callRpc } = chat(BASE, { metadata: { presentPlanChatApprovedSeq: 30, presentPlanChatReleasedSeq: undefined }, timeline: "truncated" });
      expect(await approves()).toBe(true);
      expect(callRpc).not.toHaveBeenCalled();
    });

    it("is overridden by a later denial, and the walk then judges only replies after it", async () => {
      const denied = chat([...BASE, lifecycle(50, "turn-3", "resolved", { decision: "deny" })], { metadata: { presentPlanChatApprovedSeq: 30 } });
      expect(await denied.approves()).toBe(false);
      expect(denied.callRpc).not.toHaveBeenCalled();
    });

    it("survives a denial from before it", async () => {
      const { approves, callRpc } = chat([lifecycle(5, "turn-0", "resolved", { decision: "deny" }), ...BASE], { metadata: { presentPlanChatApprovedSeq: 30 } });
      expect(await approves()).toBe(true);
      expect(callRpc).not.toHaveBeenCalled();
    });

    it("is not counted at the same seq as a denial", async () => {
      const { approves } = chat([...BASE, lifecycle(30, "turn-3", "resolved", { decision: "deny" })], { metadata: { presentPlanChatApprovedSeq: 30 } });
      expect(await approves()).toBe(false);
    });
  });

  describe("when a new plan is presented while a reply is judged", () => {
    const arm = (metadata: Record<string, unknown>) => {
      delete metadata.presentPlanChatReleasedSeq;
      delete metadata.presentPlanChatVerdicts;
      delete metadata.presentPlanChatApprovedSeq;
    };

    it("writes no verdict and gives no credit when the arm lands during the TypeSafe call", async () => {
      const { approves, metadata, infos } = chat(BASE, { onRpc: arm });
      expect(await approves()).toBe(false);
      expect(metadata.presentPlanChatVerdicts).toBeUndefined();
      expect(metadata.presentPlanChatApprovedSeq).toBeUndefined();
      expect(metadata.presentPlanChatReleasedSeq).toBeUndefined();
      expect(infos.join("\n")).toContain("a new plan was presented while the reply was judged");
    });

    it("writes no approved seq and gives no credit when the arm lands after the verdict is stored", async () => {
      const { approves, metadata, infos } = chat(BASE, { onWrite: arm });
      expect(await approves()).toBe(false);
      expect(metadata.presentPlanChatApprovedSeq).toBeUndefined();
      expect(infos.join("\n")).toContain("a new plan was presented while the reply was judged");
    });

    it("writes only under the thread lock, re-reading the state inside it", async () => {
      let release!: () => void;
      const held = withThreadLock("thr", () => new Promise<void>((resolve) => { release = resolve; }));
      const { approves, metadata, callRpc } = chat(BASE);
      const pending = approves();
      await vi.waitFor(() => expect(callRpc).toHaveBeenCalledTimes(1));
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(metadata.presentPlanChatVerdicts).toBeUndefined();
      release();
      await held;
      expect(await pending).toBe(true);
      expect(metadata.presentPlanChatVerdicts).toEqual({ "30": 0.9 });
      expect(metadata.presentPlanChatApprovedSeq).toBe(30);
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
