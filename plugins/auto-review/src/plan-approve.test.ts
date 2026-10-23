import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { describe, expect, it } from "vitest";
import type { GateThreadLike, ReviewContext } from "./context.js";
import { approvePlan, planHash, reapproveSamePlan } from "./plan-approve.js";
import type { PlanApproval } from "./plan.js";
import type { ThreadState } from "./state.js";

function threadOf(): GateThreadLike {
  return {
    id: "thr-1",
    projectId: "project-1",
    parentThreadId: null,
    originPluginId: null,
    visibility: "visible",
    environmentId: null,
    providerId: "claude-code",
    archivedAt: null,
  };
}

function approvalOf(id = "pint-2"): PlanApproval {
  return { interactionId: id, plan: "# Plan", planFilePath: null, canApprove: true };
}

/**
 * A thread namespace whose state lives in one record, with the interaction
 * round-trips beside it: `calls` records the order the metadata writes and the
 * resolve land in, `writes` every state patch, and `failWriteAt` makes the nth
 * write (0-based), or every resolve with `failResolve`, throw — as an `Error`
 * unless `failuresAs` says otherwise. `wipeListOnReread` empties the state a
 * second read sees, as a concurrent writer would.
 */
function fakeBb(
  options: {
    raw?: Record<string, unknown>;
    failWriteAt?: number[];
    failResolve?: boolean;
    failuresAs?: "error" | "string";
    wipeListOnReread?: boolean;
  } = {},
) {
  let raw: Record<string, unknown> = { ...options.raw };
  const calls: string[] = [];
  const writes: Array<{ set?: Record<string, unknown>; remove?: string[] }> = [];
  const resolves: Array<{ threadId: string; interactionId: string }> = [];
  const warnings: string[] = [];
  let writeIndex = 0;
  let reads = 0;
  const failure = (message: string): unknown =>
    options.failuresAs === "string" ? message : new Error(message);
  const bb = {
    sdk: {
      threads: {
        getPluginMetadata: async () => {
          reads += 1;
          return options.wipeListOnReread === true && reads > 1 ? {} : { ...raw };
        },
        updatePluginMetadata: async (args: { set?: Record<string, unknown>; remove?: string[] }) => {
          calls.push("metadata");
          if (options.failWriteAt?.includes(writeIndex) === true) {
            writeIndex += 1;
            throw failure("metadata write failed");
          }
          writeIndex += 1;
          writes.push(args);
          raw = { ...raw, ...args.set };
          for (const key of args.remove ?? []) {
            delete raw[key];
          }
          return {};
        },
        interactions: {
          resolve: async (args: { threadId: string; interactionId: string }) => {
            calls.push("resolve");
            if (options.failResolve === true) {
              throw failure("interaction already settled");
            }
            resolves.push(args);
            return {};
          },
          get: async () => {
            calls.push("interaction");
            return { status: "resolved", resolution: { decision: "allow_once", grantedPermissions: null } };
          },
        },
        events: {
          list: async () => {
            calls.push("events");
            return [];
          },
        },
      },
    },
    storage: { kv: { set: async () => {} } },
    log: {
      info: () => {},
      warn: (message: string) => warnings.push(message),
    },
  } as unknown as BbPluginApi;
  return { bb, calls, writes, resolves, warnings };
}

describe("approvePlan", () => {
  it("records the interaction id before the resolve", async () => {
    const fake = fakeBb();
    expect(await approvePlan({ bb: fake.bb } as ReviewContext, threadOf(), approvalOf())).toBe(true);
    expect(fake.calls).toEqual(["metadata", "resolve"]);
    expect(fake.writes[0]).toMatchObject({ set: { autoResolvedPlanIds: ["pint-2"] } });
  });

  it("keeps the last 10 ids, read fresh from the state it writes", async () => {
    const older = Array.from({ length: 10 }, (_, index) => `pint-old-${index}`);
    const fake = fakeBb({ raw: { autoResolvedPlanIds: older } });
    await approvePlan({ bb: fake.bb } as ReviewContext, threadOf(), approvalOf());
    expect(fake.writes[0]?.set?.autoResolvedPlanIds).toEqual([...older.slice(1), "pint-2"]);
  });

  it("removes the recorded id again when the resolve fails", async () => {
    const fake = fakeBb({ failResolve: true });
    expect(await approvePlan({ bb: fake.bb } as ReviewContext, threadOf(), approvalOf())).toBe(false);
    expect(fake.calls).toEqual(["metadata", "resolve", "metadata"]);
    expect(fake.writes.at(-1)?.set?.autoResolvedPlanIds).toEqual([]);
    expect(fake.warnings.some((message) => message.includes("could not auto-approve"))).toBe(true);
  });

  it("removes only the resolved id and keeps the rest when the resolve fails", async () => {
    const fake = fakeBb({ raw: { autoResolvedPlanIds: ["pint-other"] }, failResolve: true });
    expect(await approvePlan({ bb: fake.bb } as ReviewContext, threadOf(), approvalOf())).toBe(false);
    expect(fake.writes.at(-1)?.set?.autoResolvedPlanIds).toEqual(["pint-other"]);
  });

  it("unrecords against a state without the list, as a concurrent writer leaves it", async () => {
    const fake = fakeBb({ failResolve: true, wipeListOnReread: true });
    expect(await approvePlan({ bb: fake.bb } as ReviewContext, threadOf(), approvalOf())).toBe(false);
    expect(fake.calls).toEqual(["metadata", "resolve", "metadata"]);
    expect(fake.writes.at(-1)?.set?.autoResolvedPlanIds).toEqual([]);
  });

  it("warns the failure lead when the resolve rejects with something that is not an Error", async () => {
    const fake = fakeBb({ failResolve: true, failuresAs: "string" });
    expect(await approvePlan({ bb: fake.bb } as ReviewContext, threadOf(), approvalOf())).toBe(false);
    expect(
      fake.warnings.some((message) => message.includes("could not auto-approve") && message.includes("interaction already settled")),
    ).toBe(true);
  });

  it("warns with the interaction id when the removal rejects with something that is not an Error", async () => {
    const fake = fakeBb({ failResolve: true, failWriteAt: [1], failuresAs: "string" });
    expect(await approvePlan({ bb: fake.bb } as ReviewContext, threadOf(), approvalOf())).toBe(false);
    expect(fake.warnings.some((message) => message.includes("pint-2") && message.includes("could not unrecord"))).toBe(true);
    expect(fake.warnings.some((message) => message.includes("could not auto-approve"))).toBe(true);
  });

  it("leaves the plan with the user when the pre-resolve write throws", async () => {
    const fake = fakeBb({ failWriteAt: [0] });
    expect(await approvePlan({ bb: fake.bb } as ReviewContext, threadOf(), approvalOf())).toBe(false);
    expect(fake.calls).toEqual(["metadata"]);
    expect(fake.resolves).toHaveLength(0);
    expect(fake.warnings.some((message) => message.includes("could not auto-approve"))).toBe(true);
  });

  it("warns with the interaction id and still leaves the plan with the user when the removal throws", async () => {
    const fake = fakeBb({ failResolve: true, failWriteAt: [1] });
    expect(await approvePlan({ bb: fake.bb } as ReviewContext, threadOf(), approvalOf())).toBe(false);
    expect(fake.calls).toEqual(["metadata", "resolve", "metadata"]);
    expect(fake.warnings.some((message) => message.includes("pint-2") && message.includes("could not unrecord"))).toBe(true);
    expect(fake.warnings.some((message) => message.includes("could not auto-approve"))).toBe(true);
  });
});

describe("reapproveSamePlan", () => {
  const state = {
    phase: "idle",
    planReleased: { interactionId: "pint-1", planHash: planHash("# Plan"), releasedSeq: 5 },
  } as ThreadState;

  it("records the interaction id before the resolve", async () => {
    const fake = fakeBb();
    expect(await reapproveSamePlan({ bb: fake.bb } as ReviewContext, threadOf(), state, approvalOf())).toBe(true);
    // The release record goes first; the id is written only just before the resolve.
    expect(fake.calls).toEqual(["metadata", "interaction", "events", "metadata", "resolve"]);
    expect(fake.writes.at(-1)).toMatchObject({ set: { autoResolvedPlanIds: ["pint-2"] } });
  });

  it("removes the recorded id again when the resolve fails", async () => {
    const fake = fakeBb({ failResolve: true });
    expect(await reapproveSamePlan({ bb: fake.bb } as ReviewContext, threadOf(), state, approvalOf())).toBe(false);
    expect(fake.calls).toEqual(["metadata", "interaction", "events", "metadata", "resolve", "metadata"]);
    expect(fake.writes.at(-1)?.set?.autoResolvedPlanIds).toEqual([]);
    expect(fake.warnings.some((message) => message.includes("could not re-approve"))).toBe(true);
  });
});
