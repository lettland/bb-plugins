import { describe, expect, it } from "vitest";
import {
  passesThreadGate,
  planGateActive,
  planGateServes,
  PLAN_GATE_PROVIDER_ID,
  reviewInFlight,
  selfIsWorktree,
  type HeldReview,
} from "./gate.js";
import { STALE_WINDOW_MS, type AutoReviewPhase, type ThreadState } from "./state.js";

const okThread = {
  parentThreadId: null,
  originPluginId: null,
  visibility: "visible",
  environmentId: "env_1",
  providerId: PLAN_GATE_PROVIDER_ID,
};

describe("passesThreadGate", () => {
  it("passes a top-level, visible, environment-bound thread", () => {
    expect(passesThreadGate(okThread)).toBe(true);
  });

  it("skips child / subagent threads", () => {
    expect(passesThreadGate({ ...okThread, parentThreadId: "thr_p" })).toBe(false);
  });

  it("skips plugin/automation-spawned threads", () => {
    expect(passesThreadGate({ ...okThread, originPluginId: "workflows" })).toBe(
      false,
    );
  });

  it("skips hidden threads", () => {
    expect(passesThreadGate({ ...okThread, visibility: "hidden" })).toBe(false);
  });

  it("skips threads without an environment", () => {
    expect(passesThreadGate({ ...okThread, environmentId: null })).toBe(false);
  });
});

type Entries = Parameters<typeof selfIsWorktree>[0];

function entries(
  rows: Array<{ id: string; status: string; environmentIsWorktree?: boolean }>,
): Entries {
  return rows as unknown as Entries;
}

const NOW = STALE_WINDOW_MS * 10;

function held(
  phase: AutoReviewPhase,
  options: { busy?: boolean; dispatchedAt?: number } = {},
): HeldReview {
  return {
    busy: options.busy ?? false,
    state: {
      phase,
      ...(options.dispatchedAt === undefined
        ? {}
        : { dispatchedAt: options.dispatchedAt }),
    },
  };
}

describe("reviewInFlight", () => {
  it("ignores a busy thread that has no review of its own", () => {
    expect(reviewInFlight(held("idle", { busy: true }), NOW)).toBe(
      false,
    );
  });

  it("ignores a deferred sibling, busy or not", () => {
    expect(
      reviewInFlight(held("deferred", { busy: true }), NOW),
    ).toBe(false);
  });

  it("counts a running review", () => {
    expect(
      reviewInFlight(
        held("awaiting-review", { busy: true, dispatchedAt: NOW }),
        NOW,
      ),
    ).toBe(true);
  });

  it("counts a review dispatched before its thread reads as busy", () => {
    expect(
      reviewInFlight(
        held("awaiting-review", { dispatchedAt: NOW - 1_000 }),
        NOW,
      ),
    ).toBe(true);
  });

  it("counts a queued review", () => {
    expect(
      reviewInFlight(
        held("pending-dispatch", { dispatchedAt: NOW - 1_000 }),
        NOW,
      ),
    ).toBe(true);
  });

  it("keeps counting a long review while its thread is still busy", () => {
    expect(
      reviewInFlight(
        held("awaiting-review", {
          busy: true,
          dispatchedAt: NOW - STALE_WINDOW_MS - 1,
        }),
        NOW,
      ),
    ).toBe(true);
  });

  it("ignores an undated latch on a thread that is not busy", () => {
    expect(reviewInFlight(held("awaiting-review"), NOW)).toBe(false);
  });

  it("ignores a stale latch on a thread that is no longer busy", () => {
    expect(
      reviewInFlight(
        held("awaiting-review", {
          dispatchedAt: NOW - STALE_WINDOW_MS - 1,
        }),
        NOW,
      ),
    ).toBe(false);
  });
});

describe("selfIsWorktree", () => {
  it("reads the worktree flag off the thread's own entry", () => {
    const rows = entries([
      { id: "self", status: "idle", environmentIsWorktree: true },
      { id: "other", status: "idle", environmentIsWorktree: false },
    ]);
    expect(selfIsWorktree(rows, "self")).toBe(true);
    expect(selfIsWorktree(rows, "other")).toBe(false);
  });

  it("is false when the thread's entry is absent", () => {
    expect(
      selfIsWorktree(entries([{ id: "other", status: "idle" }]), "self"),
    ).toBe(false);
  });
});

const servingConfig = { enabled: true, skipped: false };

describe("planGateServes", () => {
  it("serves a top-level, enabled claude-code thread", () => {
    expect(planGateServes(okThread, servingConfig)).toBe(true);
  });

  it("stands down for a different provider (e.g. the ACP bridge)", () => {
    expect(
      planGateServes({ ...okThread, providerId: "acp-claude-work" }, servingConfig),
    ).toBe(false);
  });

  it("stands down for a skipped thread", () => {
    expect(
      planGateServes(okThread, { ...servingConfig, skipped: true }),
    ).toBe(false);
  });

  it("stands down when auto-review is disabled", () => {
    expect(
      planGateServes(okThread, { ...servingConfig, enabled: false }),
    ).toBe(false);
  });

  it("stands down for a child thread", () => {
    expect(
      planGateServes({ ...okThread, parentThreadId: "thr_p" }, servingConfig),
    ).toBe(false);
  });
});

const idleState: ThreadState = { phase: "idle" };

describe("planGateActive", () => {
  it("is true wherever the native gate already serves (claude-code)", () => {
    expect(planGateActive(okThread, servingConfig, idleState, NOW)).toBe(true);
  });

  it("is true on any other provider once PresentPlan reviewed a fresh plan", () => {
    const acpThread = { ...okThread, providerId: "acp-claude-work" };
    expect(planGateActive(acpThread, servingConfig, idleState, NOW)).toBe(false);
    expect(
      planGateActive(acpThread, servingConfig, { phase: "idle", planPresentedAt: NOW }, NOW),
    ).toBe(true);
  });

  it("is false once the PresentPlan review has gone stale", () => {
    const acpThread = { ...okThread, providerId: "acp-claude-work" };
    expect(
      planGateActive(
        acpThread,
        servingConfig,
        { phase: "idle", planPresentedAt: NOW - STALE_WINDOW_MS - 1 },
        NOW,
      ),
    ).toBe(false);
  });

  it("stands down for a skipped or disabled thread even with a fresh PresentPlan review", () => {
    const acpThread = { ...okThread, providerId: "acp-claude-work" };
    const presented: ThreadState = { phase: "idle", planPresentedAt: NOW };
    expect(planGateActive(acpThread, { ...servingConfig, skipped: true }, presented, NOW)).toBe(
      false,
    );
    expect(planGateActive(acpThread, { ...servingConfig, enabled: false }, presented, NOW)).toBe(
      false,
    );
  });

  it("stands down for a child thread even with a fresh PresentPlan review", () => {
    const childThread = { ...okThread, providerId: "acp-claude-work", parentThreadId: "thr_p" };
    expect(
      planGateActive(childThread, servingConfig, { phase: "idle", planPresentedAt: NOW }, NOW),
    ).toBe(false);
  });
});
