import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { GateThreadLike, ReviewContext } from "./context.js";
import type { PlanApproval } from "./plan.js";
import { STALE_WINDOW_MS, type ThreadState } from "./state.js";
import { gatePlan } from "./plan-gate.js";

const lookups = vi.hoisted(() => ({
  approvePlan: vi.fn(),
  reapproveSamePlan: vi.fn(),
  answerPlanHoldQuestion: vi.fn(),
  captureSinceSeq: vi.fn(),
  tryCaptureSinceSeq: vi.fn(),
}));
vi.mock("./plan-approve.js", async (original) => ({
  ...(await original<typeof import("./plan-approve.js")>()),
  approvePlan: lookups.approvePlan,
  reapproveSamePlan: lookups.reapproveSamePlan,
}));
vi.mock("./plan-hold-answer.js", async (original) => ({
  ...(await original<typeof import("./plan-hold-answer.js")>()),
  answerPlanHoldQuestion: lookups.answerPlanHoldQuestion,
}));
vi.mock("./detect.js", async (original) => ({
  ...(await original<typeof import("./detect.js")>()),
  captureSinceSeq: lookups.captureSinceSeq,
  tryCaptureSinceSeq: lookups.tryCaptureSinceSeq,
}));

const PLAN = "/w/docs/plans/p.md";
const approval = (planFilePath: string | null = PLAN): PlanApproval =>
  ({ interactionId: "pint-1", plan: "# Plan", planFilePath, canApprove: true }) as PlanApproval;

/** The deny's hold message; matched by its marker so the test stays readable (the builder's own tests pin the wording). */
const DENY_MESSAGE = expect.stringMatching(/^\[bb auto-review\]/);

function fakeBb(seed: Record<string, unknown> = {}) {
  const warnings: string[] = [];
  const kv = new Map<string, unknown>();
  let metadata: Record<string, unknown> = { ...seed };
  const resolved: unknown[] = [];
  const deletedQueued: string[] = [];
  let children: unknown[] = [];
  let sendFails: unknown = undefined;
  let resolveFails: unknown = undefined;
  let deleteFails: unknown = undefined;
  let delivery: "queued" | "sent" = "queued";
  let writeIndex = 0;
  let failWriteAt = -1;
  let failWriteAs: unknown = new Error("metadata down");
  const bb = {
    sdk: {
      threads: {
        send: async () => {
          if (sendFails !== undefined) {
            throw sendFails;
          }
          return delivery === "queued"
            ? { delivery: "queued", queuedMessage: { id: "qm-1" } }
            : { delivery: "sent" };
        },
        list: async () => children,
        interactions: {
          resolve: async (args: unknown) => {
            if (resolveFails !== undefined) {
              throw resolveFails;
            }
            resolved.push(args);
            return {};
          },
        },
        queuedMessages: {
          list: async () => [{ id: "qm-1" }],
          delete: async ({ queuedMessageId }: { queuedMessageId: string }) => {
            if (deleteFails !== undefined) {
              throw deleteFails;
            }
            deletedQueued.push(queuedMessageId);
            return {};
          },
        },
        events: { list: async () => [] },
        getPluginMetadata: async () => metadata,
        updatePluginMetadata: async ({ set, remove }: { set?: Record<string, unknown>; remove?: string[] }) => {
          if (writeIndex === failWriteAt) {
            writeIndex += 1;
            throw failWriteAs;
          }
          writeIndex += 1;
          metadata = { ...metadata, ...(set ?? {}) };
          for (const key of remove ?? []) {
            delete metadata[key];
          }
          return { ...metadata };
        },
      },
    },
    storage: {
      kv: {
        get: async (key: string) => kv.get(key) ?? null,
        set: async (key: string, value: unknown) => {
          kv.set(key, value);
        },
        delete: async (key: string) => {
          kv.delete(key);
        },
        list: async (prefix: string) => [...kv.keys()].filter((key) => key.startsWith(prefix)),
      },
    },
    log: { warn: (message: string) => warnings.push(message), info: () => undefined },
  } as unknown as BbPluginApi;
  const ctx = {
    bb,
    settings: {},
    globals: { enabled: true, mergeEligibleMainlines: ["master"], reviewMode: "self" },
  } as unknown as ReviewContext;
  const thread = {
    id: "thr",
    projectId: "p",
    parentThreadId: null,
    originPluginId: null,
    visibility: "visible",
    environmentId: "env",
    providerId: "claude-code",
    archivedAt: null,
  } as unknown as GateThreadLike;
  return {
    bb,
    ctx,
    thread,
    warnings,
    kv,
    resolved,
    deletedQueued,
    metadata: () => metadata,
    failSend(next: unknown) {
      sendFails = next;
    },
    setChildren(next: unknown[]) {
      children = next;
    },
    failResolve(next: unknown) {
      resolveFails = next;
    },
    failDelete(next: unknown) {
      deleteFails = next;
    },
    setDelivery(next: "queued" | "sent") {
      delivery = next;
    },
    failWriteAt(index: number, as?: unknown) {
      failWriteAt = index;
      if (as !== undefined) {
        failWriteAs = as;
      }
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  lookups.reapproveSamePlan.mockResolvedValue(false);
  lookups.approvePlan.mockResolvedValue(true);
  lookups.captureSinceSeq.mockResolvedValue(7);
  lookups.tryCaptureSinceSeq.mockResolvedValue(9);
});

describe("gatePlan: a new cycle", () => {
  it("arms without a cursor when none can be read, queues the review and denies the plan", async () => {
    const f = fakeBb();
    lookups.tryCaptureSinceSeq.mockResolvedValueOnce(undefined);
    await gatePlan(f.ctx, f.thread, approval());
    expect(f.metadata().planReviewArmedAt).toBeGreaterThan(0);
    expect(f.metadata().planReviewArmedSeq).toBeUndefined();
    expect(f.metadata().planReviewEntryId).toBe("qm-1");
    expect(f.resolved).toEqual([
      { threadId: "thr", interactionId: "pint-1", resolution: { decision: "deny", message: DENY_MESSAGE } },
    ]);
    const fire = [...f.kv.keys()].find((key) => key.startsWith("lastfire:"));
    expect(f.kv.get(fire ?? "")).toMatchObject({ outcome: "fired", reason: "plan-review" });
  });

  it("reports a review it could not queue and disarms, whatever the error", async () => {
    const failing = fakeBb();
    failing.failSend(new Error("send down"));
    await gatePlan(failing.ctx, failing.thread, approval());
    expect(failing.warnings[0]).toContain("failed to queue the plan review for thr");
    expect(failing.warnings[0]).toContain("send down");
    expect(failing.metadata().planReviewArmedAt).toBeUndefined();
    const notAnError = fakeBb();
    notAnError.failSend("kaboom");
    await gatePlan(notAnError.ctx, notAnError.thread, approval());
    expect(notAnError.warnings[0]).toContain("kaboom");
    const fire = [...notAnError.kv.keys()].find((key) => key.startsWith("lastfire:"));
    expect(notAnError.kv.get(fire ?? "")).toMatchObject({ outcome: "stood-down", reason: "send-failed" });
  });

  it("records the delivery cursor when the review lands straight in the turn", async () => {
    const f = fakeBb();
    f.setDelivery("sent");
    await gatePlan(f.ctx, f.thread, approval());
    expect(f.metadata().planReviewDeliveredSeq).toBe(7);
    const failing = fakeBb();
    failing.setDelivery("sent");
    lookups.captureSinceSeq.mockRejectedValueOnce("kaboom");
    await gatePlan(failing.ctx, failing.thread, approval());
    expect(failing.warnings[0]).toContain("could not record where the plan review was delivered in thr");
    expect(failing.warnings[0]).toContain("kaboom");
    expect(failing.metadata().planReviewDeliveredSeq).toBeUndefined();
  });
});

describe("gatePlan: the deny", () => {
  it("arms the hold cursor after a deny, and reports failures on either write", async () => {
    const f = fakeBb();
    await gatePlan(f.ctx, f.thread, approval());
    expect(f.metadata().planDenied).toMatchObject({ sinceSeq: 7 });
    const failing = fakeBb();
    failing.failResolve(new Error("resolve down"));
    await gatePlan(failing.ctx, failing.thread, approval());
    expect(failing.warnings[0]).toContain("could not hold the plan for review in thr");
    expect(failing.warnings[0]).toContain("resolve down");
    expect(failing.metadata().planReviewArmedAt).toBeUndefined();
    const notAnError = fakeBb();
    notAnError.failResolve("kaboom");
    await gatePlan(notAnError.ctx, notAnError.thread, approval());
    expect(notAnError.warnings[0]).toContain("kaboom");
  });

  it("skips the hold cursor when it cannot be read, and still denies", async () => {
    const f = fakeBb();
    lookups.captureSinceSeq.mockRejectedValueOnce("cursor down");
    await gatePlan(f.ctx, f.thread, approval());
    expect(f.warnings[0]).toContain("could not capture a timeline cursor before denying the plan in thr");
    expect(f.warnings[0]).toContain("cursor down");
    expect(f.metadata().planDenied).toBeUndefined();
    expect(f.resolved).toHaveLength(1);
  });

  it("reports a planDenied latch it cannot arm and carries on", async () => {
    const f = fakeBb();
    f.failWriteAt(3);
    await gatePlan(f.ctx, f.thread, approval());
    expect(f.warnings[0]).toContain("could not arm the plan-hold answer cursor in thr");
    expect(f.resolved).toHaveLength(1);
    const notAnError = fakeBb();
    notAnError.failWriteAt(3, "kaboom");
    await gatePlan(notAnError.ctx, notAnError.thread, approval());
    expect(notAnError.warnings[0]).toContain("kaboom");
  });

  it("takes the failure branch when the user resolved the approval first, so the deny with its message fails (Part A's race)", async () => {
    const f = fakeBb();
    f.failResolve(new Error("409: the interaction is already resolved"));
    await gatePlan(f.ctx, f.thread, approval());
    expect(f.warnings[0]).toContain("could not hold the plan for review in thr");
    expect(f.warnings[0]).toContain("already resolved");
    expect(f.deletedQueued).toEqual(["qm-1"]);
    expect(f.metadata().planReviewArmedAt).toBeUndefined();
    expect(f.metadata().planReviewEntryId).toBeUndefined();
    const fire = [...f.kv.keys()].find((key) => key.startsWith("lastfire:"));
    expect(f.kv.get(fire ?? "")).toMatchObject({ outcome: "stood-down", reason: "send-failed" });
  });
});

describe("gatePlan: a held plan's second presentation", () => {
  it("withdraws a queued review whose hold expired, and stands the plan down", async () => {
    const f = fakeBb({
      planReviewArmedAt: Date.now() - STALE_WINDOW_MS - 1,
      planReviewEntryId: "qm-1",
    });
    await gatePlan(f.ctx, f.thread, approval());
    expect(f.deletedQueued).toEqual(["qm-1"]);
    expect(f.metadata().planReviewArmedAt).toBeUndefined();
    expect(f.metadata().planReviewEntryId).toBeUndefined();
    const fire = [...f.kv.keys()].find((key) => key.startsWith("lastfire:"));
    expect(f.kv.get(fire ?? "")).toMatchObject({ outcome: "stood-down", reason: "plan-hold-expired" });
  });

  it("reports a queued review it could not withdraw, whatever the error", async () => {
    const f = fakeBb({
      planReviewArmedAt: Date.now() - STALE_WINDOW_MS - 1,
      planReviewEntryId: "qm-1",
    });
    f.failDelete("kaboom");
    await gatePlan(f.ctx, f.thread, approval());
    expect(f.warnings[0]).toContain("could not withdraw the queued plan review qm-1 in thr");
    expect(f.warnings[0]).toContain("kaboom");
  });

  it("releases the reviewed plan when its queued row is gone", async () => {
    const f = fakeBb({ planReviewArmedAt: Date.now(), planReviewEntryId: "qm-gone", planReviewDeliveredSeq: 7 });
    f.bb.sdk.threads.queuedMessages.list = async () => [];
    await gatePlan(f.ctx, f.thread, approval());
    expect(f.metadata().planReviewArmedAt).toBeUndefined();
    expect(f.metadata().planReviewEntryId).toBeUndefined();
    expect(lookups.approvePlan).not.toHaveBeenCalled();
  });

  it("names a fileless plan by its interaction id when the review cannot be verified", async () => {
    const f = fakeBb({ planReviewArmedAt: Date.now() });
    (f.ctx as { globals: { reviewMode: string } }).globals.reviewMode = "devkit";
    await gatePlan(f.ctx, f.thread, approval(null));
    expect(f.warnings[0]).toContain("pint-1");
    expect(f.warnings[0]).toContain("could not verify");
  });
});

describe("onInteractionPending", () => {
  it("holds a plan approval that arrives on a gated thread, and ignores anything else", async () => {
    const f = fakeBb();
    const { onInteractionPending } = await import("./plan-gate.js");
    const interaction = {
      id: "pint-1",
      status: "pending",
      statusReason: null,
      payload: {
        kind: "approval",
        availableDecisions: ["allow_once", "deny"],
        reason: null,
        subject: { kind: "plan", itemId: "i", plan: "# Plan", planFilePath: "/w/docs/plans/p.md" },
      },
      resolution: null,
    };
    await onInteractionPending(f.ctx, { thread: f.thread, interaction } as never);
    expect(f.resolved).toEqual([
      expect.objectContaining({ interactionId: "pint-1", resolution: { decision: "deny", message: DENY_MESSAGE } }),
    ]);
    const other = fakeBb();
    await onInteractionPending(other.ctx, {
      thread: other.thread,
      interaction: {
        ...interaction,
        payload: { kind: "user_question", questions: [{ id: "q1", allowFreeText: true }] },
      },
    } as never);
    expect(other.resolved).toEqual([]);
    const ungated = fakeBb();
    await onInteractionPending(ungated.ctx, {
      thread: { ...ungated.thread, parentThreadId: "thr_p" },
      interaction,
    } as never);
    expect(ungated.resolved).toEqual([]);
  });
});

describe("gatePlan: the deny whose resolve fails as an Error", () => {
  it("reports the failure and disarms", async () => {
    const failing = fakeBb();
    failing.failResolve(new Error("settled elsewhere"));
    await gatePlan(failing.ctx, failing.thread, approval());
    expect(failing.warnings[0]).toContain("could not hold the plan for review in thr");
    expect(failing.warnings[0]).toContain("settled elsewhere");
    expect(failing.metadata().planReviewArmedAt).toBeUndefined();
  });

  it("reports a delivery cursor it cannot mark as an Error", async () => {
    const f = fakeBb();
    f.setDelivery("sent");
    lookups.captureSinceSeq.mockRejectedValue(new Error("timeline down"));
    await gatePlan(f.ctx, f.thread, approval());
    expect(f.warnings[0]).toContain("could not record where the plan review was delivered in thr");
    expect(f.warnings[0]).toContain("timeline down");
  });
});

describe("gatePlan: a sent review whose deny fails", () => {
  it("disarms without a queued review to withdraw", async () => {
    const f = fakeBb();
    f.setDelivery("sent");
    f.failResolve(new Error("settled elsewhere"));
    await gatePlan(f.ctx, f.thread, approval());
    expect(f.warnings[0]).toContain("could not hold the plan for review in thr");
    expect(f.deletedQueued).toEqual([]);
    expect(f.metadata().planReviewArmedAt).toBeUndefined();
  });
});

describe("gatePlan: the plan review's size tier and round tally", () => {
  const lines = (count: number) => Array.from({ length: count }, (_, index) => `line ${index}`).join("\n");
  const approvalWithPlan = (plan: string) => ({ ...approval(), plan }) as PlanApproval;
  /** A reviewer child that already finished, created after the arm (tests arm before calling this). */
  const child = (id: string, overrides: Record<string, unknown> = {}) => ({
    id,
    title: "review: senior-dev",
    createdAt: Date.now(),
    parentThreadId: "thr",
    originPluginId: null,
    status: "idle",
    archivedAt: 1,
    deletedAt: null,
    ...overrides,
  });
  const lastFire = (f: ReturnType<typeof fakeBb>) => {
    const key = [...f.kv.keys()].find((name) => name.startsWith("lastfire:"));
    return f.kv.get(key ?? "") as Record<string, unknown>;
  };
  const release = async (f: ReturnType<typeof fakeBb>, plan = "# Plan") => {
    f.bb.sdk.threads.queuedMessages.list = async () => [];
    await gatePlan(f.ctx, f.thread, approvalWithPlan(plan));
  };

  it("arms with the tier computed from the armed plan", async () => {
    const light = fakeBb();
    await gatePlan(light.ctx, light.thread, approvalWithPlan(lines(40)));
    expect(light.metadata().planReviewLight).toBe(true);
    const standard = fakeBb();
    await gatePlan(standard.ctx, standard.thread, approvalWithPlan(lines(41)));
    expect(standard.metadata().planReviewLight).toBe(false);
  });

  it("releases with the stored tier, not the re-presented plan's: a trimmed standard plan keeps budget 7", async () => {
    const f = fakeBb();
    await gatePlan(f.ctx, f.thread, approvalWithPlan(lines(41)));
    expect(f.metadata().planReviewLight).toBe(false);
    f.setChildren([child("r0"), child("r1"), child("r2"), child("r3")]);
    await release(f, lines(20));
    expect(lastFire(f)).toMatchObject({
      outcome: "stood-down",
      reason: "plan-reviewed",
      planReviewTier: "standard",
      planReviewerCount: 4,
    });
    // Four children pass a standard arm; a tier recomputed from the trimmed plan would have warned.
    expect(f.warnings).toEqual([]);
  });

  it("warns past the stored tier's budget: a light arm with four children", async () => {
    const f = fakeBb({ planReviewArmedAt: Date.now(), planReviewDeliveredSeq: 7, planReviewLight: true });
    f.setChildren([child("r0"), child("r1"), child("r2"), child("r3")]);
    await release(f);
    expect(f.warnings[0]).toContain("spawned 4 bb child threads since the arm, over the light budget of 3");
    expect(lastFire(f)).toMatchObject({ reason: "plan-reviewed", planReviewTier: "light", planReviewerCount: 4 });
  });

  it("gives an escalated standard arm the standard budget: six children pass", async () => {
    const f = fakeBb({ planReviewArmedAt: Date.now(), planReviewDeliveredSeq: 7, planReviewLight: false });
    f.setChildren(Array.from({ length: 6 }, (_, index) => child(`r${index}`)));
    await release(f);
    expect(f.warnings).toEqual([]);
    expect(lastFire(f)).toMatchObject({ planReviewTier: "standard", planReviewerCount: 6 });
  });

  it("counts null-titled children, naming ids only", async () => {
    const f = fakeBb({ planReviewArmedAt: Date.now(), planReviewDeliveredSeq: 7, planReviewLight: true });
    f.setChildren([
      child("r0", { title: null }),
      child("r1", { title: null }),
      child("r2", { title: null }),
      child("r3", { title: null }),
    ]);
    await release(f);
    expect(f.warnings[0]).toContain("r0, r1, r2, r3");
    // Ids only: the children's titles never appear.
    expect(f.warnings[0]).not.toContain("senior-dev");
    expect(lastFire(f)).toMatchObject({ planReviewerCount: 4 });
  });

  it("does not count children from before the arm, nor plugin-origin helpers", async () => {
    const f = fakeBb({ planReviewArmedAt: Date.now(), planReviewDeliveredSeq: 7, planReviewLight: true });
    f.setChildren([
      child("pre-arm", { createdAt: 0 }),
      child("helper", { originPluginId: "advisor" }),
      child("helper-2", { originPluginId: "advisor" }),
      child("helper-3", { originPluginId: "advisor" }),
      child("helper-4", { originPluginId: "advisor" }),
    ]);
    await release(f);
    expect(f.warnings).toEqual([]);
    expect(lastFire(f)).toMatchObject({ planReviewTier: "light", planReviewerCount: 0 });
  });

  it("recomputes the tier at a redo from the redo's own plan", async () => {
    const f = fakeBb();
    (f.ctx as { globals: { reviewMode: string } }).globals.reviewMode = "devkit";
    await gatePlan(f.ctx, f.thread, approvalWithPlan(lines(41)));
    expect(f.metadata().planReviewLight).toBe(false);
    await release(f, lines(20));
    expect(f.metadata().planReviewRedone).toBe(true);
    expect(f.metadata().planReviewLight).toBe(true);
  });

  it("re-arms the tally window at the redo: children from before it count nothing at release", async () => {
    const f = fakeBb();
    (f.ctx as { globals: { reviewMode: string } }).globals.reviewMode = "devkit";
    await gatePlan(f.ctx, f.thread, approvalWithPlan(lines(41)));
    await release(f, lines(20));
    f.setChildren(Array.from({ length: 4 }, (_, index) => child(`r${index}`, { createdAt: 0 })));
    await release(f, lines(20));
    // The redo's release legitimately warns of the missing skill load; the
    // tally itself stays under budget and silent.
    expect(f.warnings.some((message) => message.includes("over the light budget"))).toBe(false);
    expect(lastFire(f)).toMatchObject({ reason: "plan-review-incomplete", planReviewTier: "light", planReviewerCount: 0 });
  });

  it("carries the tally into the plan-hold-expired fire record", async () => {
    const f = fakeBb({
      planReviewArmedAt: Date.now() - STALE_WINDOW_MS - 1,
      planReviewEntryId: "qm-1",
      planReviewLight: true,
    });
    f.setChildren([child("r0"), child("r1"), child("r2"), child("r3")]);
    await gatePlan(f.ctx, f.thread, approval());
    expect(lastFire(f)).toMatchObject({
      outcome: "stood-down",
      reason: "plan-hold-expired",
      planReviewTier: "light",
      planReviewerCount: 4,
    });
    expect(f.warnings[0]).toContain("over the light budget of 3");
  });
});
