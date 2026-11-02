import { describe, expect, it } from "vitest";
import { createFakePluginHost, type CreateFakePluginHostOptions } from "@get-bb/plugin-sdk/testing";
import { createReviewContext, type EffectiveConfig } from "./context.js";
import { commitScanHead, committedSinceHead, devkitRunning, dispatchReview } from "./dispatch.js";
import { buildReviewPrompt, renderScope, type ReviewMode } from "./prompt.js";
import type { ThreadState } from "./state.js";

const state = {
  turnStart: { sinceSeq: 0, startedAt: 1_000, tree: { headSha: "0123abcd", files: {}, commits: [] } },
} as unknown as ThreadState;

type MetadataCall = { set?: Record<string, unknown>; remove?: string[] };

/** A resolved plan-approval lifecycle row for the dispatch-time plan window. */
const lifecycle = (seq: number, decision = "allow_once") => ({
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

/**
 * Drives one `dispatchReview` over thread `thr_1` against a fake host. The sdk
 * stubs nest by path; an unset rpc, event log, or workspace stays unstubbed,
 * so sizing and the baseline fail closed the way production sees a missing
 * plugin. `body` receives the metadata writes and the text of every sent turn.
 */
async function withDispatch(
  options: {
    reviewMode: ReviewMode;
    plugins: unknown[] | "throws";
    pluginsThrowAs?: unknown;
    timelineThrows?: boolean;
    sendThrows?: unknown;
    /** Extra sdk stubs, such as `environments`, for a test that drives the workspace reads. */
    environments?: Record<string, unknown>;
    /** The `changeSize` rpc verdict, or "throws" for a failing rpc; unset leaves it unstubbed, so sizing fails closed. */
    callRpc?: unknown | "throws";
    /** The `system/interaction/lifecycle` rows the plan window may read, or "throws"; unset leaves the log empty. */
    events?: Array<Record<string, unknown>> | "throws";
    /** The cursor the previous code review captured before its send: the reviewed window's start. */
    lastCodeReviewSeq?: number;
    /** The turn's files in scope. Default: one file, `a.ts`. */
    scope?: string[];
  },
  body: (
    calls: MetadataCall[],
    bb: Awaited<ReturnType<typeof createFakePluginHost>>["bb"],
    sent: string[],
  ) => Promise<void>,
) {
  const calls: MetadataCall[] = [];
  const sent: string[] = [];
  const sdk = {
    plugins: {
      list: async () => {
        if (options.pluginsThrowAs !== undefined) {
          throw options.pluginsThrowAs;
        }
        if (options.plugins === "throws") {
          throw new Error("plugin list unavailable");
        }
        return { plugins: options.plugins };
      },
      callRpc: async (args: { method: string }) => {
        if (options.callRpc === undefined) {
          throw new Error(`no ${args.method} rpc stub`);
        }
        if (options.callRpc === "throws") {
          throw new Error("change-size rpc down");
        }
        return options.callRpc;
      },
    },
    threads: {
      timeline: async () => {
        if (options.timelineThrows === true) {
          throw new Error("timeline down");
        }
        return { rows: [], maxSeq: 500 };
      },
      updatePluginMetadata: async (args: MetadataCall) => {
        calls.push(args);
        return {};
      },
      send: async (args: { input: Array<{ text: string }> }) => {
        sent.push(args.input[0].text);
        if (options.sendThrows !== undefined) {
          throw options.sendThrows;
        }
        return { delivery: "queued", queuedMessage: { id: "qm-1" } };
      },
      events: {
        list: async (args: { afterSeq?: string; types?: string[]; limit?: string }) => {
          if (options.events === "throws") {
            throw new Error("events down");
          }
          return (options.events ?? [])
            .filter(
              (row) =>
                Number(row.seq) > Number(args.afterSeq ?? 0) && args.types?.includes(String(row.type)) !== false,
            )
            .slice(0, Number(args.limit));
        },
      },
    },
    // An undefined value is fine: the fake sdk ignores an override that is no object.
    environments: options.environments,
  } as unknown as CreateFakePluginHostOptions["sdk"];
  const host = createFakePluginHost({ pluginId: "auto-review", sdk, agentSkillIds: ["auto-review"] });
  try {
    await dispatchReview(await createReviewContext(host.bb), {
      thread: {
        parentThreadId: null,
        originPluginId: null,
        visibility: "public",
        environmentId: null,
        providerId: "prov-1",
        archivedAt: null,
        id: "thr_1",
        projectId: "project-1",
      },
      state: {
        ...(options.lastCodeReviewSeq === undefined ? {} : { lastCodeReviewSeq: options.lastCodeReviewSeq }),
      } as ThreadState,
      environmentId: "env-1",
      config: { reviewMode: options.reviewMode } as EffectiveConfig,
      decision: { commit: true, merge: false },
      base: "main",
      isWorktree: false,
      scope: options.scope ?? ["a.ts"],
      turn: { paths: ["a.ts"], commits: [], committedPaths: [], foreignCommits: [], upstreamCommits: [], parkedCommits: [], parkedPaths: [] },
    });
    await body(calls, host.bb, sent);
  } finally {
    await host.harness.dispose();
  }
}

describe("committedSinceHead", () => {
  it("gives the turn-start head when the turn made commits", () => {
    const turn = { paths: ["a.ts"], commits: ["c1"], committedPaths: ["a.ts"], foreignCommits: [], upstreamCommits: [], parkedCommits: [], parkedPaths: [] };
    expect(committedSinceHead(turn, state)).toBe("0123abcd");
  });

  it("still gives the head for a commit whose paths could not be read", () => {
    const turn = { paths: [], commits: ["unread"], committedPaths: [], foreignCommits: [], upstreamCommits: [], parkedCommits: [], parkedPaths: [] };
    expect(committedSinceHead(turn, state)).toBe("0123abcd");
  });

  it("gives no committed range when the turn made no commits", () => {
    const turn = { paths: ["a.ts"], commits: [], committedPaths: [], foreignCommits: [], upstreamCommits: [], parkedCommits: [], parkedPaths: [] };
    const committedSince = committedSinceHead(turn, state);
    expect(committedSince).toBeNull();
    const text = buildReviewPrompt({
      decision: { commit: true, merge: false },
      reviewMode: "auto",
      scope: renderScope(["a.ts"]),
      committedSince,
      aislopScan: true,
    });
    expect(text).not.toContain("0123abcd");
    expect(text).not.toContain("Do not amend");
    expect(text).toContain("`bb aislop scan`");
  });
});

describe("a turn that made only another thread's commits", () => {
  const turn = {
    paths: ["a.ts"],
    commits: [],
    committedPaths: [],
    foreignCommits: [{ sha: "abcdef1", threadId: "thr_sibling" }],
    upstreamCommits: [],
    parkedCommits: [],
    parkedPaths: [],
  };

  it("has no committed range of its own but scans from the turn-start head", () => {
    expect(committedSinceHead(turn, state)).toBeNull();
    expect(commitScanHead(turn, state)).toBe("0123abcd");
  });

  it("names the foreign commits in the prompt and words the scan for both threads", () => {
    const text = buildReviewPrompt({
      decision: { commit: true, merge: false },
      reviewMode: "auto",
      scope: renderScope(["a.ts"]),
      committedSince: committedSinceHead(turn, state),
      commitScanFrom: commitScanHead(turn, state),
      foreignCommits: turn.foreignCommits.map(({ sha }) => sha),
    });
    expect(text).toContain("made this commit during this turn: abcdef1.");
    expect(text).toContain("Scan the commits the other thread made this turn too (`git diff 0123abcd..HEAD`)");
    expect(text).not.toContain("yours and the other thread's");
    expect(text).not.toContain("thr_sibling");
    expect(text).not.toContain("Do not amend");
  });

  it("scans from the head for a mix of own and foreign commits and keeps the own range", () => {
    const mixed = { ...turn, commits: ["c1"], committedPaths: ["a.ts"] };
    expect(committedSinceHead(mixed, state)).toBe("0123abcd");
    expect(commitScanHead(mixed, state)).toBe("0123abcd");
  });

  it("does not widen the scan for a head that moved without a commit of the turn", () => {
    const moved = { paths: ["a.ts"], commits: [], committedPaths: [], foreignCommits: [], upstreamCommits: [], parkedCommits: [], parkedPaths: [] };
    expect(commitScanHead(moved, state)).toBeNull();
  });

  it("scans nothing for a turn whose only commits arrived with the remote base", () => {
    const pulled = { paths: ["a.ts"], commits: [], committedPaths: [], foreignCommits: [], upstreamCommits: ["abcdef1"], parkedCommits: [], parkedPaths: [] };
    expect(committedSinceHead(pulled, state)).toBeNull();
    expect(commitScanHead(pulled, state)).toBeNull();
  });
});

describe("a turn whose only commits arrived while it waited in the review queue", () => {
  const turn = {
    paths: ["a.ts"],
    commits: [],
    committedPaths: [],
    foreignCommits: [],
    upstreamCommits: [],
    parkedCommits: ["abcdef1"],
    parkedPaths: ["lib/new.ts"],
  };
  const prompt = (merge: boolean) =>
    buildReviewPrompt({
      decision: { commit: true, merge },
      reviewMode: "auto",
      scope: renderScope(["a.ts"]),
      committedSince: committedSinceHead(turn, state),
      commitScanFrom: commitScanHead(turn, state),
      parkedCommits: turn.parkedCommits,
    });

  it("scans from the turn-start head but has no committed range of its own", () => {
    expect(committedSinceHead(turn, state)).toBeNull();
    expect(commitScanHead(turn, state)).toBe("0123abcd");
  });

  it("names them neutrally, reports a secret in them without a STOP, and leaves their files out", () => {
    const text = prompt(true);
    expect(text).toContain("This commit arrived while this turn waited in the review queue: abcdef1.");
    expect(text).toContain("Someone else made it");
    expect(text).toContain("Scan the other commits in that range too (`git diff 0123abcd..HEAD`); a secret found there is not yours: report it by file:line and type, never by value, and do not rewrite history. Do not STOP for it: still commit your own work and skip the merge in step 8, saying so in your reply.");
    expect(text).not.toContain("is already committed, so STOP");
    expect(text).toContain("Leave out the files of the commits that arrived while this turn waited named above");
    expect(text).not.toContain("Do not amend");
  });

  it("scans the other commits as well as the turn's own when it made some", () => {
    const mixed = { ...turn, commits: ["c1"], committedPaths: ["a.ts"] };
    const text = buildReviewPrompt({
      decision: { commit: true, merge: false },
      reviewMode: "auto",
      scope: renderScope(["a.ts"]),
      committedSince: committedSinceHead(mixed, state),
      commitScanFrom: commitScanHead(mixed, state),
      parkedCommits: mixed.parkedCommits,
    });
    expect(text).toContain("yours and the other commits in that range (`git diff 0123abcd..HEAD`); a secret found in one of your commits is already committed, so STOP");
    expect(text).toContain("It may appear in the range after 0123abcd; it is still not this thread's.");
  });

  it("leaves a value that is not shaped like a commit out of the prompt", () => {
    const text = buildReviewPrompt({
      decision: { commit: true, merge: false },
      reviewMode: "auto",
      scope: renderScope(["a.ts"]),
      commitScanFrom: "0123abcd",
      parkedCommits: ["not a sha; rm -rf"],
    });
    expect(text).not.toContain("rm -rf");
    expect(text).not.toContain("waited in the review queue");
  });
});

describe("devkitRunning", () => {
  type Entry = { enabled: boolean; status: string; cliCommand: { name: string } | null };
  function pluginsBb(plugins: Entry[] | "throws") {
    const warnings: string[] = [];
    const bb = {
      log: { warn: (message: string) => warnings.push(message) },
      sdk: {
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
    return { bb: bb as never, warnings };
  }
  const devkit: Entry = { enabled: true, status: "running", cliCommand: { name: "devkit" } };

  it("is running for an enabled, running plugin that serves `bb devkit`", async () => {
    expect(await devkitRunning(pluginsBb([devkit]).bb)).toBe("running");
  });

  it("is absent when no such plugin is enabled and running", async () => {
    expect(await devkitRunning(pluginsBb([]).bb)).toBe("absent");
    expect(await devkitRunning(pluginsBb([{ ...devkit, enabled: false }]).bb)).toBe("absent");
    expect(await devkitRunning(pluginsBb([{ ...devkit, status: "stopped" }]).bb)).toBe("absent");
    expect(await devkitRunning(pluginsBb([{ ...devkit, cliCommand: null }]).bb)).toBe("absent");
    expect(await devkitRunning(pluginsBb([{ ...devkit, cliCommand: { name: "aislop" } }]).bb)).toBe("absent");
  });

  it("is unknown, with a warning, when the lookup fails", async () => {
    const { bb, warnings } = pluginsBb("throws");
    expect(await devkitRunning(bb)).toBe("unknown");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("could not list plugins");
  });
});

describe("the review-code latch in sendReview", () => {
  const devkit = { enabled: true, status: "running", cliCommand: { name: "devkit" } };

  it("latches reviewSkillRequired in devkit mode, with the cursor in the same write", async () => {
    await withDispatch({ reviewMode: "devkit", plugins: [] }, async (calls) => {
      expect(calls[0].set).toMatchObject({
        phase: "awaiting-review",
        dispatchedAt: expect.any(Number),
        lastCodeReviewSeq: 500,
        reviewSkillRequired: true,
      });
      expect(calls[0].remove).not.toContain("reviewSkillRequired");
    });
  });

  it("latches reviewSkillRequired when auto mode finds devkit running", async () => {
    await withDispatch({ reviewMode: "auto", plugins: [devkit] }, async (calls) => {
      expect(calls[0].set).toMatchObject({ phase: "awaiting-review", lastCodeReviewSeq: 500, reviewSkillRequired: true });
      expect(calls[0].remove).not.toContain("reviewSkillRequired");
    });
  });

  it("clears reviewSkillRequired when auto mode finds devkit absent", async () => {
    await withDispatch({ reviewMode: "auto", plugins: [] }, async (calls) => {
      expect(calls[0].set).toMatchObject({ phase: "awaiting-review", lastCodeReviewSeq: 500 });
      expect(calls[0].set?.reviewSkillRequired).toBeUndefined();
      expect(calls[0].remove).toContain("reviewSkillRequired");
    });
  });

  it("clears reviewSkillRequired when auto mode cannot tell whether devkit is running", async () => {
    await withDispatch({ reviewMode: "auto", plugins: "throws" }, async (calls) => {
      expect(calls[0].set).toMatchObject({ phase: "awaiting-review", lastCodeReviewSeq: 500 });
      expect(calls[0].set?.reviewSkillRequired).toBeUndefined();
      expect(calls[0].remove).toContain("reviewSkillRequired");
    });
  });

  it("clears reviewSkillRequired in self mode, without asking whether devkit runs", async () => {
    await withDispatch({ reviewMode: "self", plugins: [devkit] }, async (calls) => {
      expect(calls[0].set).toMatchObject({ phase: "awaiting-review", lastCodeReviewSeq: 500 });
      expect(calls[0].set?.reviewSkillRequired).toBeUndefined();
      expect(calls[0].remove).toContain("reviewSkillRequired");
    });
  });

  it("stages a pending baseline on a commit-policy dispatch too", async () => {
    await withDispatch(
      {
        reviewMode: "auto",
        plugins: [],
        environments: {
          status: async () => ({
            outcome: "available",
            workspace: {
              checkout: { kind: "branch", headSha: "0123abcd" },
              workingTree: { files: [{ path: "a.ts", status: "M" }] },
            },
          }),
          diffFile: async ({ path }: { path: string }) => ({
            path,
            content: "a1\n",
            contentEncoding: "utf8",
            sizeBytes: 3,
          }),
        },
      },
      async (_calls, bb) => {
        expect(await bb.storage.kv.get("baseline:code:thr_1")).toMatchObject({
          pending: { headSha: "0123abcd", files: { "a.ts": "a1\n" } },
        });
      },
    );
  });
});

describe("dispatchReview when the reads or the send fail", () => {
  const THREAD_ID = "thr_1";
  const devkit = { enabled: true, status: "running", cliCommand: { name: "devkit" } };

  it("dispatches without a cursor when the timeline cannot be read", async () => {
    await withDispatch({ reviewMode: "devkit", plugins: [], timelineThrows: true }, async (calls) => {
      expect(calls[0].set).toMatchObject({ phase: "awaiting-review", reviewSkillRequired: true });
      expect(calls[0].set?.lastCodeReviewSeq).toBeUndefined();
    });
  });

  it("treats an unreadable plugin list as unknown, whatever the error", async () => {
    await withDispatch({ reviewMode: "auto", plugins: [], pluginsThrowAs: "kaboom" }, async (calls) => {
      expect(calls[0].set).toMatchObject({ phase: "awaiting-review" });
      expect(calls[0].set?.reviewSkillRequired).toBeUndefined();
      expect(calls[0].remove).toContain("reviewSkillRequired");
    });
  });

  it("resets the latch and records the failure when the send fails, whatever the error", async () => {
    await withDispatch({ reviewMode: "devkit", plugins: [], sendThrows: "kaboom" }, async (calls, bb) => {
      expect(calls[0].set).toMatchObject({ phase: "awaiting-review" });
      expect(calls.at(-1)?.set).toMatchObject({ phase: "idle" });
      expect(calls.at(-1)?.remove).toContain("lastCodeReviewSeq");
      const store = (await bb.storage.kv.get(`findings:${THREAD_ID}`)) as {
        lastReport?: { outcome: string };
        incidents?: Array<{ kind: string; detail: string }>;
      };
      expect(store.lastReport).toMatchObject({ outcome: "unavailable" });
      expect(store.incidents).toEqual([expect.objectContaining({ kind: "send-failed", detail: "kaboom" })]);
    });
  });
});

describe("dispatchReview sizes the change before it dispatches", () => {
  const BLOCKER_LINE = "report Blocker: implemented without an approved plan; do not merge";
  const selfStep = "Review the changes with a focused self-review";
  const lensesStep = "if the devkit_load_skill tool is available";
  const workspaceOf = (files: Array<Record<string, unknown>>) => ({
    status: async () => ({
      outcome: "available",
      workspace: { checkout: { kind: "branch", headSha: "0123abcd" }, workingTree: { files } },
    }),
  });
  const inFloor = workspaceOf([{ path: "a.ts", status: "M", insertions: 3, deletions: 2 }]);
  const overFloor = workspaceOf([{ path: "a.ts", status: "M", insertions: 30, deletions: 30 }]);
  const nullStats = workspaceOf([{ path: "a.ts", status: "M", insertions: null, deletions: null }]);

  it("self-reviews a fresh trivial verdict whose one file is within the floor, without the blocker", async () => {
    await withDispatch(
      { reviewMode: "auto", plugins: [], environments: inFloor, callRpc: { verdict: "trivial", messageSeq: 10 } },
      async (_calls, _bb, sent) => {
        expect(sent[0]).toContain(selfStep);
        expect(sent[0]).not.toContain(lensesStep);
        expect(sent[0]).not.toContain(BLOCKER_LINE);
      },
    );
  });

  it("keeps the lenses step and no blocker for a lost verdict within the floor", async () => {
    await withDispatch(
      { reviewMode: "auto", plugins: [], environments: inFloor, callRpc: { verdict: null, messageSeq: null }, events: [] },
      async (_calls, _bb, sent) => {
        expect(sent[0]).toContain(lensesStep);
        expect(sent[0]).not.toContain(selfStep);
        expect(sent[0]).not.toContain(BLOCKER_LINE);
      },
    );
  });

  it("reports the blocker for a lost verdict over the floor, walking from the window start", async () => {
    await withDispatch(
      { reviewMode: "auto", plugins: [], environments: overFloor, callRpc: { verdict: null, messageSeq: null }, events: [] },
      async (_calls, _bb, sent) => {
        expect(sent[0]).toContain(lensesStep);
        expect(sent[0]).not.toContain(selfStep);
        expect(sent[0]).toContain(BLOCKER_LINE);
      },
    );
  });

  it("keeps the blocker when the lifecycle read fails while the blocker's condition holds", async () => {
    // A read failure must not waive the blocker; the warning is asserted on
    // reviewSize itself in change-size.test.ts.
    await withDispatch(
      { reviewMode: "auto", plugins: [], environments: overFloor, callRpc: { verdict: null, messageSeq: null }, events: "throws" },
      async (_calls, _bb, sent) => {
        expect(sent[0]).toContain(lensesStep);
        expect(sent[0]).toContain(BLOCKER_LINE);
      },
    );
  });

  it("gives a stale non_trivial verdict within the floor the lenses step and no blocker", async () => {
    // The verdict sized an earlier request, whose work the last review covered.
    await withDispatch(
      {
        reviewMode: "auto",
        plugins: [],
        environments: inFloor,
        callRpc: { verdict: "non_trivial", messageSeq: 10 },
        lastCodeReviewSeq: 20,
        events: [],
      },
      async (_calls, _bb, sent) => {
        expect(sent[0]).toContain(lensesStep);
        expect(sent[0]).not.toContain(selfStep);
        expect(sent[0]).not.toContain(BLOCKER_LINE);
      },
    );
  });

  it("gives a stale trivial verdict within the floor the lenses step too, with no blocker", async () => {
    await withDispatch(
      {
        reviewMode: "auto",
        plugins: [],
        environments: inFloor,
        callRpc: { verdict: "trivial", messageSeq: 10 },
        lastCodeReviewSeq: 20,
      },
      async (_calls, _bb, sent) => {
        expect(sent[0]).toContain(lensesStep);
        expect(sent[0]).not.toContain(selfStep);
        expect(sent[0]).not.toContain(BLOCKER_LINE);
      },
    );
  });

  it("reports the blocker for a stale trivial verdict over the floor when no plan was approved since the window start", async () => {
    await withDispatch(
      {
        reviewMode: "auto",
        plugins: [],
        environments: overFloor,
        callRpc: { verdict: "trivial", messageSeq: 10 },
        lastCodeReviewSeq: 20,
        events: [],
      },
      async (_calls, _bb, sent) => {
        expect(sent[0]).toContain(lensesStep);
        expect(sent[0]).not.toContain(selfStep);
        expect(sent[0]).toContain(BLOCKER_LINE);
      },
    );
  });

  it("reports the blocker for a fresh trivial verdict over the line floor", async () => {
    await withDispatch(
      { reviewMode: "auto", plugins: [], environments: overFloor, callRpc: { verdict: "trivial", messageSeq: 10 }, events: [] },
      async (_calls, _bb, sent) => {
        expect(sent[0]).toContain(lensesStep);
        expect(sent[0]).not.toContain(selfStep);
        expect(sent[0]).toContain(BLOCKER_LINE);
      },
    );
  });

  it("fails the floor on two files in scope and reports the blocker", async () => {
    await withDispatch(
      {
        reviewMode: "auto",
        plugins: [],
        environments: inFloor,
        callRpc: { verdict: "trivial", messageSeq: 10 },
        events: [],
        scope: ["a.ts", "b.ts"],
      },
      async (_calls, _bb, sent) => {
        expect(sent[0]).toContain(lensesStep);
        expect(sent[0]).toContain(BLOCKER_LINE);
      },
    );
  });

  it("fails the floor on null line stats and reports the blocker", async () => {
    await withDispatch(
      { reviewMode: "auto", plugins: [], environments: nullStats, callRpc: { verdict: "trivial", messageSeq: 10 }, events: [] },
      async (_calls, _bb, sent) => {
        expect(sent[0]).toContain(lensesStep);
        expect(sent[0]).toContain(BLOCKER_LINE);
      },
    );
  });

  it("drops the blocker when a plan was approved after the fresh verdict, auto-approved or not", async () => {
    await withDispatch(
      {
        reviewMode: "auto",
        plugins: [],
        environments: inFloor,
        callRpc: { verdict: "non_trivial", messageSeq: 10 },
        events: [lifecycle(12, "allow_for_session")],
      },
      async (_calls, _bb, sent) => {
        expect(sent[0]).toContain(lensesStep);
        expect(sent[0]).not.toContain(BLOCKER_LINE);
      },
    );
  });

  it("reports the blocker when the only approval predates the verdict, an older plan for a follow-up request", async () => {
    await withDispatch(
      {
        reviewMode: "auto",
        plugins: [],
        environments: inFloor,
        callRpc: { verdict: "non_trivial", messageSeq: 10 },
        events: [lifecycle(8)],
      },
      async (_calls, _bb, sent) => {
        expect(sent[0]).toContain(lensesStep);
        expect(sent[0]).toContain(BLOCKER_LINE);
      },
    );
  });

  it("dispatches the lenses review with the blocker when the sizing rpc fails", async () => {
    await withDispatch(
      { reviewMode: "auto", plugins: [], environments: overFloor, callRpc: "throws", events: [] },
      async (_calls, _bb, sent) => {
        expect(sent[0]).toContain(lensesStep);
        expect(sent[0]).toContain(BLOCKER_LINE);
      },
    );
  });

  it("keeps the self step under an explicit self mode while the plan blocker still applies", async () => {
    await withDispatch(
      { reviewMode: "self", plugins: [], environments: overFloor, callRpc: { verdict: "non_trivial", messageSeq: 10 }, events: [] },
      async (_calls, _bb, sent) => {
        expect(sent[0]).toContain(selfStep);
        expect(sent[0]).not.toContain(lensesStep);
        expect(sent[0]).toContain(BLOCKER_LINE);
      },
    );
  });
});

describe("committedSinceHead without a tree", () => {
  it("gives null when the turn-start snapshot carries no tree", () => {
    const bare = { turnStart: { sinceSeq: 0, startedAt: 1_000 } } as unknown as ThreadState;
    const turn = { paths: ["a.ts"], commits: ["c1"], committedPaths: ["a.ts"], foreignCommits: [], upstreamCommits: [], parkedCommits: [], parkedPaths: [] };
    expect(committedSinceHead(turn, bare)).toBeNull();
    expect(commitScanHead(turn, bare)).toBeNull();
  });
});

describe("dispatchReview with a foreign commit", () => {
  it("names the other thread's commits in the prompt it sends", async () => {
    const calls: Array<{ set?: Record<string, unknown>; remove?: string[] }> = [];
    const sdk = {
      plugins: { list: async () => ({ plugins: [] }) },
      threads: {
        timeline: async () => ({ rows: [], maxSeq: 500 }),
        updatePluginMetadata: async (args: { set?: Record<string, unknown>; remove?: string[] }) => {
          calls.push(args);
          return {};
        },
        send: async () => ({ delivery: "queued", queuedMessage: { id: "qm-1" } }),
      },
    } as unknown as CreateFakePluginHostOptions["sdk"];
    const host = createFakePluginHost({ pluginId: "auto-review", sdk, agentSkillIds: ["auto-review"] });
    try {
      await dispatchReview(await createReviewContext(host.bb), {
        thread: {
          parentThreadId: null,
          originPluginId: null,
          visibility: "public",
          environmentId: null,
          providerId: "prov-1",
          archivedAt: null,
          id: "thr_1",
          projectId: "project-1",
        },
        state: {} as ThreadState,
        environmentId: "env-1",
        config: { reviewMode: "self" } as EffectiveConfig,
        decision: { commit: true, merge: false },
        base: "main",
        isWorktree: false,
        scope: ["a.ts"],
        turn: {
          paths: ["a.ts"],
          commits: [],
          committedPaths: [],
          foreignCommits: [{ sha: "abc1234" }],
          upstreamCommits: [],
          parkedCommits: [],
          parkedPaths: [],
        },
      } as never);
      expect(calls[0].set).toMatchObject({ phase: "awaiting-review" });
    } finally {
      await host.harness.dispose();
    }
  });
});
