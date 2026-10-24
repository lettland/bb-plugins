import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { GateThreadLike, ReviewContext } from "./context.js";
import { PLAN_DENY_ANSWER_WINDOW_MS, type ThreadState } from "./state.js";
import { answerPlanHoldQuestion } from "./plan-hold-answer.js";
import type { PendingUserQuestion } from "./plan.js";

const lookups = vi.hoisted(() => ({
  isImmediateReactionToDeny: vi.fn(),
}));
vi.mock("./plan.js", async (original) => ({
  ...(await original<typeof import("./plan.js")>()),
  isImmediateReactionToDeny: lookups.isImmediateReactionToDeny,
}));

const question: PendingUserQuestion = { interactionId: "pint-1", questionIds: ["q1"] };

function fakeBb(seed: Record<string, unknown> = {}) {  const warnings: string[] = [];
  const infos: string[] = [];
  const kvWrites: Array<[string, unknown]> = [];
  let metadata: Record<string, unknown> = { ...seed };
  let events: Array<Record<string, unknown>> = [];
  const resolved: unknown[] = [];
  let eventsFail: unknown = undefined;
  let resolveFail: unknown = undefined;
  const bb = {
    sdk: {
      threads: {
        events: {
          list: async () => {
            if (eventsFail !== undefined) {
              throw eventsFail;
            }
            return events;
          },
        },
        interactions: {
          resolve: async (args: unknown) => {
            if (resolveFail !== undefined) {
              throw resolveFail;
            }
            resolved.push(args);
            return {};
          },
        },
        getPluginMetadata: async () => metadata,
        updatePluginMetadata: async ({ set, remove }: { set?: Record<string, unknown>; remove?: string[] }) => {
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
        get: async () => undefined,
        set: async (key: string, value: unknown) => {
          kvWrites.push([key, value]);
        },
        delete: async () => undefined,
        list: async () => [] as string[],
      },
    },
    log: {
      warn: (message: string) => warnings.push(message),
      info: (message: string) => infos.push(message),
    },
  } as unknown as BbPluginApi;
  const ctx = { bb, settings: {}, globals: { enabled: true, mergeEligibleMainlines: ["master"], reviewMode: "auto" } } as unknown as ReviewContext;
  const thread = { id: "thr", projectId: "p", environmentId: "env", providerId: "claude-code" } as unknown as GateThreadLike;
  return {
    bb,
    ctx,
    thread,
    warnings,
    infos,
    kvWrites,
    resolved,
    metadata: () => metadata,
    setEvents(next: Array<Record<string, unknown>>) {
      events = next;
    },
    failEvents(next: unknown) {
      eventsFail = next;
    },
    failResolve(next: unknown) {
      resolveFail = next;
    },
  };
}

const deniedState = (at: number) => ({ phase: "idle", planDenied: { at, sinceSeq: 5 } }) as ThreadState;


beforeEach(() => {
  vi.clearAllMocks();
  lookups.isImmediateReactionToDeny.mockReturnValue(true);
});

describe("answerPlanHoldQuestion", () => {
  it("does nothing without a held deny", async () => {
    const f = fakeBb();
    await answerPlanHoldQuestion(f.ctx, f.thread, question);
    expect(f.resolved).toEqual([]);
    expect(f.metadata().planDenied).toBeUndefined();
  });

  it("removes a stale deny but leaves the question with the user", async () => {
    const stale = fakeBb({ planDenied: { at: Date.now() - PLAN_DENY_ANSWER_WINDOW_MS - 1, sinceSeq: 5 } });
    await answerPlanHoldQuestion(stale.ctx, stale.thread, question);
    expect(stale.metadata().planDenied).toBeUndefined();
    expect(stale.resolved).toEqual([]);
    expect(stale.kvWrites).toEqual([]);
  });

  it("leaves the question with the user when the project turned auto-review off", async () => {
    const off = fakeBb({ planDenied: { at: Date.now(), sinceSeq: 5 } });
    (off.ctx as { globals: { enabled: boolean } }).globals.enabled = false;
    await answerPlanHoldQuestion(off.ctx, off.thread, question);
    expect(off.metadata().planDenied).toBeUndefined();
    expect(off.resolved).toEqual([]);
  });

  it("reports an unread log and leaves the question, whatever the error", async () => {
    const error = fakeBb({ planDenied: { at: Date.now(), sinceSeq: 5 } });
    error.failEvents(new Error("events down"));
    await answerPlanHoldQuestion(error.ctx, error.thread, question);
    expect(error.resolved).toEqual([]);
    expect(error.warnings[0]).toContain("events down");
    const notAnError = fakeBb({ planDenied: { at: Date.now(), sinceSeq: 5 } });
    notAnError.failEvents("kaboom");
    await answerPlanHoldQuestion(notAnError.ctx, notAnError.thread, question);
    expect(notAnError.warnings[0]).toContain("kaboom");
  });

  it("leaves the question when real tool work followed the deny, or a full page came back", async () => {
    const busy = fakeBb({ planDenied: { at: Date.now(), sinceSeq: 5 } });
    lookups.isImmediateReactionToDeny.mockReturnValueOnce(false);
    await answerPlanHoldQuestion(busy.ctx, busy.thread, question);
    expect(busy.resolved).toEqual([]);
    const fullPage = fakeBb({ planDenied: { at: Date.now(), sinceSeq: 5 } });
    fullPage.setEvents(Array.from({ length: 100 }, () => ({})));
    await answerPlanHoldQuestion(fullPage.ctx, fullPage.thread, question);
    expect(fullPage.resolved).toEqual([]);
    expect(lookups.isImmediateReactionToDeny).toHaveBeenCalledTimes(1);
  });

  it("a failed resolve leaves the question, whatever the error", async () => {
    const error = fakeBb({ planDenied: { at: Date.now(), sinceSeq: 5 } });
    error.failResolve(new Error("resolve down"));
    await answerPlanHoldQuestion(error.ctx, error.thread, question);
    expect(error.warnings[0]).toContain("resolve down");
    const notAnError = fakeBb({ planDenied: { at: Date.now(), sinceSeq: 5 } });
    notAnError.failResolve("kaboom");
    await answerPlanHoldQuestion(notAnError.ctx, notAnError.thread, question);
    expect(notAnError.warnings[0]).toContain("kaboom");
  });

  it("answers an immediate question in the user's name and records the fire", async () => {
    const f = fakeBb({ planDenied: { at: Date.now(), sinceSeq: 5 } });
    await answerPlanHoldQuestion(f.ctx, f.thread, question);
    expect(f.resolved).toEqual([
      {
        threadId: "thr",
        interactionId: "pint-1",
        resolution: {
          kind: "user_answer",
          answers: { q1: { selected: [], freeText: expect.stringContaining("Automatic answer") } },
        },
      },
    ]);
    expect(f.infos[0]).toContain("auto-answered the plan-hold question pint-1");
    const fire = f.kvWrites.find(([key]) => key === "lastfire:p:thr");
    expect(fire?.[1]).toMatchObject({ outcome: "fired", reason: "plan-hold-answered" });
  });
});
