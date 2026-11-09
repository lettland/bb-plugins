import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { describe, expect, it } from "vitest";
import { reviewSize, TRIVIAL_DIFF_LINES } from "./change-size.js";
import type { AvailableWorkspace, WorkingTreeFile } from "./detect-workspace.js";

interface Row {
  seq: number;
  type: string;
  scope: { kind: "turn"; turnId: string } | { kind: "thread" };
  data: Record<string, unknown>;
}

/** A resolved plan-approval lifecycle row, as `endedTurn`'s tests replay it; the decision defaults to the user's `allow_once`. */
const lifecycle = (seq: number, decision = "allow_once"): Row => ({
  seq,
  type: "system/interaction/lifecycle",
  scope: { kind: "turn", turnId: "turn-1" },
  data: {
    interaction: {
      id: "pint-1",
      status: "resolved",
      statusReason: null,
      payload: {
        kind: "approval",
        availableDecisions: ["allow_once", "deny"],
        reason: null,
        subject: { kind: "plan", itemId: "i", plan: "# Plan", planFilePath: null },
      },
      resolution: { decision },
    },
  },
});

/** This plugin's plan-approval form resolved as approved; turn-scoped when the host held the call, thread-scoped when it detached. */
const approvalForm = (
  seq: number,
  scope: Row["scope"] = { kind: "turn", turnId: "turn-1" },
  answer: Record<string, unknown> = { answeredVia: "app" },
): Row => ({
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
      resolution: { kind: "plugin_submitted", description: { title: "Approved", payload: { approved: true } }, ...answer },
    },
  },
});

const file = (path: string, insertions: number | null, deletions: number | null): WorkingTreeFile =>
  ({ path, status: "M", insertions, deletions }) as WorkingTreeFile;

/** A workspace whose working tree is `workingTree` and whose merge base carries `mergeBase` when given. */
const workspace = (workingTree: WorkingTreeFile[], mergeBase?: WorkingTreeFile[]): AvailableWorkspace =>
  ({
    checkout: { kind: "branch", headSha: "0123abcd" },
    workingTree: { files: workingTree },
    ...(mergeBase !== undefined ? { mergeBase: { files: mergeBase } } : {}),
  }) as unknown as AvailableWorkspace;

/**
 * A bb whose `changeSize` rpc resolves `rpc` (or throws), and whose event log
 * is `rows`; `afterSeq` filtering mirrors the host's, so a stale plan row
 * before the window cannot be found. `metadata` is the thread's plugin state
 * (an Error is thrown by the read).
 */
function bbOf(
  rpc: unknown,
  rows: Row[] | "throws" = [],
  metadata: unknown = {},
): { bb: BbPluginApi; warnings: string[]; rpcCalls: Array<Record<string, unknown>>; walkStarts: string[] } {
  const warnings: string[] = [];
  const rpcCalls: Array<Record<string, unknown>> = [];
  const walkStarts: string[] = [];
  const bb = {
    log: { warn: (message: string) => warnings.push(message) },
    sdk: {
      plugins: {
        callRpc: async (args: Record<string, unknown>) => {
          rpcCalls.push(args);
          if (rpc === "throws") {
            throw new Error("rpc down");
          }
          return rpc;
        },
      },
      threads: {
        getPluginMetadata: async () => {
          if (metadata instanceof Error) {
            throw metadata;
          }
          return metadata;
        },
        events: {
          list: async (args: { afterSeq?: string; types?: string[]; limit?: string }) => {
            walkStarts.push(args.afterSeq ?? "");
            if (rows === "throws") {
              throw new Error("events down");
            }
            return rows
              .filter((row) => row.seq > Number(args.afterSeq ?? 0) && args.types?.includes(row.type) !== false)
              .slice(0, Number(args.limit));
          },
        },
      },
    },
  } as unknown as BbPluginApi;
  return { bb, warnings, rpcCalls, walkStarts };
}

describe("TRIVIAL_DIFF_LINES", () => {
  it("is the line cap a trivial verdict still self-reviews", () => {
    expect(TRIVIAL_DIFF_LINES).toBe(10);
  });
});

describe("reviewSize", () => {
  it("asks the typesafe plugin's changeSize rpc for this thread's verdict", async () => {
    const { bb, rpcCalls } = bbOf({ verdict: "trivial", messageSeq: 5 });
    await reviewSize(bb, "thr_1", ["a.ts"], workspace([file("a.ts", 3, 2)]), 0);
    expect(rpcCalls).toEqual([
      { pluginId: "typesafe", method: "changeSize", input: { threadId: "thr_1" }, outputSchema: expect.anything() },
    ]);
  });

  it("self-reviews a trivial verdict within the floor and never walks the plan window", async () => {
    const { bb, walkStarts } = bbOf({ verdict: "trivial", messageSeq: 5 });
    expect(await reviewSize(bb, "thr_1", ["a.ts"], workspace([file("a.ts", 3, 2)]), 0)).toEqual({
      trivial: true,
      blocker: false,
    });
    expect(walkStarts).toEqual([]);
  });

  it("keeps a change at the line cap trivial and pushes one past it out", async () => {
    const { bb } = bbOf({ verdict: "trivial", messageSeq: 5 });
    expect((await reviewSize(bb, "thr_1", ["a.ts"], workspace([file("a.ts", 6, 4)]), 0)).trivial).toBe(true);
    expect((await reviewSize(bb, "thr_1", ["a.ts"], workspace([file("a.ts", 6, 5)]), 0)).trivial).toBe(false);
  });

  it("sums the path's working-tree and merge-base lines for the floor", async () => {
    const { bb } = bbOf({ verdict: "trivial", messageSeq: 5 });
    expect(
      (await reviewSize(bb, "thr_1", ["a.ts"], workspace([file("a.ts", 3, 2)], [file("a.ts", 4, 1)]), 0)).trivial,
    ).toBe(true);
    const over = await reviewSize(bb, "thr_1", ["a.ts"], workspace([file("a.ts", 3, 2)], [file("a.ts", 5, 2)]), 0);
    expect(over.trivial).toBe(false);
    expect(over.blocker).toBe(true);
  });

  it.each([
    ["two paths in scope", ["a.ts", "b.ts"], workspace([file("a.ts", 1, 1)])],
    ["no path in scope", [], workspace([file("a.ts", 1, 1)])],
    ["no workspace", ["a.ts"], null],
    ["null line stats", ["a.ts"], workspace([file("a.ts", null, null)])],
    ["the path absent from both trees", ["a.ts"], workspace([file("b.ts", 1, 1)])],
  ] as const)("is over the floor with %s, and reports the blocker when no plan follows", async (_name, scope, ws) => {
    const { bb, walkStarts } = bbOf({ verdict: "trivial", messageSeq: 5 });
    expect(await reviewSize(bb, "thr_1", scope, ws as AvailableWorkspace | null, 0)).toEqual({
      trivial: false,
      blocker: true,
    });
    expect(walkStarts).toEqual(["0"]);
  });

  it("a plan approved after a fresh trivial verdict's messageSeq keeps the over-floor review unblocked", async () => {
    const { bb } = bbOf({ verdict: "trivial", messageSeq: 10 }, [lifecycle(12, "allow_for_session")]);
    expect(await reviewSize(bb, "thr_1", ["a.ts"], workspace([file("a.ts", 6, 5)]), 0)).toEqual({
      trivial: false,
      blocker: false,
    });
  });

  // thr_ztxgu84xib (11-09): a follow-up request moved the plan window past the approval, so the Blocker fired
  // on follow-ups under an approved plan. The thread's latest plan decision decides, whatever the verdict's seq.
  it("keeps an approval that predates a fresh verdict's messageSeq: a follow-up under an approved plan is not blocked", async () => {
    const { bb, walkStarts } = bbOf({ verdict: "trivial", messageSeq: 10 }, [lifecycle(8)]);
    expect(await reviewSize(bb, "thr_1", ["a.ts"], workspace([file("a.ts", 6, 5)]), 0)).toEqual({
      trivial: false,
      blocker: false,
    });
    expect(walkStarts).toEqual(["0"]);
  });

  it("loses the verdict, warns, and walks nothing when the rpc fails, whatever the error", async () => {
    const { bb, warnings, walkStarts } = bbOf("throws");
    expect(await reviewSize(bb, "thr_1", ["a.ts"], workspace([file("a.ts", 3, 2)]), 0)).toEqual({
      trivial: false,
      blocker: false,
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("failed closed");
    expect(warnings[0]).toContain("rpc down");
    expect(walkStarts).toEqual([]);
  });

  it("walks the whole thread when a lost verdict sits over the floor", async () => {
    const { bb, walkStarts } = bbOf("throws");
    expect(await reviewSize(bb, "thr_1", ["a.ts"], workspace([file("a.ts", 30, 30)]), 7)).toEqual({
      trivial: false,
      blocker: true,
    });
    expect(walkStarts).toEqual(["0"]);
  });

  it("neither walks nor blocks on a stale non_trivial verdict within the floor", async () => {
    // The verdict sized an earlier request: it cannot anchor this window, and
    // the small diff needs no plan.
    const { bb, walkStarts } = bbOf({ verdict: "non_trivial", messageSeq: 10 });
    expect(await reviewSize(bb, "thr_1", ["a.ts"], workspace([file("a.ts", 3, 2)]), 20)).toEqual({
      trivial: false,
      blocker: false,
    });
    expect(walkStarts).toEqual([]);
  });

  it("earns no self-review from a stale trivial verdict within the floor", async () => {
    // Stale is missing for this work: the verdict sized an earlier request, so
    // it neither earns the focused self-review nor anchors the window.
    const { bb, walkStarts } = bbOf({ verdict: "trivial", messageSeq: 10 });
    expect(await reviewSize(bb, "thr_1", ["a.ts"], workspace([file("a.ts", 3, 2)]), 20)).toEqual({
      trivial: false,
      blocker: false,
    });
    expect(walkStarts).toEqual([]);
  });

  it("reports the blocker for a fresh non_trivial verdict only when no plan was approved", async () => {
    // thr_27zu8ukmfg (11-07): no approval anywhere in the thread still fires it.
    const { bb } = bbOf({ verdict: "non_trivial", messageSeq: 10 }, []);
    expect(await reviewSize(bb, "thr_1", ["a.ts"], workspace([file("a.ts", 3, 2)]), 0)).toEqual({
      trivial: false,
      blocker: true,
    });
  });

  it("waives the blocker for a fresh non_trivial verdict under an earlier approved plan (thr_ztxgu84xib)", async () => {
    const { bb } = bbOf({ verdict: "non_trivial", messageSeq: 10 }, [lifecycle(8)]);
    expect(await reviewSize(bb, "thr_1", ["a.ts"], workspace([file("a.ts", 3, 2)]), 0)).toEqual({
      trivial: false,
      blocker: false,
    });
  });

  it("reports the blocker when a denied plan came after the approval, and clears it again on a later approval", async () => {
    const { bb } = bbOf({ verdict: "non_trivial", messageSeq: 10 }, [lifecycle(8), lifecycle(9, "deny")]);
    expect(await reviewSize(bb, "thr_1", ["a.ts"], workspace([file("a.ts", 3, 2)]), 0)).toEqual({ trivial: false, blocker: true });
    const again = bbOf({ verdict: "non_trivial", messageSeq: 10 }, [lifecycle(8), lifecycle(9, "deny"), lifecycle(12)]);
    expect(await reviewSize(again.bb, "thr_1", ["a.ts"], workspace([file("a.ts", 3, 2)]), 0)).toEqual({ trivial: false, blocker: false });
  });

  it("neither walks nor blocks when a verdict carries no messageSeq", async () => {
    const { bb, walkStarts } = bbOf({ verdict: "non_trivial", messageSeq: null });
    expect(await reviewSize(bb, "thr_1", ["a.ts"], workspace([file("a.ts", 3, 2)]), 0)).toEqual({
      trivial: false,
      blocker: false,
    });
    expect(walkStarts).toEqual([]);
  });

  it("treats a question verdict as unsized without walking the plan window", async () => {
    const { bb, walkStarts } = bbOf({ verdict: "question", messageSeq: 10 });
    expect(await reviewSize(bb, "thr_1", ["a.ts"], workspace([file("a.ts", 3, 2)]), 0)).toEqual({
      trivial: false,
      blocker: false,
    });
    expect(walkStarts).toEqual([]);
  });

  it("keeps the missing-plan blocker and warns when the plan walk fails", async () => {
    // The blocker's condition already holds here; the walk only checks whether
    // a plan waives it, so a read failure must not waive it either.
    const { bb, warnings } = bbOf({ verdict: "non_trivial", messageSeq: 10 }, "throws");
    expect(await reviewSize(bb, "thr_1", ["a.ts"], workspace([file("a.ts", 3, 2)]), 0)).toEqual({
      trivial: false,
      blocker: true,
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("plan decisions");
    expect(warnings[0]).toContain("blocker fires");
    expect(warnings[0]).toContain("events down");
  });

  it("keeps the blocker when the plan walk fails for a lost verdict over the floor", async () => {
    const { bb, warnings } = bbOf("throws", "throws");
    expect(await reviewSize(bb, "thr_1", ["a.ts"], workspace([file("a.ts", 30, 30)]), 0)).toEqual({
      trivial: false,
      blocker: true,
    });
    // Both the sizing loss and the unreadable plan decisions warn.
    expect(warnings[0]).toContain("failed closed");
    expect(warnings[1]).toContain("blocker fires");
  });

  it("warns whatever the rpc throws, Error or not", async () => {
    const warnings: string[] = [];
    const bb = {
      log: { warn: (message: string) => warnings.push(message) },
      sdk: {
        plugins: {
          callRpc: async () => {
            throw "kaboom";
          },
        },
        threads: { events: { list: async () => [] } },
      },
    } as unknown as BbPluginApi;
    expect(await reviewSize(bb, "thr_1", ["a.ts"], workspace([file("a.ts", 3, 2)]), 0)).toEqual({
      trivial: false,
      blocker: false,
    });
    expect(warnings[0]).toContain("failed closed");
    expect(warnings[0]).toContain("kaboom");
  });

  it("keeps the blocker whatever the plan walk throws, Error or not", async () => {
    const warnings: string[] = [];
    const bb = {
      log: { warn: (message: string) => warnings.push(message) },
      sdk: {
        plugins: { callRpc: async () => ({ verdict: "non_trivial", messageSeq: 10 }) },
        threads: {
          events: {
            list: async () => {
              throw "kaboom";
            },
          },
        },
      },
    } as unknown as BbPluginApi;
    expect(await reviewSize(bb, "thr_1", ["a.ts"], workspace([file("a.ts", 3, 2)]), 0)).toEqual({
      trivial: false,
      blocker: true,
    });
    expect(warnings[0]).toContain("blocker fires");
    expect(warnings[0]).toContain("kaboom");
  });
});

describe("reviewSize's plan credits", () => {
  const over = workspace([file("a.ts", 30, 30)]);

  it("a held form approval clears the missing-plan blocker", async () => {
    const { bb } = bbOf({ verdict: "non_trivial", messageSeq: 10 }, [approvalForm(12)]);
    expect(await reviewSize(bb, "thr_1", ["a.ts"], over, 0)).toEqual({ trivial: false, blocker: false });
  });

  it("a held form approval from before the verdict clears it too: a follow-up keeps the plan's approval (thr_ztxgu84xib)", async () => {
    const { bb } = bbOf({ verdict: "non_trivial", messageSeq: 10 }, [approvalForm(8)]);
    expect(await reviewSize(bb, "thr_1", ["a.ts"], over, 0)).toEqual({ trivial: false, blocker: false });
  });

  it.each([
    ["missing", []],
    ["detached (thread-scoped)", [approvalForm(12, { kind: "thread" })]],
    // thr_w92i8w56wb: only an app answer is credited (bb core `answeredVia`); plugin fixtures, not core.
    ["without answeredVia", [approvalForm(12, { kind: "turn", turnId: "turn-1" }, {})]],
    ["answered via api", [approvalForm(12, { kind: "turn", turnId: "turn-1" }, { answeredVia: "api" })]],
    ["answered via an unexpected value (desktop)", [approvalForm(12, { kind: "turn", turnId: "turn-1" }, { answeredVia: "desktop" })]],
  ])("a form approval %s leaves the blocker", async (_name, rows) => {
    const { bb } = bbOf({ verdict: "non_trivial", messageSeq: 10 }, rows);
    expect(await reviewSize(bb, "thr_1", ["a.ts"], over, 0)).toEqual({ trivial: false, blocker: true });
  });

  it("an auto-approval recorded after the verdict clears the blocker", async () => {
    const { bb } = bbOf({ verdict: "non_trivial", messageSeq: 10 }, [], { presentPlanAutoApprovedSeq: 11 });
    expect(await reviewSize(bb, "thr_1", ["a.ts"], over, 0)).toEqual({ trivial: false, blocker: false });
  });

  it.each([
    ["at the verdict", { presentPlanAutoApprovedSeq: 10 }],
    ["before the verdict", { presentPlanAutoApprovedSeq: 4 }],
  ])("an auto-approval %s clears the blocker", async (_name, metadata) => {
    const { bb } = bbOf({ verdict: "non_trivial", messageSeq: 10 }, [], metadata);
    expect(await reviewSize(bb, "thr_1", ["a.ts"], over, 0)).toEqual({ trivial: false, blocker: false });
  });

  it.each([
    ["missing", {}],
    ["unparseable state", { phase: "bogus", presentPlanAutoApprovedSeq: 99 }],
  ])("an auto-approval %s leaves the blocker", async (_name, metadata) => {
    const { bb } = bbOf({ verdict: "non_trivial", messageSeq: 10 }, [], metadata);
    expect(await reviewSize(bb, "thr_1", ["a.ts"], over, 0)).toEqual({ trivial: false, blocker: true });
  });

  it("a failed state read keeps the blocker and warns", async () => {
    const { bb, warnings } = bbOf({ verdict: "non_trivial", messageSeq: 10 }, [], new Error("state down"));
    expect(await reviewSize(bb, "thr_1", ["a.ts"], over, 0)).toEqual({ trivial: false, blocker: true });
    expect(warnings[0]).toContain("blocker fires");
    expect(warnings[0]).toContain("state down");
  });
});
