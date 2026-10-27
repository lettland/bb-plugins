import { describe, expect, it } from "vitest";
import {
  countPlanReviewerChildren,
  EVENT_PAGE_MAX,
  isImmediateReactionToDeny,
  lightPlan,
  PLAN_EVIDENCE_PAGE_CAP,
  planApprovalOf,
  planGateAction,
  planReviewerTally,
  planReviewTallyExtras,
  planSkillCheck,
  PLAN_LIGHT_MAX_LINES,
  PLAN_REVIEWER_BUDGET_LIGHT,
  PLAN_REVIEWER_BUDGET_STANDARD,
  reviewRanSince,
  reviewReachedAgent,
  reviewSkillLoaded,
  userQuestionOf,
} from "./plan.js";
import { REVIEW_CONTINUATION_CAP_MS, STALE_WINDOW_MS } from "./state.js";

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

  /** The `provider/unhandled` row core records a delivered steer as, copied from thr_ijhpz5srpe seq 2069 (2026-10-26) with the content string trimmed. */
  function steerRow(content: unknown, rawType = "sdk/user") {
    return {
      type: "provider/unhandled",
      data: {
        providerThreadId: "b1189688-7a83-4bcd-9574-b88701cc2a98",
        providerId: "claude-code-glm",
        rawType,
        rawEvent: {
          jsonrpc: "2.0",
          method: "sdk/message",
          params: {
            message: {
              type: "user",
              message: { role: "user", content },
              session_id: "b1189688-7a83-4bcd-9574-b88701cc2a98",
              parent_tool_use_id: null,
              uuid: "939faa18-eb79-4a6f-8925-c43488aa0b96",
              timestamp: "2026-10-26T12:12:10.037Z",
              isReplay: true,
            },
            threadId: "thr_ijhpz5srpe",
          },
        },
      },
    } as never;
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

  it("is true when preamble text and the question share one response, before any steer (thr_ijhpz5srpe seq 2059-2064, 2026-10-26)", () => {
    expect(
      isImmediateReactionToDeny([
        itemStarted({ type: "reasoning" }),
        itemStarted({ type: "agentMessage" }),
        itemStarted({ type: "toolCall", tool: "AskUserQuestion" }),
      ]),
    ).toBe(true);
  });

  it("is false once the steered review arrived (an sdk/user row), even with only preamble text before it", () => {
    expect(
      isImmediateReactionToDeny([
        itemStarted({ type: "reasoning" }),
        itemStarted({ type: "agentMessage" }),
        steerRow("[bb auto-review] <trimmed steered message>"),
        itemStarted({ type: "toolCall", tool: "AskUserQuestion" }),
      ]),
    ).toBe(false);
  });

  it("does not disqualify on a provider/unhandled row of another rawType", () => {
    expect(
      isImmediateReactionToDeny([
        steerRow("[bb auto-review] <trimmed steered message>", "sdk/system"),
        itemStarted({ type: "toolCall", tool: "AskUserQuestion" }),
      ]),
    ).toBe(true);
  });

  it("does not disqualify on an sdk/user row whose content is replayed tool results", () => {
    expect(
      isImmediateReactionToDeny([
        steerRow([{ type: "tool_result", tool_use_id: "toolu_1", content: "ok" }]),
        itemStarted({ type: "toolCall", tool: "AskUserQuestion" }),
      ]),
    ).toBe(true);
  });

  it("fails closed on an sdk/user row whose content path is missing", () => {
    const unreadable = {
      type: "provider/unhandled",
      data: {
        providerId: "claude-code-glm",
        rawType: "sdk/user",
        rawEvent: {
          jsonrpc: "2.0",
          method: "sdk/message",
          params: {
            message: {
              type: "user",
              message: { role: "user" },
              isReplay: true,
            },
            threadId: "thr_ijhpz5srpe",
          },
        },
      },
    } as never;
    expect(
      isImmediateReactionToDeny([unreadable, itemStarted({ type: "toolCall", tool: "AskUserQuestion" })]),
    ).toBe(false);
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

describe("reviewRanSince", () => {
  const GATE_TOOLS = ["ExitPlanMode", "EnterPlanMode", "AskUserQuestion"];

  it("is true across a turn end when acrossTurns, and reads no turn ends", async () => {
    // The review's children ended the turn; bb wakes the agent in a later one.
    const across = eventsBb([readRow(101), { seq: 102, type: "turn/completed" }]);
    expect(await reviewRanSince(across.bb, "t", 100, GATE_TOOLS, false, true)).toBe(true);
    expect(across.calls.every((call) => call.types.includes("item/completed"))).toBe(true);
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

  it("releases the reviewed plan even when the arm is older than the stale window", () => {
    expect(
      planGateAction(
        {
          phase: "idle",
          planReviewArmedAt: NOW - STALE_WINDOW_MS - 1,
          planReviewDeliveredSeq: 100,
        },
        NOW,
      ),
    ).toBe("release");
  });

  it("treats a presentation past the continuation cap of a delivered review as a fresh review", () => {
    expect(
      planGateAction(
        {
          phase: "idle",
          planReviewArmedAt: NOW - REVIEW_CONTINUATION_CAP_MS - 1,
          planReviewDeliveredSeq: 100,
        },
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

/** The `devkit_load_skill` item of the agent's own load, as real claude-code and codex rows carry it. */
const AGENT_LOAD = {
  type: "toolCall",
  id: "toolu_01",
  tool: "devkit_load_skill",
  server: "bb",
  status: "completed",
  arguments: { slug: "review-code" },
};

type FakeRow = {
  seq: number;
  type: "item/completed" | "turn/completed";
  item?: Record<string, unknown>;
};

const itemRow = (seq: number, item: Record<string, unknown>): FakeRow => ({ seq, type: "item/completed", item });
const readRow = (seq: number, extra: Record<string, unknown> = {}): FakeRow =>
  itemRow(seq, { type: "toolCall", tool: "Read", status: "completed", ...extra });

/** A `bb` whose event log serves `rows` like the server: filtered by type and cursor, oldest first, paged. */
function eventsBb(rows: FakeRow[], options: { itemsThrow?: boolean; asString?: boolean; ignoreTypes?: boolean } = {}) {
  const calls: Array<{ types: readonly string[]; afterSeq: string }> = [];
  const warnings: string[] = [];
  const bb = {
    log: { warn: (message: string) => warnings.push(message) },
    sdk: {
      threads: {
        events: {
          list: async (args: { afterSeq: string; types: readonly string[]; limit: string }) => {
            calls.push({ types: args.types, afterSeq: args.afterSeq });
            if (options.itemsThrow === true && args.types.includes("item/completed")) {
              throw options.asString === true ? "kaboom" : new Error("events unavailable");
            }
            return rows
              .filter((row) => (options.ignoreTypes === true || args.types.includes(row.type)) && row.seq > Number(args.afterSeq))
              .sort((a, b) => a.seq - b.seq)
              .slice(0, Number(args.limit))
              .map((row) => ({
                seq: row.seq,
                type: row.type,
                data: row.type === "item/completed" ? { item: row.item } : {},
              }));
          },
        },
      },
    },
  };
  return { bb: bb as never, raw: bb, calls, warnings };
}

describe("reviewSkillLoaded", () => {
  it("is loaded when the agent itself loaded review-code", async () => {
    const { bb } = eventsBb([readRow(101), itemRow(102, AGENT_LOAD)]);
    expect(await reviewSkillLoaded(bb, "t", 100)).toBe("loaded");
  });

  it("is missing when only a subagent loaded it", async () => {
    const { bb } = eventsBb([itemRow(101, { ...AGENT_LOAD, parentToolCallId: "toolu_parent" })]);
    expect(await reviewSkillLoaded(bb, "t", 100)).toBe("missing");
  });

  it("is missing for another slug or a reference only", async () => {
    const { bb } = eventsBb([
      itemRow(101, { ...AGENT_LOAD, arguments: { slug: "typescript" } }),
      itemRow(102, { ...AGENT_LOAD, arguments: { reference: "review-delta-scope" } }),
      itemRow(103, { ...AGENT_LOAD, arguments: {} }),
    ]);
    expect(await reviewSkillLoaded(bb, "t", 100)).toBe("missing");
  });

  it("is missing for a load that failed, or for no calls at all", async () => {
    const failed = eventsBb([itemRow(101, { ...AGENT_LOAD, status: "failed" })]);
    expect(await reviewSkillLoaded(failed.bb, "t", 100)).toBe("missing");
    expect(await reviewSkillLoaded(eventsBb([]).bb, "t", 100)).toBe("missing");
  });

  it("does not check the server label", async () => {
    const { bb } = eventsBb([itemRow(101, { ...AGENT_LOAD, server: "devkit-v2" })]);
    expect(await reviewSkillLoaded(bb, "t", 100)).toBe("loaded");
  });

  it("is loaded for a load in a later turn, after a turn ended", async () => {
    // The review is dispatched as a new turn, or the agent is woken later by its review children.
    const { bb, calls } = eventsBb([
      readRow(101),
      { seq: 102, type: "turn/completed" },
      itemRow(103, AGENT_LOAD),
    ]);
    expect(await reviewSkillLoaded(bb, "t", 100)).toBe("loaded");
    expect(calls.every((call) => call.types.includes("item/completed"))).toBe(true);
  });

  it("is loaded for a load before a turn end, too", async () => {
    const { bb } = eventsBb([itemRow(101, AGENT_LOAD), { seq: 102, type: "turn/completed" }]);
    expect(await reviewSkillLoaded(bb, "t", 100)).toBe("loaded");
  });

  it("only looks past the cursor it is given", async () => {
    const { bb } = eventsBb([itemRow(95, AGENT_LOAD)]);
    expect(await reviewSkillLoaded(bb, "t", 100)).toBe("missing");
    expect(await reviewSkillLoaded(bb, "t", 90)).toBe("loaded");
  });

  it("is unknown when the agent's load records no arguments", async () => {
    const { arguments: _omitted, ...bare } = AGENT_LOAD;
    const { bb } = eventsBb([itemRow(101, bare)]);
    expect(await reviewSkillLoaded(bb, "t", 100)).toBe("unknown");
  });

  it("stops paging at the first match", async () => {
    const filler = Array.from({ length: EVENT_PAGE_MAX * 2 }, (_, index) => readRow(101 + index));
    const { bb, calls } = eventsBb([...filler, itemRow(101 + EVENT_PAGE_MAX * 2 + 5, AGENT_LOAD), readRow(900)]);
    expect(await reviewSkillLoaded(bb, "t", 100)).toBe("loaded");
    const itemPages = calls.filter((call) => call.types.includes("item/completed"));
    expect(itemPages.map((call) => call.afterSeq)).toEqual(["100", "200", "300"]);
    expect(calls).toHaveLength(3);
  });

  it("reads a full page and an empty next one as an exhausted log", async () => {
    const full = Array.from({ length: EVENT_PAGE_MAX }, (_, index) => readRow(101 + index));
    expect(await reviewSkillLoaded(eventsBb(full).bb, "t", 100)).toBe("missing");
  });

  it("is unknown once the page cap is reached without a match", async () => {
    const rows = Array.from({ length: EVENT_PAGE_MAX * PLAN_EVIDENCE_PAGE_CAP + 10 }, (_, index) =>
      readRow(101 + index),
    );
    const { bb, calls } = eventsBb(rows);
    expect(await reviewSkillLoaded(bb, "t", 100)).toBe("unknown");
    expect(calls).toHaveLength(PLAN_EVIDENCE_PAGE_CAP);
  });

  it("is unknown for a subagent-heavy log, the pattern of the incident", async () => {
    const rows = Array.from({ length: EVENT_PAGE_MAX * PLAN_EVIDENCE_PAGE_CAP + 1 }, (_, index) =>
      readRow(101 + index, { parentToolCallId: "toolu_explore" }),
    );
    expect(await reviewSkillLoaded(eventsBb(rows).bb, "t", 100)).toBe("unknown");
  });

  it("is unknown, with a warning, when the read fails", async () => {
    const items = eventsBb([itemRow(101, AGENT_LOAD)], { itemsThrow: true });
    expect(await reviewSkillLoaded(items.bb, "t", 100)).toBe("unknown");
    expect(items.warnings.some((message) => message.includes("check review-code was loaded in t"))).toBe(true);
  });

  it("is unknown without a cursor, and reads nothing", async () => {
    const { bb, calls } = eventsBb([itemRow(101, AGENT_LOAD)]);
    expect(await reviewSkillLoaded(bb, "t", undefined)).toBe("unknown");
    expect(calls).toEqual([]);
  });
});

describe("planSkillCheck", () => {
  function withPlugins(
    plugins: Array<{ enabled: boolean; status: string; cliCommand: { name: string } | null }> | "throws",
    rows: FakeRow[] = [],
  ) {
    const events = eventsBb(rows);
    const bb = {
      log: events.raw.log,
      sdk: {
        ...events.raw.sdk,
        plugins: {
          list: async () => {
            if (plugins === "throws") {
              throw new Error("plugin list unavailable");
            }
            return { plugins };
          },
        },
      },
    };
    return { bb: bb as never, events, warnings: events.warnings };
  }
  const DEVKIT = { enabled: true, status: "running", cliCommand: { name: "devkit" } };

  it("checks nothing in self mode", async () => {
    const { bb, events } = withPlugins("throws");
    expect(await planSkillCheck(bb, "t", "self", 100)).toBe("loaded");
    expect(events.calls).toEqual([]);
  });

  it("requires the load in auto mode while devkit runs", async () => {
    expect(await planSkillCheck(withPlugins([DEVKIT]).bb, "t", "auto", 100)).toBe("missing");
    expect(await planSkillCheck(withPlugins([DEVKIT], [itemRow(101, AGENT_LOAD)]).bb, "t", "auto", 100)).toBe(
      "loaded",
    );
  });

  it("does not require it in auto mode without a running devkit", async () => {
    expect(await planSkillCheck(withPlugins([]).bb, "t", "auto", 100)).toBe("loaded");
    for (const entry of [
      { ...DEVKIT, enabled: false },
      { ...DEVKIT, status: "stopped" },
      { ...DEVKIT, cliCommand: null },
      { ...DEVKIT, cliCommand: { name: "aislop" } },
    ]) {
      expect(await planSkillCheck(withPlugins([entry]).bb, "t", "auto", 100)).toBe("loaded");
    }
  });

  it("is unknown, never loaded, when the plugin lookup fails", async () => {
    const { bb, warnings } = withPlugins("throws");
    expect(await planSkillCheck(bb, "t", "auto", 100)).toBe("unknown");
    expect(warnings.some((message) => message.includes("could not list plugins"))).toBe(true);
  });

  it("requires it in devkit mode without asking which plugins run", async () => {
    expect(await planSkillCheck(withPlugins("throws").bb, "t", "devkit", 100)).toBe("missing");
    expect(await planSkillCheck(withPlugins([], [itemRow(101, AGENT_LOAD)]).bb, "t", "devkit", 100)).toBe("loaded");
    expect(await planSkillCheck(withPlugins([]).bb, "t", "devkit", undefined)).toBe("unknown");
  });
});

describe("plan evidence reads that fail or lie", () => {
  const GATE_TOOLS = ["ExitPlanMode", "EnterPlanMode", "AskUserQuestion"];

  it("reports an unread plan-review check and leaves the plan for the user, whatever the error", async () => {
    const notAnError = eventsBb([], { itemsThrow: true, asString: true });
    expect(await reviewRanSince(notAnError.bb, "t", 100, GATE_TOOLS, false, true)).toBe(false);
    expect(notAnError.warnings[0]).toContain("could not read events to check the plan review ran in t");
    expect(notAnError.warnings[0]).toContain("kaboom");
  });

  it("reports an unread skill check as unknown, whatever the error", async () => {
    const notAnError = eventsBb([], { itemsThrow: true, asString: true });
    expect(await reviewSkillLoaded(notAnError.bb, "t", 100)).toBe("unknown");
    expect(notAnError.warnings[0]).toContain("could not read events to check review-code was loaded in t");
    expect(notAnError.warnings[0]).toContain("kaboom");
  });

  it("skips rows of another type that a page returns unasked, and still finds the load", async () => {
    const mixed = eventsBb([{ seq: 101, type: "turn/completed" }, itemRow(102, AGENT_LOAD)], { ignoreTypes: true });
    expect(await reviewSkillLoaded(mixed.bb, "t", 100)).toBe("loaded");
  });
});

describe("lightPlan", () => {
  const lines = (count: number) => Array.from({ length: count }, (_, index) => `line ${index}`).join("\n");

  it("is true at and under the 40-line threshold, false past it", () => {
    expect(PLAN_LIGHT_MAX_LINES).toBe(40);
    expect(lightPlan(lines(39))).toBe(true);
    expect(lightPlan(lines(40))).toBe(true);
    expect(lightPlan(lines(41))).toBe(false);
  });

  it("trims ONE trailing newline, so a 40-line plan plus its final newline stays light", () => {
    expect(lightPlan(`${lines(40)}\n`)).toBe(true);
    expect(lightPlan(`${lines(41)}\n`)).toBe(false);
    // A second trailing newline is a (blank) line of its own, not trimmed.
    expect(lightPlan(`${lines(40)}\n\n`)).toBe(false);
  });

  it("reads an empty plan as its one line, and a null plan as standard", () => {
    expect(lightPlan("")).toBe(true);
    expect(lightPlan(null)).toBe(false);
  });
});

/** A `threads.list` row with only the fields the tally reads; `title` stays null to prove titles never filter. */
function childEntry(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    title: null,
    createdAt: 1_000,
    originPluginId: null,
    parentThreadId: "thr",
    status: "idle",
    archivedAt: 1,
    deletedAt: null,
    ...overrides,
  };
}

describe("countPlanReviewerChildren", () => {
  const armedAt = 1_000;

  it("counts finished, archived and running children created since the arm, null-titled included", () => {
    const counted = countPlanReviewerChildren(
      [
        childEntry("done", { status: "idle", archivedAt: 2_000 }),
        childEntry("archived", { status: "active", archivedAt: 2_000 }),
        childEntry("running", { status: "active", archivedAt: null }),
        childEntry("untitled", { title: null }),
      ],
      armedAt,
    );
    expect(counted.map((entry) => entry.id).sort()).toEqual(["archived", "done", "running", "untitled"]);
  });

  it("excludes children created before the arm and plugin-origin helpers, whatever their age", () => {
    const counted = countPlanReviewerChildren(
      [
        childEntry("pre-arm", { createdAt: armedAt - 1 }),
        childEntry("helper", { originPluginId: "advisor", createdAt: armedAt + 5 }),
        childEntry("grandchild-helper", { originPluginId: "advisor", createdAt: 5_000 }),
      ],
      armedAt,
    );
    expect(counted).toEqual([]);
  });

  it("counts a child created exactly at the arm", () => {
    expect(
      countPlanReviewerChildren([childEntry("at-arm", { createdAt: armedAt })], armedAt).map((entry) => entry.id),
    ).toEqual(["at-arm"]);
  });
});

/** A `bb` whose thread list serves fixed rows and whose log records warnings. */
function tallyBb(entries: ReturnType<typeof childEntry>[]) {
  const warnings: string[] = [];
  const bb = {
    log: { warn: (message: string) => warnings.push(message) },
    sdk: {
      threads: {
        list: async () => entries,
      },
    },
  };
  return { bb: bb as never, warnings };
}

describe("planReviewerTally", () => {
  const entry = (id: string, createdAt = 1_500) => childEntry(id, { createdAt });

  it("stays silent at the budget and warns past it, naming the count, tier and child ids", async () => {
    const seven = Array.from({ length: PLAN_REVIEWER_BUDGET_STANDARD }, (_, index) => entry(`r${index}`));
    const standard = tallyBb(seven);
    expect(await planReviewerTally(standard.bb, "thr", 1_000, false)).toEqual({ count: 7, tier: "standard" });
    expect(standard.warnings).toEqual([]);
    const eight = tallyBb([...seven, entry("r7")]);
    expect(await planReviewerTally(eight.bb, "thr", 1_000, false)).toEqual({ count: 8, tier: "standard" });
    expect(eight.warnings[0]).toContain("spawned 8 bb child threads since the arm, over the standard budget of 7");
    expect(eight.warnings[0]).toContain("r0, r1, r2, r3, r4, r5, r6, r7");
  });

  it("warns past the light budget of 3, not at it", async () => {
    const three = Array.from({ length: PLAN_REVIEWER_BUDGET_LIGHT }, (_, index) => entry(`l${index}`));
    const light = tallyBb(three);
    expect(await planReviewerTally(light.bb, "thr", 1_000, true)).toEqual({ count: 3, tier: "light" });
    expect(light.warnings).toEqual([]);
    const four = tallyBb([...three, entry("l3")]);
    expect(await planReviewerTally(four.bb, "thr", 1_000, true)).toEqual({ count: 4, tier: "light" });
    expect(four.warnings[0]).toContain("spawned 4 bb child threads since the arm, over the light budget of 3");
  });

  it("lets six standard children pass (five lenses plus a legitimate per-lens respawn)", async () => {
    const six = Array.from({ length: 6 }, (_, index) => entry(`r${index}`));
    const standard = tallyBb(six);
    expect(await planReviewerTally(standard.bb, "thr", 1_000, false)).toEqual({ count: 6, tier: "standard" });
    expect(standard.warnings).toEqual([]);
  });

  it("lets plugin-origin helpers pile past the threshold unseen, and counts nothing for them", async () => {
    const helpers = Array.from({ length: 10 }, (_, index) => childEntry(`h${index}`, { originPluginId: "advisor" }));
    const light = tallyBb(helpers);
    expect(await planReviewerTally(light.bb, "thr", 1_000, true)).toEqual({ count: 0, tier: "light" });
    expect(light.warnings).toEqual([]);
  });

  it("is null without an arm time, reading nothing", async () => {
    const unread = tallyBb([entry("r0")]);
    expect(await planReviewerTally(unread.bb, "thr", undefined, false)).toBeNull();
    expect(unread.warnings).toEqual([]);
  });
});

describe("planReviewTallyExtras", () => {
  it("carries the tally into the fire record, or nothing when it could not be measured", () => {
    expect(planReviewTallyExtras({ count: 4, tier: "light" })).toEqual({
      planReviewerCount: 4,
      planReviewTier: "light",
    });
    expect(planReviewTallyExtras(null)).toEqual({});
  });
});
