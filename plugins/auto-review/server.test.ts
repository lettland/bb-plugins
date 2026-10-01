import { describe, expect, it } from "vitest";
import {
  createFakePluginHost,
  makePluginAgentConfigurationContext,
  makeQueueEntry,
  makeThreadResponse,
  type CreateFakePluginHostOptions,
} from "@get-bb/plugin-sdk/testing";
import plugin from "./server.js";
import { PLAN_FIRST_INSTRUCTIONS } from "./src/prompt.js";
import { STALE_WINDOW_MS } from "./src/state.js";

const THREAD_ID = "thread-1";
const SIBLING_ID = "thread-2";
const ENV_ID = "env-1";
const PLUGIN_ID = "auto-review";

/** Threads named `codex-…` run on Codex; every other thread runs on Claude Code. */
function providerOf(threadId: string): string {
  return threadId.startsWith("codex-") ? "codex" : "claude-code";
}

interface EnvThread {
  id: string;
  status: string;
  visibility?: string;
  originPluginId?: string | null;
  parentThreadId?: string | null;
  lifecycleOwnerThreadId?: string | null;
  archivedAt?: number | null;
  deletedAt?: number | null;
}

interface QueuedRow {
  id: string;
  initiator?: string;
  origin?: string | null;
  failureReason?: string | null;
  sendAt?: number | null;
}

interface HostOptions {
  sendDelivery?: "sent" | "queued";
  sendThrows?: boolean;
  authoredRows?: unknown[];
  workingTreeFiles?: TreeFile[];
  worktree?: boolean;
  /** Latch a same-provider review between the first check and the lock. */
  reviewLandsBeforeLock?: boolean;
  queuedRows?: QueuedRow[];
  envThreads?: EnvThread[];
  authoringThreads?: string[];
  getThrowsFor?: string[];
  resolveThrows?: boolean;
  /** Withdrawing a queued message fails, as when core already dispatched it. */
  deleteQueuedThrows?: boolean;
  /** The environment status read reports the workspace unavailable. */
  statusUnavailable?: boolean;
  checkoutKind?: string;
  /** Threads that `get` reports hidden, so they no longer pass the thread gate. */
  hiddenThreads?: string[];
  /** The checkout is the mainline itself, so nothing is ever ahead of a base. */
  onMainline?: boolean;
  headSha?: string;
  initialCommits?: TreeCommit[];
  newestFirstCommits?: boolean;
  /** What `plugins.list` reports; "throws" makes the lookup fail. Default: no plugins. */
  plugins?: Array<{ enabled: boolean; status: string; cliCommand: { name: string } | null }> | "throws";
}

interface InterruptEvent {
  seq: number;
  reason: "manual-stop" | "host-daemon-restarted" | "provider-turn-idle";
}

interface TreeFile {
  path: string;
  status?: string;
  insertions?: number | null;
  deletions?: number | null;
  /** Served by `diffFile`; the fingerprint hashes it. */
  content?: string;
}

interface TreeCommit {
  sha: string;
  paths: string[];
  patch?: string;
  subject?: string;
}

function fileChangeRow(path: string, sourceSeqStart = 150): unknown {
  return {
    id: `row-${path}`,
    kind: "work",
    workKind: "file-change",
    turnId: "turn-1",
    sourceSeqStart,
    sourceSeqEnd: sourceSeqStart,
    change: { path, movePath: null },
  };
}

/**
 * The merge base `status` reports. On the mainline there is none unless the
 * caller names a ref to compare from; then it is the commits made after it.
 */
function fakeMergeBase(
  commits: readonly TreeCommit[],
  startHead: string,
  onMainline: boolean,
  ref: string | undefined,
  newestFirst = false,
) {
  if (onMainline && ref === undefined) {
    return null;
  }
  const since =
    ref === undefined || ref === startHead
      ? commits
      : commits.slice(commits.findIndex((commit) => commit.sha === ref) + 1);
  const ordered = newestFirst ? [...since].reverse() : since;
  return {
    files: since.flatMap((commit) => commit.paths.map((path) => ({ path, status: "M" }))),
    commits: ordered.map((commit) => ({
      sha: commit.sha,
      authorName: "author",
      authoredAt: 1_000,
      subject: commit.subject ?? commit.paths.join(","),
    })),
    mergeBaseBranch: ref ?? "master",
    baseRef: "abc123",
  };
}

function createHost(options: HostOptions = {}) {
  const metadataByThread = new Map<string, Record<string, unknown>>();
  const bucket = (threadId: string): Record<string, unknown> => {
    const existing = metadataByThread.get(threadId);
    if (existing !== undefined) {
      return existing;
    }
    const created: Record<string, unknown> = {};
    metadataByThread.set(threadId, created);
    return created;
  };
  const metadata = bucket(THREAD_ID);
  const sends: Array<{ threadId: string; mode: string; input: unknown }> = [];
  const resolutions: Array<{ interactionId: string; resolution: unknown }> = [];
  const deletedQueued: string[] = [];
  const timelineLimits: Array<string | undefined> = [];
  let hostRef: { bb: { storage: { kv: KvLike } } } | null = null;
  const authoredRows = options.authoredRows ?? [fileChangeRow("src/a.ts")];
  let workingTreeFiles: TreeFile[] = options.workingTreeFiles ?? [
    { path: "src/a.ts" },
  ];
  let headSha = options.headSha ?? "head-0";
  const startHead = headSha;
  const onMainline = options.onMainline === true;
  const branchName = onMainline ? "master" : "bb/feature";
  let commits: TreeCommit[] = options.initialCommits ?? [];
  let allCommits: TreeCommit[] = [...commits];
  let siblingRows: Record<string, unknown[]> = {};
  const worktree = options.worktree ?? true;
  const authoring = options.authoringThreads ?? [THREAD_ID];
  let envThreads: EnvThread[] = options.envThreads ?? [
    { id: THREAD_ID, status: "idle" },
  ];
  let maxSeq = 100;
  let queuedRows = options.queuedRows ?? [];
  let interrupts: Record<string, InterruptEvent[]> = {};

  const sdk: CreateFakePluginHostOptions["sdk"] = {
    plugins: {
      list: async () => {
        if (options.plugins === "throws") {
          throw new Error("plugin list unavailable");
        }
        return { plugins: options.plugins ?? [] };
      },
    },
    threads: {
      getPluginMetadata: async (args: { threadId: string }) => ({
        ...bucket(args.threadId),
      }),
      updatePluginMetadata: async (args: {
        threadId: string;
        set?: Record<string, unknown>;
        remove?: string[];
      }) => {
        const target = bucket(args.threadId);
        if (args.set) {
          Object.assign(target, args.set);
        }
        for (const key of args.remove ?? []) {
          delete target[key];
        }
        return { ...target };
      },
      get: async (args: { threadId: string }) => {
        if (options.getThrowsFor?.includes(args.threadId) === true) {
          throw new Error(`thread ${args.threadId} is gone`);
        }
        const listed = envThreads.find((entry) => entry.id === args.threadId);
        return {
          ...makeThreadResponse({
            id: args.threadId,
            environmentId: ENV_ID,
            providerId: providerOf(args.threadId),
            parentThreadId: listed?.parentThreadId ?? null,
            lifecycleOwnerThreadId: listed?.lifecycleOwnerThreadId ?? null,
            originPluginId: listed?.originPluginId ?? null,
            archivedAt: listed?.archivedAt ?? null,
            deletedAt: listed?.deletedAt ?? null,
            ...(options.hiddenThreads?.includes(args.threadId) === true
              ? { visibility: "hidden" as const }
              : {}),
          }),
          status: listed?.status ?? "idle",
          projectId: "project-1",
        };
      },
      // Only the authoring threads changed anything; a sibling that changed
      // nothing stands down on no-authorship rather than firing its own review.
      timeline: async (args: { threadId: string; segmentLimit?: string }) => {
        timelineLimits.push(args.segmentLimit);
        if (options.reviewLandsBeforeLock === true && hostRef !== null) {
          options.reviewLandsBeforeLock = false;
          await latchReview(hostRef.bb.storage.kv, metadataOf("rival"), "rival");
        }
        return {
          rows:
            siblingRows[args.threadId] ??
            (authoring.includes(args.threadId) ? authoredRows : []),
          maxSeq,
          timelinePage: {
            hasOlderRows: false,
            olderCursor: null,
            olderRowsSourceSeqEnd: null,
          },
        };
      },
      events: {
        list: async (args: { threadId: string; afterSeq?: string; types?: readonly string[] }) =>
          args.types?.includes("system/thread/interrupted") === true
            ? (interrupts[args.threadId] ?? [])
                .filter((event) => event.seq > Number(args.afterSeq ?? -1))
                .map((event) => ({
                  id: `ev-${args.threadId}-${event.seq}`,
                  scope: { kind: "thread" },
                  threadId: args.threadId,
                  seq: event.seq,
                  createdAt: 1_000,
                  type: "system/thread/interrupted",
                  data: { reason: event.reason },
                }))
            : [],
      },
      list: async (args?: { parentThreadId?: string }) => {
        const rows = envThreads.map((entry) => ({
          parentThreadId: null,
          lifecycleOwnerThreadId: null,
          deletedAt: null,
          archivedAt: null,
          updatedAt: Date.now(),
          originPluginId: null,
          visibility: "visible",
          environmentId: ENV_ID,
          ...entry,
          environmentIsWorktree: worktree,
        }));
        return args?.parentThreadId === undefined
          ? rows
          : rows.filter((row) => row.parentThreadId === args.parentThreadId);
      },
      send: async (args: { threadId: string; mode: string; input: unknown }) => {
        if (options.sendThrows === true) {
          throw new Error("send failed");
        }
        sends.push(args);
        return options.sendDelivery === "queued"
          ? { ok: true, delivery: "queued", queuedMessage: { id: "qm-1" } }
          : { ok: true, delivery: "sent" };
      },
      queuedMessages: {
        list: async () => queuedRows,
        delete: async (args: { queuedMessageId: string }) => {
          if (options.deleteQueuedThrows === true) {
            throw new Error("already dispatched");
          }
          deletedQueued.push(args.queuedMessageId);
          return {};
        },
      },
      interactions: {
        resolve: async (args: { interactionId: string; resolution: unknown }) => {
          if (options.resolveThrows === true) {
            throw new Error("interaction already settled");
          }
          resolutions.push(args);
          return {};
        },
      },
    },
    environments: {
      status: async (args: { mergeBaseBranch?: string }) =>
        options.statusUnavailable === true
          ? { outcome: "unavailable" }
          : ({
              outcome: "available",
              workspace: {
                workingTree: {
                  files: workingTreeFiles.map((file) => ({
                    status: "M",
                    insertions: 1,
                    deletions: 0,
                    ...file,
                  })),
                },
                branch: { currentBranch: branchName, defaultBranch: "master" },
                checkout: {
                  kind: options.checkoutKind ?? "branch",
                  branchName,
                  headSha,
                },
                mergeBase: fakeMergeBase(
                  commits,
                  startHead,
                  onMainline,
                  args.mergeBaseBranch,
                  options.newestFirstCommits,
                ),
              },
          }),
      diffFile: async (args: { path: string }) => {
        const file = workingTreeFiles.find((entry) => entry.path === args.path);
        if (file?.content === undefined) {
          throw new Error(`no content for ${args.path}`);
        }
        return { path: args.path, content: file.content, contentEncoding: "utf8", sizeBytes: 0 };
      },
      diffFiles: async (args: { target: string; sha?: string }) => {
        const commit = allCommits.find(
          (entry) => args.target === "commit" && entry.sha === args.sha,
        );
        return {
          outcome: "available",
          truncated: false,
          files: (commit?.paths ?? []).map((path) => ({ path, previousPath: null })),
        };
      },
      diffPatch: async (args: { target: { type: string; sha?: string }; paths: string[] }) => {
        const commit = allCommits.find((entry) => entry.sha === args.target.sha);
        return {
          outcome: "available",
          patches: args.paths.map((path) => ({
            path,
            patch: commit?.patch ?? `diff --git a/${path} b/${path}\n-old\n+new\n`,
            truncated: false,
          })),
        };
      },
    },
  };

  function metadataOf(threadId: string) {
    return bucket(threadId);
  }
  const fake = createFakePluginHost({ pluginId: PLUGIN_ID, sdk, agentSkillIds: ["auto-review"] });
  hostRef = fake as unknown as { bb: { storage: { kv: KvLike } } };
  return {
    ...fake,
    metadata,
    metadataFor: bucket,
    sends,
    resolutions,
    deletedQueued,
    timelineLimits,
    setEnvThreads: (next: EnvThread[]) => {
      envThreads = next;
    },
    setMaxSeq: (next: number) => {
      maxSeq = next;
    },
    /** Record a `system/thread/interrupted` event on a thread (default: the thread itself). */
    interrupt: (event: InterruptEvent, threadId: string = THREAD_ID) => {
      interrupts = {
        ...interrupts,
        [threadId]: [...(interrupts[threadId] ?? []), event],
      };
    },
    setQueuedRows: (next: QueuedRow[]) => {
      queuedRows = next;
    },
    /** The working tree as a shell command would leave it — no timeline row. */
    setWorkingTree: (next: TreeFile[]) => {
      workingTreeFiles = next;
    },
    commit: (sha: string, paths: string[]) => {
      commits = [...commits, { sha, paths }];
      allCommits = [...allCommits, { sha, paths }];
      headSha = sha;
    },
    rebase: (replayed: TreeCommit[]) => {
      commits = replayed;
      allCommits = [...allCommits, ...replayed];
      headSha = replayed.at(-1)?.sha ?? headSha;
    },
    setSiblingRows: (threadId: string, rows: unknown[]) => {
      siblingRows = { ...siblingRows, [threadId]: rows };
    },
    /** Latch a same-provider review on the next timeline read. */
    armReviewBeforeLock: () => {
      options.reviewLandsBeforeLock = true;
    },
  };
}

function thread(id: string = THREAD_ID) {
  return makeThreadResponse({ id, environmentId: ENV_ID, providerId: providerOf(id) });
}

interface KvLike {
  set: (key: string, value: unknown) => Promise<void>;
  get: <T>(key: string) => Promise<T | null | undefined>;
  list: (prefix: string) => Promise<string[]>;
}

async function latchReview(
  kv: KvLike,
  state: Record<string, unknown>,
  threadId: string,
  dispatchedAt = Date.now(),
) {
  Object.assign(state, { phase: "awaiting-review", dispatchedAt });
  await kv.set(`review:${threadId}`, { threadId, providerId: providerOf(threadId) });
}

type Host = ReturnType<typeof createHost>;

function emitActive(host: Host, id: string = THREAD_ID) {
  return host.harness.behavior.emitThreadEvent("thread.active", {
    thread: thread(id),
  });
}

function emitIdle(host: Host, id: string = THREAD_ID) {
  return host.harness.behavior.emitThreadEvent("thread.idle", {
    thread: thread(id),
    lastAssistantText: null,
  });
}

function promptText(host: Host, index = 0): string {
  const input = host.sends[index]?.input as Array<{ text: string }> | undefined;
  return input?.[0]?.text ?? "";
}

function planInteraction(
  plan = "# Plan\n\nDo the thing.",
  id = "pint-1",
  planFilePath: string | null = "/home/u/.claude/plans/p.md",
) {
  return {
    id,
    threadId: THREAD_ID,
    turnId: "turn-1",
    status: "pending",
    statusReason: null,
    createdAt: 1,
    resolvedAt: null,
    resolution: null,
    providerId: "claude-code",
    providerRequestId: "req-1",
    providerThreadId: "pt-1",
    payload: {
      kind: "approval",
      availableDecisions: ["allow_once", "deny"],
      reason: null,
      subject: { kind: "plan", itemId: "item-1", plan, planFilePath },
    },
  };
}

function emitPlan(host: Host, interaction = planInteraction()) {
  return host.harness.behavior.emitThreadEvent("interaction.pending", {
    thread: thread(),
    interaction,
  } as never);
}

/** Latch and index a review on `id`, as auto-review does when it sends one. */
function startReview(host: Host, id: string, dispatchedAt = Date.now()) {
  return latchReview(host.bb.storage.kv, host.metadataFor(id), id, dispatchedAt);
}

/** Park `id` the way a deferral does, index entry included. */
async function park(host: Host, id: string, providerId: string | null = providerOf(id)) {
  Object.assign(host.metadataFor(id), {
    phase: "deferred",
    deferredSince: Date.now(),
    turnStart: { sinceSeq: 0 },
  });
  await host.bb.storage.kv.set(`deferral:${id}`, {
    threadId: id,
    projectId: "project-1",
    environmentId: ENV_ID,
    ...(providerId === null ? {} : { providerId }),
  });
}

function endReview(host: Host, id: string) {
  const state = host.metadataFor(id);
  state.phase = "idle";
  delete state.dispatchedAt;
}

function queueEntry() {
  return makeQueueEntry({ id: "qm-1", threadId: THREAD_ID });
}

describe("auto-review plugin", () => {
  it("records the turn-start cursor on thread.active", async () => {
    const host = createHost();
    await plugin(host.bb);
    const { errors } = await emitActive(host);
    expect(errors).toEqual([]);
    expect(host.metadata.turnStart).toMatchObject({ sinceSeq: 100 });
    await host.harness.dispose();
  });

  it("fires a review on an authored turn and does not chain on its own review", async () => {
    const host = createHost();
    await plugin(host.bb);

    await emitActive(host);
    const idle = await emitIdle(host);
    expect(idle.errors).toEqual([]);
    expect(host.sends).toHaveLength(1);
    expect(host.sends[0]?.mode).toBe("auto");
    expect(host.metadata.phase).toBe("awaiting-review");

    const secondIdle = await emitIdle(host);
    expect(secondIdle.errors).toEqual([]);
    expect(host.sends).toHaveLength(1);
    expect(host.metadata.phase).toBe("idle");
    await host.harness.dispose();
  });

  it("asks for the aislop scan only while a running plugin serves `bb aislop`", async () => {
    const aislop = { enabled: true, status: "running", cliCommand: { name: "aislop" } };
    const cases: Array<[HostOptions["plugins"], boolean]> = [
      [[aislop], true],
      [[{ ...aislop, enabled: false, status: "disabled" }], false],
      [[{ ...aislop, status: "error" }], false],
      [[{ enabled: true, status: "running", cliCommand: { name: "auto-review" } }], false],
      [[], false],
      ["throws", false],
    ];
    for (const [plugins, expected] of cases) {
      const host = createHost({ plugins });
      await plugin(host.bb);
      await emitActive(host);
      const idle = await emitIdle(host);
      expect(idle.errors).toEqual([]);
      expect(host.sends).toHaveLength(1);
      expect(promptText(host).includes("bb aislop scan")).toBe(expected);
      const warned = host.harness.logEntries.some((entry) => entry.message.includes("could not list plugins"));
      expect(warned).toBe(plugins === "throws");
      await host.harness.dispose();
    }
  });

  it("never asks the timeline for more segments than it serves", async () => {
    const host = createHost();
    await plugin(host.bb);
    await emitActive(host);
    await emitIdle(host);
    const limits = host.timelineLimits.filter((limit) => limit !== undefined);
    expect(limits.length).toBeGreaterThan(0);
    for (const limit of limits) {
      expect(Number(limit)).toBeLessThanOrEqual(100);
    }
    await host.harness.dispose();
  });

  it("stands down when the agent authored nothing this turn", async () => {
    const host = createHost({ authoredRows: [] });
    await plugin(host.bb);
    await emitActive(host);
    await emitIdle(host);
    expect(host.sends).toHaveLength(0);
    await host.harness.dispose();
  });

  it("stands down when the authored path is no longer changed", async () => {
    const host = createHost({ workingTreeFiles: [{ path: "unrelated.ts" }] });
    await plugin(host.bb);
    await emitActive(host);
    await emitIdle(host);
    expect(host.sends).toHaveLength(0);
    await host.harness.dispose();
  });

  async function lastFire(host: Host): Promise<Record<string, unknown>> {
    const status = await host.harness.runCli(["status", THREAD_ID, "--json"]);
    return JSON.parse(status.stdout).lastFire;
  }

  it("reviews a file a shell command created, though no timeline row records it", async () => {
    const host = createHost({ authoredRows: [], workingTreeFiles: [] });
    await plugin(host.bb);
    await emitActive(host);
    host.setWorkingTree([{ path: "gen/out.ts", status: "??", content: "x" }]);
    await emitIdle(host);
    expect(host.sends).toHaveLength(1);
    expect(await lastFire(host)).toMatchObject({
      outcome: "fired",
      scopePaths: ["gen/out.ts"],
    });
    await host.harness.dispose();
  });

  it("ignores untracked harness output that appears during the turn", async () => {
    const host = createHost({ authoredRows: [], workingTreeFiles: [] });
    await plugin(host.bb);
    await emitActive(host);
    host.setWorkingTree([
      { path: ".claude/backups/a.ts.123.bak", status: "??", content: "b" },
      { path: "src/real.ts", status: "??", content: "r" },
    ]);
    await emitIdle(host);
    expect(await lastFire(host)).toMatchObject({
      outcome: "fired",
      scopePaths: ["src/real.ts"],
    });
    await host.harness.dispose();
  });

  it("reviews a file dirty before the turn whose content a shell command changed", async () => {
    const host = createHost({
      authoredRows: [],
      workingTreeFiles: [{ path: "src/a.ts", content: "old" }],
    });
    await plugin(host.bb);
    await emitActive(host);
    // Same line stats, different content: `sed -i` rewriting the changed line.
    host.setWorkingTree([{ path: "src/a.ts", content: "new" }]);
    await emitIdle(host);
    expect(await lastFire(host)).toMatchObject({
      outcome: "fired",
      scopePaths: ["src/a.ts"],
    });
    await host.harness.dispose();
  });

  it("stands down when the user stopped the turn", async () => {
    const host = createHost();
    await plugin(host.bb);
    await emitActive(host);
    host.interrupt({ seq: 120, reason: "manual-stop" });
    await emitIdle(host);
    expect(host.sends).toHaveLength(0);
    expect(await lastFire(host)).toMatchObject({
      outcome: "stood-down",
      reason: "user-stopped",
    });
    await host.harness.dispose();
  });

  function userRow(extra: Partial<QueuedRow> = {}): QueuedRow {
    return {
      id: "user-msg",
      initiator: "user",
      origin: "app",
      failureReason: null,
      sendAt: null,
      ...extra,
    };
  }

  it("folds the review into the user's queued next turn", async () => {
    const host = createHost({ queuedRows: [userRow()] });
    await plugin(host.bb);
    await emitActive(host);
    await emitIdle(host);
    expect(host.sends).toHaveLength(0);
    expect(host.metadata.turnDecided).toBeUndefined();
    expect(await lastFire(host)).toMatchObject({
      outcome: "deferred",
      reason: "user-queued",
    });

    // Core dispatches the user's message; that turn keeps the first cursor.
    host.setQueuedRows([]);
    host.setMaxSeq(200);
    await emitActive(host);
    expect(host.metadata.turnStart).toMatchObject({ sinceSeq: 100 });
    await emitIdle(host);
    expect(host.sends).toHaveLength(1);
    expect(host.metadata.turnDecided).toBe(true);
    expect(await lastFire(host)).toMatchObject({ outcome: "fired" });
    await host.harness.dispose();
  });

  it("fires one review across several queued user turns and extra idles", async () => {
    const host = createHost({
      sendDelivery: "queued",
      queuedRows: [userRow({ id: "u1" }), userRow({ id: "u2" })],
    });
    await plugin(host.bb);
    await emitActive(host);
    await emitIdle(host);
    host.setQueuedRows([userRow({ id: "u2" })]);
    await emitActive(host);
    await emitIdle(host);
    expect(host.sends).toHaveLength(0);

    host.setQueuedRows([]);
    await emitActive(host);
    await emitIdle(host);
    expect(host.sends).toHaveLength(1);
    expect(host.metadata.phase).toBe("pending-dispatch");

    // The thread goes idle again while the review is still queued.
    host.setQueuedRows([{ id: "qm-1" }]);
    await emitIdle(host);
    expect(host.sends).toHaveLength(1);

    host.setQueuedRows([]);
    await host.harness.behavior.emitThreadEvent("message.dispatched", {
      entry: queueEntry(),
    });
    await emitActive(host);
    await emitIdle(host);
    expect(host.metadata.phase).toBe("idle");
    expect(host.sends).toHaveLength(1);
    await host.harness.dispose();
  });

  it("keeps the finished turn's cursor when the next turn's start is handled before its idle", async () => {
    const host = createHost();
    await plugin(host.bb);
    await emitActive(host);
    // Core drained the user's message: the next turn is running, and its
    // thread.active reaches the plugin before the finished turn's idle.
    host.setMaxSeq(200);
    host.setEnvThreads([{ id: THREAD_ID, status: "active" }]);
    await emitActive(host);
    expect(host.metadata.turnStart).toMatchObject({ sinceSeq: 100 });
    await emitIdle(host);
    expect(host.sends).toHaveLength(0);
    expect(await lastFire(host)).toMatchObject({ reason: "user-queued" });

    host.setEnvThreads([{ id: THREAD_ID, status: "idle" }]);
    await emitIdle(host);
    expect(host.sends).toHaveLength(1);
    expect(await lastFire(host)).toMatchObject({
      outcome: "fired",
      scopePaths: ["src/a.ts"],
    });
    await host.harness.dispose();
  });

  it("starts a fresh cursor once the previous turn's idle decided it", async () => {
    const host = createHost({ authoredRows: [] });
    await plugin(host.bb);
    await emitActive(host);
    await emitIdle(host);
    host.setMaxSeq(200);
    await emitActive(host);
    expect(host.metadata.turnStart).toMatchObject({ sinceSeq: 200 });
    expect(host.metadata.turnDecided).toBeUndefined();
    await host.harness.dispose();
  });

  it("folds a released deferral into the turn the thread is already running", async () => {
    const host = createHost({ envThreads: [{ id: THREAD_ID, status: "active" }] });
    await plugin(host.bb);
    await park(host, THREAD_ID);
    await emitIdle(host, "other");
    expect(host.sends).toHaveLength(0);
    expect(host.metadata.phase).toBe("idle");
    expect(host.metadata.turnDecided).toBeUndefined();
    expect(await host.bb.storage.kv.get(`deferral:${THREAD_ID}`)).toBeFalsy();
    await host.harness.dispose();
  });

  it.each([
    ["a scheduled message", { sendAt: Date.now() + 60 * 60 * 1_000 }],
    ["a failed message", { failureReason: "boom" }],
    ["a plugin's message", { origin: "plugin" }],
    ["an agent's message", { initiator: "agent" }],
  ])("still fires when the only queued row is %s", async (_label, extra) => {
    const host = createHost({ queuedRows: [userRow(extra)] });
    await plugin(host.bb);
    await emitActive(host);
    await emitIdle(host);
    expect(host.sends).toHaveLength(1);
    await host.harness.dispose();
  });

  it("reviews a turn after an earlier turn was stopped", async () => {
    const host = createHost();
    await plugin(host.bb);
    host.interrupt({ seq: 90, reason: "manual-stop" });
    await emitActive(host);
    await emitIdle(host);
    expect(await lastFire(host)).toMatchObject({ outcome: "fired" });
    await host.harness.dispose();
  });

  it("reviews a turn bb stopped on its own", async () => {
    const host = createHost();
    await plugin(host.bb);
    await emitActive(host);
    host.interrupt({ seq: 120, reason: "host-daemon-restarted" });
    host.interrupt({ seq: 130, reason: "provider-turn-idle" });
    await emitIdle(host);
    expect(await lastFire(host)).toMatchObject({ outcome: "fired" });
    await host.harness.dispose();
  });

  it("unparks a deferred turn when the user stops the thread's next turn", async () => {
    const host = createHost();
    await plugin(host.bb);
    await park(host, THREAD_ID);
    await emitActive(host);
    host.interrupt({ seq: 120, reason: "manual-stop" });
    await emitIdle(host);
    expect(host.sends).toHaveLength(0);
    expect(host.metadata.phase).toBe("idle");
    expect(await host.bb.storage.kv.list("deferral:")).toEqual([]);
    expect(await lastFire(host)).toMatchObject({ reason: "user-stopped" });
    await host.harness.dispose();
  });

  it("does not claim a file that was already dirty and the turn left alone", async () => {
    const host = createHost({
      authoredRows: [],
      workingTreeFiles: [{ path: "src/a.ts", content: "same" }],
    });
    await plugin(host.bb);
    await emitActive(host);
    await emitIdle(host);
    expect(host.sends).toHaveLength(0);
    expect(await lastFire(host)).toMatchObject({ reason: "no-authorship" });
    await host.harness.dispose();
  });

  it("reviews files the turn committed from the shell", async () => {
    const host = createHost({ authoredRows: [], workingTreeFiles: [] });
    await plugin(host.bb);
    await emitActive(host);
    host.commit("c1", ["src/committed.ts"]);
    await emitIdle(host);
    expect(await lastFire(host)).toMatchObject({
      outcome: "fired",
      scopePaths: ["src/committed.ts"],
    });
    await host.harness.dispose();
  });

  it("stands down after a clean rebase replayed twelve existing commits", async () => {
    const originals = Array.from({ length: 12 }, (_, index) => ({
      sha: `old-${index}`,
      paths: [`src/file-${index}.ts`],
    }));
    const host = createHost({
      headSha: "old-11",
      initialCommits: originals,
      authoredRows: [],
      workingTreeFiles: [],
    });
    await plugin(host.bb);
    await emitActive(host);
    host.rebase(originals.map((commit, index) => ({ ...commit, sha: `replayed-${index}` })));
    await emitIdle(host);
    expect(host.sends).toHaveLength(0);
    expect(await lastFire(host)).toMatchObject({ reason: "no-authorship" });
    await host.harness.dispose();
  });

  it("stands down when master rebases twelve unchanged commits onto new upstream commits", async () => {
    const originals = Array.from({ length: 12 }, (_, index) => ({
      sha: `old-${index}`,
      paths: [`src/file-${index}.ts`],
    }));
    const host = createHost({ onMainline: true, authoredRows: [], workingTreeFiles: [] });
    for (const commit of originals) {
      host.commit(commit.sha, commit.paths);
    }
    await plugin(host.bb);
    await emitActive(host);
    host.rebase([
      { sha: "upstream-1", paths: ["src/upstream-1.ts"] },
      { sha: "upstream-2", paths: ["src/upstream-2.ts"] },
      ...originals.map((commit, index) => ({ ...commit, sha: `replayed-${index}` })),
    ]);
    await emitIdle(host);
    expect(host.sends).toHaveLength(0);
    expect(await lastFire(host)).toMatchObject({ reason: "no-authorship" });
    await host.harness.dispose();
  });

  it("recognizes a clean mainline replay when commit lists are newest first", async () => {
    const host = createHost({
      onMainline: true,
      newestFirstCommits: true,
      authoredRows: [],
      workingTreeFiles: [],
    });
    host.commit("old", ["src/a.ts"]);
    await plugin(host.bb);
    await emitActive(host);
    host.rebase([
      { sha: "upstream", paths: ["src/upstream.ts"] },
      { sha: "replayed", paths: ["src/a.ts"] },
    ]);
    await emitIdle(host);
    expect(host.sends).toHaveLength(0);
    expect(await lastFire(host)).toMatchObject({ reason: "no-authorship" });
    await host.harness.dispose();
  });

  it("reviews a changed replay on master while ignoring new upstream commits", async () => {
    const host = createHost({ onMainline: true, authoredRows: [], workingTreeFiles: [] });
    host.commit("old", ["src/a.ts"]);
    await plugin(host.bb);
    await emitActive(host);
    host.rebase([
      { sha: "upstream", paths: ["src/upstream.ts"] },
      { sha: "replayed", paths: ["src/a.ts"], patch: "-old\n+resolved\n" },
    ]);
    await emitIdle(host);
    expect(await lastFire(host)).toMatchObject({
      outcome: "fired",
      scopePaths: ["src/a.ts"],
    });
    await host.harness.dispose();
  });

  it("reviews a new commit after an unchanged replay on master", async () => {
    const host = createHost({ onMainline: true, authoredRows: [], workingTreeFiles: [] });
    host.commit("old", ["src/a.ts"]);
    await plugin(host.bb);
    await emitActive(host);
    host.rebase([
      { sha: "upstream", paths: ["src/upstream.ts"] },
      { sha: "replayed", paths: ["src/a.ts"] },
      { sha: "new", paths: ["src/new.ts"] },
    ]);
    await emitIdle(host);
    expect(await lastFire(host)).toMatchObject({
      outcome: "fired",
      scopePaths: ["src/new.ts"],
    });
    await host.harness.dispose();
  });

  it("reviews a patch changed while replaying commits", async () => {
    const host = createHost({
      headSha: "old",
      initialCommits: [{ sha: "old", paths: ["src/a.ts"], patch: "-old\n+new\n" }],
      authoredRows: [],
      workingTreeFiles: [],
    });
    await plugin(host.bb);
    await emitActive(host);
    host.rebase([{ sha: "replayed", paths: ["src/a.ts"], patch: "-old\n+resolved\n" }]);
    await emitIdle(host);
    expect(await lastFire(host)).toMatchObject({
      outcome: "fired",
      scopePaths: ["src/a.ts"],
    });
    await host.harness.dispose();
  });

  it("reviews work the turn committed straight onto the mainline", async () => {
    const host = createHost({
      onMainline: true,
      headSha: "0123abc",
      authoredRows: [fileChangeRow("src/a.ts")],
      workingTreeFiles: [],
    });
    await plugin(host.bb);
    await emitActive(host);
    host.commit("4567def", ["src/a.ts", "src/shell.ts"]);
    await emitIdle(host);
    expect(await lastFire(host)).toMatchObject({
      outcome: "fired",
      commit: true,
      merge: false,
      scopePaths: ["src/a.ts", "src/shell.ts"],
    });
    const text = JSON.stringify(host.sends[0]?.input);
    expect(text).toContain("impl 0123abc..HEAD");
    expect(text).toContain("Do not amend");
    await host.harness.dispose();
  });

  it("does not claim mainline commits made before the turn", async () => {
    const host = createHost({ onMainline: true, authoredRows: [], workingTreeFiles: [] });
    await plugin(host.bb);
    host.commit("c0", ["src/earlier.ts"]);
    await emitActive(host);
    await emitIdle(host);
    expect(host.sends).toHaveLength(0);
    expect(await lastFire(host)).toMatchObject({ reason: "no-authorship" });
    await host.harness.dispose();
  });

  it("leaves a sibling's tool edit made during the turn to the sibling", async () => {
    const host = createHost({
      authoredRows: [],
      workingTreeFiles: [],
      envThreads: [
        { id: THREAD_ID, status: "idle" },
        { id: SIBLING_ID, status: "active" },
      ],
    });
    await plugin(host.bb);
    await emitActive(host);
    host.setSiblingRows(SIBLING_ID, [
      { ...(fileChangeRow("sib.ts") as object), createdAt: Date.now() },
    ]);
    host.setWorkingTree([
      { path: "sib.ts", content: "s" },
      { path: "mine.ts", content: "m" },
    ]);
    await emitIdle(host);
    expect(await lastFire(host)).toMatchObject({
      outcome: "fired",
      scopePaths: ["mine.ts"],
    });
    await host.harness.dispose();
  });

  it("correlates a queued injection through message.dispatched", async () => {
    const host = createHost({ sendDelivery: "queued" });
    await plugin(host.bb);

    await emitActive(host);
    await emitIdle(host);
    expect(host.sends).toHaveLength(1);
    expect(host.metadata.phase).toBe("pending-dispatch");
    expect(host.metadata.pendingEntryId).toBe("qm-1");

    await host.harness.behavior.emitThreadEvent("message.dispatched", {
      entry: queueEntry(),
    });
    expect(host.metadata.phase).toBe("awaiting-review");

    await emitIdle(host);
    expect(host.metadata.phase).toBe("idle");
    expect(host.sends).toHaveLength(1);
    await host.harness.dispose();
  });

  it("unlatches a queued injection that is cancelled", async () => {
    const host = createHost({ sendDelivery: "queued" });
    await plugin(host.bb);
    await emitActive(host);
    await emitIdle(host);
    expect(host.metadata.phase).toBe("pending-dispatch");

    await host.harness.behavior.emitThreadEvent("message.cancelled", {
      entry: queueEntry(),
    });
    expect(host.metadata.phase).toBe("idle");
    await host.harness.dispose();
  });

  it("skips a thread when the per-thread skip flag is set", async () => {
    const host = createHost();
    await plugin(host.bb);
    await host.harness.runCli(["skip", THREAD_ID]);
    await emitActive(host);
    await emitIdle(host);
    expect(host.sends).toHaveLength(0);
    await host.harness.dispose();
  });

  it("resets the latch to idle when the injected send throws", async () => {
    const host = createHost({ sendThrows: true });
    await plugin(host.bb);
    await emitActive(host);
    const idle = await emitIdle(host);
    expect(idle.errors).toEqual([]);
    expect(host.sends).toHaveLength(0);
    expect(host.metadata.phase).toBe("idle");
    await host.harness.dispose();
  });

  it("fires the full review, merge included, while other threads run in the checkout", async () => {
    const host = createHost({
      envThreads: [
        { id: THREAD_ID, status: "idle" },
        { id: "advisor", status: "active", visibility: "hidden", originPluginId: "advisor" },
        { id: SIBLING_ID, status: "active" },
      ],
    });
    await plugin(host.bb);
    await emitActive(host);
    await emitIdle(host);
    expect(host.sends).toHaveLength(1);
    expect(host.metadata.phase).toBe("awaiting-review");
    expect(promptText(host)).toMatch(/Merge the current branch/);
    expect(await host.bb.storage.kv.list("review:")).toEqual([`review:${THREAD_ID}`]);
    const status = await host.harness.runCli(["status", THREAD_ID, "--json"]);
    expect(JSON.parse(status.stdout).lastFire).toMatchObject({
      outcome: "fired",
      reason: "fired",
      merge: true,
    });
    await host.harness.dispose();
  });

  it.each([
    [
      "an active",
      [{ id: "child-1", status: "active", parentThreadId: THREAD_ID }],
      ["child-1"],
    ],
    [
      "a pending",
      [{ id: "child-1", status: "pending", parentThreadId: THREAD_ID }],
      ["child-1"],
    ],
    [
      "a running grandchild under an idle",
      [
        { id: "child-1", status: "idle", parentThreadId: THREAD_ID },
        { id: "grandchild-1", status: "active", parentThreadId: "child-1" },
      ],
      ["grandchild-1"],
    ],
  ] as Array<[string, EnvThread[], string[]]>)(
    "holds the turn behind %s spawned child",
    async (_label, extraThreads, expectedHeldBy) => {
      const host = createHost({
        envThreads: [{ id: THREAD_ID, status: "idle" }, ...extraThreads],
      });
      await plugin(host.bb);
      await emitActive(host);
      await emitIdle(host);
      expect(host.sends).toHaveLength(0);
      expect(host.metadata.phase).toBe("deferred");
      expect(host.metadata.heldBy).toEqual(expectedHeldBy);
      expect(await lastFire(host)).toMatchObject({
        outcome: "deferred",
        reason: "children-active",
      });
      await host.harness.dispose();
    },
  );

  it.each([
    ["idle", { status: "idle" }],
    ["erroring", { status: "error" }],
    ["archived", { status: "active", archivedAt: 1 }],
    ["deleted", { status: "active", deletedAt: 1 }],
  ] as Array<[string, Partial<EnvThread>]>)(
    "does not hold the turn for a %s child",
    async (_label, extra) => {
      const host = createHost({
        envThreads: [
          { id: THREAD_ID, status: "idle" },
          { id: "child-1", parentThreadId: THREAD_ID, status: "active", ...extra },
        ],
      });
      await plugin(host.bb);
      await emitActive(host);
      await emitIdle(host);
      expect(host.sends).toHaveLength(1);
      expect(host.metadata.phase).toBe("awaiting-review");
      await host.harness.dispose();
    },
  );

  it("does not hold the turn for a lifecycle-owned-only helper or a plugin-originated child", async () => {
    const host = createHost({
      envThreads: [
        { id: THREAD_ID, status: "idle" },
        { id: "owned", status: "active", lifecycleOwnerThreadId: THREAD_ID },
        { id: "advisor", status: "active", parentThreadId: THREAD_ID, originPluginId: "advisor" },
      ],
    });
    await plugin(host.bb);
    await emitActive(host);
    await emitIdle(host);
    expect(host.sends).toHaveLength(1);
    expect(host.metadata.phase).toBe("awaiting-review");
    await host.harness.dispose();
  });

  it("does not review a child-held turn from the child's own idle, nor from releaseDeferred", async () => {
    const host = createHost({
      envThreads: [
        { id: THREAD_ID, status: "idle" },
        { id: "child-1", status: "active", parentThreadId: THREAD_ID },
      ],
    });
    await plugin(host.bb);
    await emitActive(host);
    await emitIdle(host);
    expect(host.metadata.phase).toBe("deferred");
    expect(host.metadata.heldBy).toEqual(["child-1"]);

    host.setEnvThreads([
      { id: THREAD_ID, status: "idle" },
      { id: "child-1", status: "idle", parentThreadId: THREAD_ID },
    ]);
    // The child's own idle event carries a parent, so it fails the thread
    // gate outright — it cannot trigger a review of its own accord.
    const childIdle = await host.harness.behavior.emitThreadEvent("thread.idle", {
      thread: makeThreadResponse({
        id: "child-1",
        environmentId: ENV_ID,
        providerId: "claude-code",
        parentThreadId: THREAD_ID,
      }),
      lastAssistantText: null,
    });
    expect(childIdle.errors).toEqual([]);
    expect(host.sends).toHaveLength(0);
    expect(host.metadata.phase).toBe("deferred");

    // Nor does an unrelated same-provider idle release it through
    // releaseDeferred: a child-held entry waits for the sweep, not a release.
    await emitIdle(host, "unrelated-thread");
    expect(host.sends).toHaveLength(0);
    expect(host.metadata.phase).toBe("deferred");
    await host.harness.dispose();
  });

  it("fires the deferred review from the wake-up turn, scope including what the child wrote, keeping the cursor", async () => {
    const host = createHost({
      authoredRows: [],
      workingTreeFiles: [],
      envThreads: [
        { id: THREAD_ID, status: "idle" },
        { id: "child-1", status: "active", parentThreadId: THREAD_ID },
      ],
    });
    await plugin(host.bb);
    await emitActive(host);
    await emitIdle(host);
    expect(host.metadata.phase).toBe("deferred");
    expect(host.metadata.heldBy).toEqual(["child-1"]);
    const turnStartBefore = host.metadata.turnStart;

    // The child finishes and wrote a file; bb wakes the parent with a new turn.
    host.setEnvThreads([
      { id: THREAD_ID, status: "idle" },
      { id: "child-1", status: "idle", parentThreadId: THREAD_ID },
    ]);
    host.setWorkingTree([{ path: "child.ts", content: "c" }]);
    await emitActive(host);
    expect(host.metadata.turnStart).toEqual(turnStartBefore);

    await emitIdle(host);
    expect(host.sends).toHaveLength(1);
    expect(await lastFire(host)).toMatchObject({
      outcome: "fired",
      scopePaths: ["child.ts"],
    });
    expect(host.metadata.heldBy).toBeUndefined();
    expect(await host.bb.storage.kv.list("deferral:")).toEqual([]);
    await host.harness.dispose();
  });

  it("parks as sibling-active once a held child ends while another thread's review is in flight, then fires once that review ends", async () => {
    const host = createHost({
      authoredRows: [],
      workingTreeFiles: [],
      envThreads: [
        { id: THREAD_ID, status: "idle" },
        { id: "child-1", status: "active", parentThreadId: THREAD_ID },
      ],
    });
    await plugin(host.bb);
    await emitActive(host);
    await emitIdle(host);
    expect(host.metadata.phase).toBe("deferred");
    expect(host.metadata.heldBy).toEqual(["child-1"]);

    // The child finishes and wrote a file, but a sibling thread's review is
    // already running on the same provider when bb wakes the parent.
    await startReview(host, SIBLING_ID);
    host.setEnvThreads([
      { id: THREAD_ID, status: "idle" },
      { id: "child-1", status: "idle", parentThreadId: THREAD_ID },
    ]);
    host.setWorkingTree([{ path: "child.ts", content: "c" }]);
    await emitActive(host);
    await emitIdle(host);
    expect(host.sends).toHaveLength(0);
    expect(host.metadata.phase).toBe("deferred");
    expect(host.metadata.heldBy).toBeUndefined();
    expect(await lastFire(host)).toMatchObject({
      outcome: "deferred",
      reason: "sibling-active",
    });

    // The sibling's review ends; its idle releases the parked turn.
    const released = await emitIdle(host, SIBLING_ID);
    expect(released.errors).toEqual([]);
    expect(host.sends).toHaveLength(1);
    expect(host.sends[0]?.threadId).toBe(THREAD_ID);
    expect(await lastFire(host)).toMatchObject({
      outcome: "fired",
      scopePaths: ["child.ts"],
    });
    expect(host.metadata.heldBy).toBeUndefined();
    await host.harness.dispose();
  });

  it("fires the wake-up turn even though a held child was manually stopped", async () => {
    const host = createHost({
      authoredRows: [],
      workingTreeFiles: [],
      envThreads: [
        { id: THREAD_ID, status: "idle" },
        { id: "child-1", status: "active", parentThreadId: THREAD_ID },
      ],
    });
    await plugin(host.bb);
    await emitActive(host);
    await emitIdle(host);
    expect(host.metadata.phase).toBe("deferred");
    expect(host.metadata.heldBy).toEqual(["child-1"]);

    // The child is manually stopped (e.g. a supervisor cleaning up a worker)
    // and goes idle; that alone must not stand the parent's turn down.
    host.interrupt({ seq: 1, reason: "manual-stop" }, "child-1");
    host.setEnvThreads([
      { id: THREAD_ID, status: "idle" },
      { id: "child-1", status: "idle", parentThreadId: THREAD_ID },
    ]);
    host.setWorkingTree([{ path: "child.ts", content: "c" }]);
    await emitActive(host);
    await emitIdle(host);
    expect(host.sends).toHaveLength(1);
    expect(await lastFire(host)).toMatchObject({ outcome: "fired" });
    expect(host.metadata.heldBy).toBeUndefined();
    await host.harness.dispose();
  });

  it("re-parks on the wake-up turn when a second child is still running, keeping the cursor and defer time", async () => {
    const host = createHost({
      envThreads: [
        { id: THREAD_ID, status: "idle" },
        { id: "child-1", status: "active", parentThreadId: THREAD_ID },
        { id: "child-2", status: "active", parentThreadId: THREAD_ID },
      ],
    });
    await plugin(host.bb);
    await emitActive(host);
    await emitIdle(host);
    expect(host.metadata.phase).toBe("deferred");
    expect([...(host.metadata.heldBy as string[])].sort()).toEqual(["child-1", "child-2"]);
    const turnStartBefore = host.metadata.turnStart;
    const deferredSinceBefore = host.metadata.deferredSince;

    // child-1 finishes; bb wakes the parent while child-2 is still running.
    host.setEnvThreads([
      { id: THREAD_ID, status: "idle" },
      { id: "child-1", status: "idle", parentThreadId: THREAD_ID },
      { id: "child-2", status: "active", parentThreadId: THREAD_ID },
    ]);
    await emitActive(host);
    expect(host.metadata.turnStart).toEqual(turnStartBefore);
    await emitIdle(host);
    expect(host.sends).toHaveLength(0);
    expect(host.metadata.phase).toBe("deferred");
    expect(host.metadata.heldBy).toEqual(["child-2"]);
    expect(host.metadata.turnStart).toEqual(turnStartBefore);
    expect(host.metadata.deferredSince).toBe(deferredSinceBefore);
    await host.harness.dispose();
  });

  it("keeps a child-held turn deferred through a sweep while the child runs, then fires once it idles", async () => {
    const host = createHost({
      authoredRows: [],
      workingTreeFiles: [],
      envThreads: [
        { id: THREAD_ID, status: "idle" },
        { id: "child-1", status: "active", parentThreadId: THREAD_ID },
      ],
    });
    await plugin(host.bb);
    await emitActive(host);
    await emitIdle(host);
    expect(host.metadata.phase).toBe("deferred");

    await host.harness.runSchedule("sweep-deferrals");
    expect(host.sends).toHaveLength(0);
    expect(host.metadata.phase).toBe("deferred");

    host.setEnvThreads([
      { id: THREAD_ID, status: "idle" },
      { id: "child-1", status: "idle", parentThreadId: THREAD_ID },
    ]);
    host.setWorkingTree([{ path: "child.ts", content: "c" }]);
    await host.harness.runSchedule("sweep-deferrals");
    expect(host.sends).toHaveLength(1);
    expect(host.sends[0]?.threadId).toBe(THREAD_ID);
    await host.harness.dispose();
  });

  it("clears heldBy when a child-held deferred turn is carried into the user's next turn", async () => {
    const host = createHost();
    await plugin(host.bb);
    await park(host, THREAD_ID);
    Object.assign(host.metadataFor(THREAD_ID), { heldBy: ["child-1"] });
    host.setQueuedRows([userRow()]);

    await host.harness.runSchedule("sweep-deferrals");
    expect(host.sends).toHaveLength(0);
    expect(host.metadata.phase).toBe("idle");
    expect(host.metadata).not.toHaveProperty("heldBy");
    expect(await lastFire(host)).toMatchObject({ outcome: "deferred", reason: "user-queued" });
    expect(await host.bb.storage.kv.list("deferral:")).toEqual([]);
    await host.harness.dispose();
  });

  it("defers behind a review on the same provider in another project", async () => {
    const host = createHost();
    await plugin(host.bb);
    await startReview(host, "elsewhere");
    await emitActive(host);
    await emitIdle(host);
    expect(host.sends).toHaveLength(0);
    expect(host.metadata.phase).toBe("deferred");
    expect(typeof host.metadata.deferredSince).toBe("number");
    expect(host.metadata.turnStart).toMatchObject({ sinceSeq: 100 });
    const status = await host.harness.runCli(["status", THREAD_ID, "--json"]);
    expect(JSON.parse(status.stdout).lastFire).toMatchObject({
      outcome: "deferred",
      reason: "sibling-active",
    });
    await host.harness.dispose();
  });

  it("does not defer behind a review on a different provider", async () => {
    const host = createHost();
    await plugin(host.bb);
    await startReview(host, "codex-thread");
    await emitActive(host);
    await emitIdle(host);
    expect(host.sends).toHaveLength(1);
    expect(host.metadata.phase).toBe("awaiting-review");
    await host.harness.dispose();
  });

  it("defers rather than dropping when a same-provider review lands before the firing lock", async () => {
    const host = createHost();
    await plugin(host.bb);
    await emitActive(host);
    // Armed after thread.active, so the rival latches during evaluate's own
    // authorship read: after the first in-flight check, before the lock.
    host.armReviewBeforeLock();
    await emitIdle(host);
    expect(host.sends).toHaveLength(0);
    expect(host.metadata.phase).toBe("deferred");
    expect(host.metadata.turnStart).toMatchObject({ sinceSeq: 100 });
    expect(await host.bb.storage.kv.list("deferral:")).toEqual([`deferral:${THREAD_ID}`]);
    // Only the re-check under the provider lock records the decided scope.
    const status = await host.harness.runCli(["status", THREAD_ID, "--json"]);
    expect(JSON.parse(status.stdout).lastFire).toMatchObject({
      outcome: "deferred",
      reason: "sibling-active",
      commit: true,
      merge: true,
      scopePaths: ["src/a.ts"],
    });
    await host.harness.dispose();
  });

  it("keeps a deferred turn's cursor when the thread takes another turn", async () => {
    const host = createHost();
    await plugin(host.bb);
    await startReview(host, SIBLING_ID);
    await emitActive(host);
    await emitIdle(host);
    expect(host.metadata.phase).toBe("deferred");

    host.setMaxSeq(400);
    await emitActive(host);
    expect(host.metadata.turnStart).toMatchObject({ sinceSeq: 100 });
    await host.harness.dispose();
  });

  it("fires the deferred review when the blocking review ends", async () => {
    const host = createHost();
    await plugin(host.bb);
    await startReview(host, "elsewhere");
    await emitActive(host);
    await emitIdle(host);
    expect(host.metadata.phase).toBe("deferred");

    const released = await emitIdle(host, "elsewhere");
    expect(released.errors).toEqual([]);
    expect(host.metadataFor("elsewhere").phase).toBe("idle");
    expect(host.sends).toHaveLength(1);
    expect(host.sends[0]?.threadId).toBe(THREAD_ID);
    expect(host.metadata.phase).toBe("awaiting-review");
    expect(host.metadata.deferredSince).toBeUndefined();
    expect(await host.bb.storage.kv.list("review:")).toEqual([`review:${THREAD_ID}`]);
    expect(await host.bb.storage.kv.list("deferral:")).toEqual([]);
    await host.harness.dispose();
  });

  it("keeps releasing past a parked turn that starts no review", async () => {
    // thread-1 has nothing left to review; thread-2, parked behind it, does.
    const host = createHost({ authoringThreads: [SIBLING_ID] });
    await plugin(host.bb);
    await park(host, THREAD_ID);
    await park(host, SIBLING_ID);

    await emitIdle(host, "thread-3");
    expect(host.metadataFor(THREAD_ID).phase).toBe("idle");
    expect(host.sends.map((send) => send.threadId)).toEqual([SIBLING_ID]);
    expect(host.metadataFor(SIBLING_ID).phase).toBe("awaiting-review");
    await host.harness.dispose();
  });

  it("does not release a parked turn when a review on another provider ends", async () => {
    const host = createHost();
    await plugin(host.bb);
    await startReview(host, SIBLING_ID);
    await startReview(host, "codex-thread");
    await emitActive(host);
    await emitIdle(host);
    expect(host.metadata.phase).toBe("deferred");

    await emitIdle(host, "codex-thread");
    expect(host.sends).toHaveLength(0);
    expect(host.metadata.phase).toBe("deferred");
    await host.harness.dispose();
  });

  it("releases a deferred turn when the blocking thread fails mid-review", async () => {
    const host = createHost();
    await plugin(host.bb);
    await startReview(host, SIBLING_ID);
    await emitActive(host);
    await emitIdle(host);
    expect(host.metadata.phase).toBe("deferred");

    const failed = await host.harness.behavior.emitThreadEvent("thread.failed", {
      thread: thread(SIBLING_ID),
    } as never);
    expect(failed.errors).toEqual([]);
    expect(host.metadataFor(SIBLING_ID).phase).toBe("idle");
    expect(host.sends).toHaveLength(1);
    expect(host.sends[0]?.threadId).toBe(THREAD_ID);
    await host.harness.dispose();
  });

  it("does not release a parked turn while another same-provider review is in flight", async () => {
    const host = createHost();
    await plugin(host.bb);
    await park(host, THREAD_ID);
    await startReview(host, SIBLING_ID);

    await emitIdle(host, "thread-3");
    expect(host.sends).toHaveLength(0);
    expect(host.metadataFor(THREAD_ID).phase).toBe("deferred");
    await host.harness.dispose();
  });

  it("unparks a deferred turn that turns out to have nothing to review", async () => {
    const host = createHost({ authoredRows: [] });
    await plugin(host.bb);
    await park(host, THREAD_ID);

    await emitIdle(host);
    expect(host.sends).toHaveLength(0);
    expect(host.metadata.phase).toBe("idle");
    expect(host.metadata.deferredSince).toBeUndefined();
    expect(await host.bb.storage.kv.list("deferral:")).toEqual([]);

    // The cursor is free to advance again now that nothing is owed.
    host.setMaxSeq(400);
    await emitActive(host);
    expect(host.metadata.turnStart).toMatchObject({ sinceSeq: 400 });
    await host.harness.dispose();
  });

  it("does not defer behind a stale review latch on a thread that went idle", async () => {
    const host = createHost();
    await plugin(host.bb);
    await startReview(host, SIBLING_ID, Date.now() - STALE_WINDOW_MS - 1_000);
    await emitActive(host);
    await emitIdle(host);
    expect(host.sends).toHaveLength(1);
    expect(host.metadata.phase).toBe("awaiting-review");
    await host.harness.dispose();
  });

  it("moves a stale pending-dispatch whose row is gone to awaiting-review", async () => {
    const host = createHost({ queuedRows: [] });
    await plugin(host.bb);
    host.metadata.phase = "pending-dispatch";
    host.metadata.pendingEntryId = "qm-1";
    host.metadata.dispatchedAt = Date.now() - 40 * 60 * 1_000;
    await emitIdle(host);
    expect(host.metadata.phase).toBe("awaiting-review");
    expect(host.sends).toHaveLength(0);
    await host.harness.dispose();
  });

  it("extends a stale pending-dispatch whose row is still queued", async () => {
    const host = createHost({ queuedRows: [{ id: "qm-1" }] });
    await plugin(host.bb);
    const oldDispatchedAt = Date.now() - 40 * 60 * 1_000;
    host.metadata.phase = "pending-dispatch";
    host.metadata.pendingEntryId = "qm-1";
    host.metadata.dispatchedAt = oldDispatchedAt;
    await emitIdle(host);
    expect(host.metadata.phase).toBe("pending-dispatch");
    expect(host.metadata.dispatchedAt as number).toBeGreaterThan(oldDispatchedAt);
    expect(host.sends).toHaveLength(0);
    await host.harness.dispose();
  });

  it("sweeps a parked turn whose blocking review ended without an event", async () => {
    const host = createHost();
    await plugin(host.bb);
    await startReview(host, SIBLING_ID);
    await emitActive(host);
    await emitIdle(host);
    expect(host.metadata.phase).toBe("deferred");

    await host.harness.runSchedule("sweep-deferrals");
    expect(host.sends).toHaveLength(0);

    // The sibling's review finished, but its idle never reached auto-review.
    endReview(host, SIBLING_ID);
    await host.harness.runSchedule("sweep-deferrals");
    expect(host.sends).toHaveLength(1);
    expect(host.sends[0]?.threadId).toBe(THREAD_ID);
    expect(host.metadata.phase).toBe("awaiting-review");
    expect(await host.bb.storage.kv.list("review:")).toEqual([`review:${THREAD_ID}`]);
    await host.harness.dispose();
  });

  it("injects only one review when two drivers race the same parked thread", async () => {
    const host = createHost();
    await plugin(host.bb);
    await park(host, THREAD_ID);
    // Both sweeps read the index and see the same parked thread before either
    // takes its lock; the loser must find the review already in flight.
    await Promise.all([
      host.harness.runSchedule("sweep-deferrals"),
      host.harness.runSchedule("sweep-deferrals"),
    ]);
    expect(host.sends).toHaveLength(1);
    expect(host.metadata.phase).toBe("awaiting-review");
    await host.harness.dispose();
  });

  it("releases one parked turn per provider per sweep", async () => {
    const host = createHost({
      authoringThreads: [THREAD_ID, SIBLING_ID, "codex-thread"],
    });
    await plugin(host.bb);
    await park(host, THREAD_ID);
    await park(host, SIBLING_ID);
    await park(host, "codex-thread");

    await host.harness.runSchedule("sweep-deferrals");
    expect(host.sends.map((send) => providerOf(send.threadId)).sort()).toEqual([
      "claude-code",
      "codex",
    ]);
    await host.harness.dispose();
  });

  it("does not sweep a parked thread while a same-provider review is in flight", async () => {
    const host = createHost();
    await plugin(host.bb);
    await park(host, THREAD_ID);
    await startReview(host, SIBLING_ID);

    await host.harness.runSchedule("sweep-deferrals");
    expect(host.sends).toHaveLength(0);
    expect(host.metadata.phase).toBe("deferred");
    await host.harness.dispose();
  });

  it("sweeps a turn parked before deferrals recorded their provider", async () => {
    const host = createHost();
    await plugin(host.bb);
    await park(host, THREAD_ID, null);
    await startReview(host, SIBLING_ID);

    await host.harness.runSchedule("sweep-deferrals");
    expect(host.sends).toHaveLength(0);

    endReview(host, SIBLING_ID);
    await host.harness.runSchedule("sweep-deferrals");
    expect(host.sends).toHaveLength(1);
    expect(host.sends[0]?.threadId).toBe(THREAD_ID);
    await host.harness.dispose();
  });

  it("unparks, not just de-indexes, a thread the sweep can no longer resolve", async () => {
    const host = createHost({ getThrowsFor: [THREAD_ID] });
    await plugin(host.bb);
    await park(host, THREAD_ID);
    await host.harness.runSchedule("sweep-deferrals");

    // Dropping the index entry alone would leave the thread latched in
    // `deferred` and invisible to every later sweep.
    expect(host.sends).toHaveLength(0);
    expect(host.metadata.phase).toBe("idle");
    expect(host.metadata.deferredSince).toBeUndefined();
    expect(await host.bb.storage.kv.list("deferral:")).toEqual([]);
    await host.harness.dispose();
  });

  it("drops a swept entry whose thread is no longer deferred", async () => {
    const host = createHost();
    await plugin(host.bb);
    await park(host, THREAD_ID);
    await host.harness.runCli(["reset", THREAD_ID]);
    await host.harness.runSchedule("sweep-deferrals");
    expect(host.sends).toHaveLength(0);
    expect(await host.bb.storage.kv.list("deferral:")).toEqual([]);
    await host.harness.dispose();
  });

  it("holds a plan's first presentation for review: queues the review, then denies", async () => {
    const host = createHost({ sendDelivery: "queued" });
    await plugin(host.bb);
    const { errors } = await emitPlan(host);
    expect(errors).toEqual([]);
    expect(host.sends).toHaveLength(1);
    expect(host.sends[0]?.mode).toBe("auto");
    const text = promptText(host);
    expect(text).toMatch(/Nobody rejected it/);
    expect(text).toContain("/home/u/.claude/plans/p.md");
    expect(text).toContain('devkit_load_skill({ slug: "review-code" })');
    expect(host.resolutions).toEqual([
      { threadId: THREAD_ID, interactionId: "pint-1", resolution: { decision: "deny" } },
    ]);
    expect(typeof host.metadata.planReviewArmedAt).toBe("number");
    await host.harness.dispose();
  });

  it("releases the reviewed plan to the user and re-arms for the next plan", async () => {
    const host = createHost({ sendDelivery: "queued" });
    await plugin(host.bb);
    await emitPlan(host);
    expect(host.metadata.planReviewEntryId).toBe("qm-1");
    await host.harness.behavior.emitThreadEvent("message.dispatched", {
      entry: queueEntry(),
    });
    expect(host.metadata.planReviewEntryId).toBeUndefined();
    expect(host.metadata.phase ?? "idle").toBe("idle");
    await emitPlan(host, planInteraction("# Plan v2", "pint-2"));
    expect(host.sends).toHaveLength(1);
    expect(host.resolutions).toHaveLength(1);
    expect(host.metadata.planReviewArmedAt).toBeUndefined();

    await emitPlan(host, planInteraction("# Another plan", "pint-3"));
    expect(host.sends).toHaveLength(2);
    expect(host.resolutions).toHaveLength(2);
    await host.harness.dispose();
  });

  it("denies again, without a second review, a plan re-presented before the review dispatched", async () => {
    const host = createHost({ sendDelivery: "queued", queuedRows: [{ id: "qm-1" }] });
    await plugin(host.bb);
    await emitPlan(host);
    await emitPlan(host, planInteraction("# Plan, unreviewed", "pint-2"));
    expect(host.sends).toHaveLength(1);
    expect(host.resolutions.map((r) => r.interactionId)).toEqual(["pint-1", "pint-2"]);
    expect(host.metadata.planReviewEntryId).toBe("qm-1");
    expect(typeof host.metadata.planReviewArmedAt).toBe("number");
    await host.harness.dispose();
  });

  it("releases the plan when its review left the queue without a dispatch event", async () => {
    const host = createHost({ sendDelivery: "queued", queuedRows: [{ id: "qm-1" }] });
    await plugin(host.bb);
    await emitPlan(host);
    expect(host.metadata.planReviewEntryId).toBe("qm-1");

    // Core dispatched the review, but message.dispatched never reached us.
    host.setQueuedRows([]);
    await emitPlan(host, planInteraction("# Plan v2", "pint-2"));
    expect(host.resolutions.map((r) => r.interactionId)).toEqual(["pint-1"]);
    expect(host.metadata.planReviewArmedAt).toBeUndefined();
    expect(host.metadata.planReviewEntryId).toBeUndefined();

    // The gate is re-armed for the thread's next plan, not stuck denying.
    await emitPlan(host, planInteraction("# Next plan", "pint-3"));
    expect(host.sends).toHaveLength(2);
    expect(host.resolutions.map((r) => r.interactionId)).toEqual(["pint-1", "pint-3"]);
    await host.harness.dispose();
  });

  it("withdraws a review still queued past the stale window and releases the plan", async () => {
    const host = createHost({ sendDelivery: "queued", queuedRows: [{ id: "qm-1" }] });
    await plugin(host.bb);
    await emitPlan(host);
    host.metadata.planReviewArmedAt = Date.now() - STALE_WINDOW_MS - 1_000;

    await emitPlan(host, planInteraction("# Plan v2", "pint-2"));
    expect(host.resolutions.map((r) => r.interactionId)).toEqual(["pint-1"]);
    expect(host.deletedQueued).toEqual(["qm-1"]);
    expect(host.metadata.planReviewArmedAt).toBeUndefined();
    expect(host.metadata.planReviewEntryId).toBeUndefined();
    const status = await host.harness.runCli(["status", THREAD_ID, "--json"]);
    expect(JSON.parse(status.stdout).lastFire).toMatchObject({
      outcome: "stood-down",
      reason: "plan-hold-expired",
    });
    await host.harness.dispose();
  });

  it("disarms when the queued plan review is cancelled", async () => {
    const host = createHost({ sendDelivery: "queued" });
    await plugin(host.bb);
    await emitPlan(host);
    await host.harness.behavior.emitThreadEvent("message.cancelled", {
      entry: queueEntry(),
    });
    expect(host.metadata.planReviewArmedAt).toBeUndefined();
    expect(host.metadata.planReviewEntryId).toBeUndefined();
    await emitPlan(host, planInteraction("# Plan", "pint-2"));
    expect(host.sends).toHaveLength(2);
    await host.harness.dispose();
  });

  it("keeps the plan gate armed through a code-review idle reset", async () => {
    const host = createHost({ sendDelivery: "queued" });
    await plugin(host.bb);
    await emitPlan(host);
    await emitIdle(host);
    expect(typeof host.metadata.planReviewArmedAt).toBe("number");
    await host.harness.dispose();
  });

  it("passes a commit plan straight through", async () => {
    const host = createHost({ sendDelivery: "queued" });
    await plugin(host.bb);
    await emitPlan(host, planInteraction("## Commit Plan\n<!-- devkit:commit-plan -->\n- a"));
    expect(host.sends).toHaveLength(0);
    expect(host.resolutions).toHaveLength(0);
    expect(host.metadata.planReviewArmedAt).toBeUndefined();
    await host.harness.dispose();
  });

  it("leaves the plan alone when auto-review is skipped for the thread", async () => {
    const host = createHost({ sendDelivery: "queued" });
    await plugin(host.bb);
    await host.harness.runCli(["skip", THREAD_ID]);
    await emitPlan(host);
    expect(host.sends).toHaveLength(0);
    expect(host.resolutions).toHaveLength(0);
    await host.harness.dispose();
  });

  it("ignores approvals that are not plans", async () => {
    const host = createHost({ sendDelivery: "queued" });
    await plugin(host.bb);
    const interaction = planInteraction();
    await emitPlan(host, {
      ...interaction,
      payload: {
        ...interaction.payload,
        subject: { kind: "file_change", itemId: "i", writeScope: null, sessionGrant: null },
      },
    } as never);
    expect(host.sends).toHaveLength(0);
    expect(host.resolutions).toHaveLength(0);
    await host.harness.dispose();
  });

  it("withdraws the queued review and disarms when the deny fails", async () => {
    const host = createHost({ sendDelivery: "queued", resolveThrows: true });
    await plugin(host.bb);
    const { errors } = await emitPlan(host);
    expect(errors).toEqual([]);
    expect(host.deletedQueued).toEqual(["qm-1"]);
    expect(host.metadata.planReviewArmedAt).toBeUndefined();
    expect(host.metadata.planReviewEntryId).toBeUndefined();
    await host.harness.dispose();
  });

  it("does not deny the plan when the review cannot be queued", async () => {
    const host = createHost({ sendThrows: true });
    await plugin(host.bb);
    const { errors } = await emitPlan(host);
    expect(errors).toEqual([]);
    expect(host.resolutions).toHaveLength(0);
    expect(host.metadata.planReviewArmedAt).toBeUndefined();
    await host.harness.dispose();
  });

  it("reports status for a thread named by argument", async () => {
    const host = createHost();
    await plugin(host.bb);
    const result = await host.harness.runCli(["status", THREAD_ID, "--json"]);
    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout ?? "") as {
      threadId: string;
      enabled: boolean;
      phase: string;
    };
    expect(payload.threadId).toBe(THREAD_ID);
    expect(payload.enabled).toBe(true);
    expect(payload.phase).toBe("idle");
    await host.harness.dispose();
  });

  it("rejects enable with both --global and --project", async () => {
    const host = createHost();
    await plugin(host.bb);
    const result = await host.harness.runCli([
      "enable",
      "--global",
      "--project",
      "project-1",
    ]);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("only one of");
    await host.harness.dispose();
  });

  it("reset reports whether a latch was actually cleared", async () => {
    const host = createHost();
    await plugin(host.bb);
    const idleReset = await host.harness.runCli(["reset", THREAD_ID]);
    expect(idleReset.stdout).toContain("already idle");

    host.metadata.phase = "awaiting-review";
    const latchedReset = await host.harness.runCli(["reset", THREAD_ID]);
    expect(latchedReset.stdout).toContain("cleared awaiting-review");
    await host.harness.dispose();
  });

  async function lastFireOf(host: Host, id: string = THREAD_ID) {
    const status = await host.harness.runCli(["status", id, "--json"]);
    return JSON.parse(status.stdout).lastFire as Record<string, unknown> | null;
  }

  function warnings(host: Host): string[] {
    return host.harness.logEntries
      .filter((entry) => entry.level === "warn")
      .map((entry) => entry.message);
  }

  it("stands down without a review when the project disabled auto-review", async () => {
    const host = createHost();
    await plugin(host.bb);
    await host.harness.runCli(["disable", "--project", "project-1"]);
    await emitActive(host);
    await emitIdle(host);
    expect(host.sends).toHaveLength(0);
    expect(host.metadata.phase ?? "idle").toBe("idle");
    expect(await lastFireOf(host)).toMatchObject({ outcome: "stood-down", reason: "disabled" });
    await host.harness.dispose();
  });

  it("follows a global settings change without a reload", async () => {
    const host = createHost();
    await plugin(host.bb);
    await host.harness.setSettings({ enabled: false });
    await emitActive(host);
    await emitIdle(host);
    expect(host.sends).toHaveLength(0);
    expect(await lastFireOf(host)).toMatchObject({ reason: "disabled" });

    await host.harness.setSettings({ enabled: true, reviewMode: "self" });
    await emitActive(host);
    await emitIdle(host);
    expect(host.sends).toHaveLength(1);
    expect(promptText(host)).toContain("focused self-review of the diff");
    expect(promptText(host)).not.toContain("devkit_load_skill");
    await host.harness.dispose();
  });

  it("asks top-level user threads to present a plan outside plan mode while auto-review is on", async () => {
    const host = createHost();
    await plugin(host.bb);
    const resolve = (parentThreadId: string | null, pluginId: string | null) =>
      host.harness.resolveAgentConfiguration(
        makePluginAgentConfigurationContext({
          thread: { id: THREAD_ID, parentThreadId },
          origin: { kind: pluginId === null ? null : "fork", pluginId },
        }),
      );

    expect(await resolve(null, null)).toEqual({
      tools: [],
      skills: ["auto-review"],
      instructions: PLAN_FIRST_INSTRUCTIONS,
    });
    // The plan gate never serves these, so they keep the skill but get no instruction.
    for (const [parentThreadId, pluginId] of [["parent-1", null], [null, "side-chat"]] as const) {
      expect(await resolve(parentThreadId, pluginId)).toEqual({
        tools: [],
        skills: ["auto-review"],
        instructions: null,
      });
    }

    await host.harness.setSettings({ enabled: false });
    expect((await resolve(null, null)).instructions).toBeNull();
    await host.harness.dispose();
  });

  it("stands down when the workspace status cannot be read", async () => {
    const host = createHost({ statusUnavailable: true });
    await plugin(host.bb);
    await emitActive(host);
    // No tree snapshot is possible, so the turn start carries the cursor alone.
    expect(host.metadata.turnStart).toEqual({ sinceSeq: 100, startedAt: expect.any(Number) });
    await emitIdle(host);
    expect(host.sends).toHaveLength(0);
    expect(await lastFireOf(host)).toMatchObject({
      outcome: "stood-down",
      reason: "status-unavailable",
    });
    await host.harness.dispose();
  });

  it("stands down on a checkout that is not a branch", async () => {
    const host = createHost({ checkoutKind: "detached" });
    await plugin(host.bb);
    await emitActive(host);
    await emitIdle(host);
    expect(host.sends).toHaveLength(0);
    expect(await lastFireOf(host)).toMatchObject({ reason: "not-a-branch" });
    await host.harness.dispose();
  });

  it("ignores turns of threads outside the gate, such as subagents", async () => {
    const host = createHost();
    await plugin(host.bb);
    const subagent = makeThreadResponse({
      id: THREAD_ID,
      environmentId: ENV_ID,
      providerId: "claude-code",
      parentThreadId: "parent-1",
    });
    await host.harness.behavior.emitThreadEvent("thread.active", { thread: subagent });
    await host.harness.behavior.emitThreadEvent("thread.idle", {
      thread: subagent,
      lastAssistantText: null,
    });
    expect(host.metadata).toEqual({});
    expect(host.sends).toHaveLength(0);
    expect(await lastFireOf(host)).toBeNull();
    await host.harness.dispose();
  });

  it("prunes a review index entry whose thread is gone instead of deferring behind it", async () => {
    const host = createHost({ getThrowsFor: ["ghost"] });
    await plugin(host.bb);
    await startReview(host, "ghost");
    await emitActive(host);
    await emitIdle(host);
    expect(host.sends).toHaveLength(1);
    expect(host.metadata.phase).toBe("awaiting-review");
    expect(await host.bb.storage.kv.list("review:")).toEqual([`review:${THREAD_ID}`]);
    await host.harness.dispose();
  });

  it("prunes a review index entry whose thread no longer holds a review", async () => {
    const host = createHost();
    await plugin(host.bb);
    await startReview(host, SIBLING_ID);
    endReview(host, SIBLING_ID);
    await emitActive(host);
    await emitIdle(host);
    expect(host.sends).toHaveLength(1);
    expect(await host.bb.storage.kv.list("review:")).toEqual([`review:${THREAD_ID}`]);
    await host.harness.dispose();
  });

  it("leaves a legacy parked entry whose thread is gone to the sweep", async () => {
    const host = createHost({ getThrowsFor: [SIBLING_ID] });
    await plugin(host.bb);
    await park(host, SIBLING_ID, null);
    const idle = await emitIdle(host, "thread-3");
    expect(idle.errors).toEqual([]);
    expect(host.sends).toHaveLength(0);
    expect(await host.bb.storage.kv.list("deferral:")).toEqual([`deferral:${SIBLING_ID}`]);

    await host.harness.runSchedule("sweep-deferrals");
    expect(await host.bb.storage.kv.list("deferral:")).toEqual([]);
    expect(host.metadataFor(SIBLING_ID).phase).toBe("idle");
    await host.harness.dispose();
  });

  it("drops a released index entry whose thread already left deferred", async () => {
    const host = createHost();
    await plugin(host.bb);
    await park(host, SIBLING_ID);
    host.metadataFor(SIBLING_ID).phase = "idle";
    await emitIdle(host, "thread-3");
    expect(host.sends).toHaveLength(0);
    expect(await host.bb.storage.kv.list("deferral:")).toEqual([]);
    await host.harness.dispose();
  });

  it("logs and keeps a parked turn a release cannot resolve", async () => {
    const host = createHost({ getThrowsFor: [SIBLING_ID] });
    await plugin(host.bb);
    await park(host, SIBLING_ID);
    const idle = await emitIdle(host, "thread-3");
    expect(idle.errors).toEqual([]);
    expect(host.sends).toHaveLength(0);
    expect(host.metadataFor(SIBLING_ID).phase).toBe("deferred");
    expect(await host.bb.storage.kv.list("deferral:")).toEqual([`deferral:${SIBLING_ID}`]);
    expect(warnings(host)).toContainEqual(
      expect.stringContaining(`could not release deferred thread ${SIBLING_ID}: thread ${SIBLING_ID} is gone`),
    );
    await host.harness.dispose();
  });

  it("sweeps out, unparked, a parked thread that no longer passes the gate", async () => {
    const host = createHost({ hiddenThreads: [THREAD_ID] });
    await plugin(host.bb);
    await park(host, THREAD_ID);
    await host.harness.runSchedule("sweep-deferrals");
    expect(host.sends).toHaveLength(0);
    expect(host.metadata.phase).toBe("idle");
    expect(host.metadata.turnStart).toBeUndefined();
    expect(await host.bb.storage.kv.list("deferral:")).toEqual([]);
    expect(warnings(host)).toContainEqual(
      expect.stringContaining("thread no longer passes the auto-review thread gate"),
    );
    await host.harness.dispose();
  });

  it("prunes a swept index entry whose thread already left deferred", async () => {
    const host = createHost();
    await plugin(host.bb);
    await park(host, THREAD_ID);
    // The state moved on, but the index entry was left behind.
    host.metadata.phase = "idle";
    await host.harness.runSchedule("sweep-deferrals");
    expect(host.sends).toHaveLength(0);
    expect(await host.bb.storage.kv.list("deferral:")).toEqual([]);
    await host.harness.dispose();
  });

  it("ignores the cancel of a queued message that is not its review", async () => {
    const host = createHost({ sendDelivery: "queued" });
    await plugin(host.bb);
    await emitActive(host);
    await emitIdle(host);
    expect(host.metadata.phase).toBe("pending-dispatch");

    await host.harness.behavior.emitThreadEvent("message.cancelled", {
      entry: makeQueueEntry({ id: "qm-other", threadId: THREAD_ID }),
    });
    expect(host.metadata.phase).toBe("pending-dispatch");
    expect(host.metadata.pendingEntryId).toBe("qm-1");
    expect(await host.bb.storage.kv.list("review:")).toEqual([`review:${THREAD_ID}`]);
    await host.harness.dispose();
  });

  it("releases the parked turn when a cancelled review frees its provider", async () => {
    const host = createHost({ sendDelivery: "queued" });
    await plugin(host.bb);
    await emitActive(host);
    await emitIdle(host);
    await park(host, SIBLING_ID);
    host.setSiblingRows(SIBLING_ID, [fileChangeRow("src/a.ts")]);

    await host.harness.behavior.emitThreadEvent("message.cancelled", {
      entry: queueEntry(),
    });
    expect(host.metadata.phase).toBe("idle");
    expect(host.sends.map((send) => send.threadId)).toEqual([THREAD_ID, SIBLING_ID]);
    expect(host.metadataFor(SIBLING_ID).phase).toBe("pending-dispatch");
    await host.harness.dispose();
  });

  it.each(["thread.archived", "thread.deleted"] as const)(
    "unlatches a reviewing thread on %s and releases the turn parked behind it",
    async (event) => {
      const host = createHost();
      await plugin(host.bb);
      await startReview(host, SIBLING_ID);
      await emitActive(host);
      await emitIdle(host);
      expect(host.metadata.phase).toBe("deferred");

      const result = await host.harness.behavior.emitThreadEvent(event, {
        thread: thread(SIBLING_ID),
      } as never);
      expect(result.errors).toEqual([]);
      expect(host.metadataFor(SIBLING_ID).phase).toBe("idle");
      expect(host.metadataFor(SIBLING_ID).dispatchedAt).toBeUndefined();
      expect(host.sends.map((send) => send.threadId)).toEqual([THREAD_ID]);
      expect(await host.bb.storage.kv.list("review:")).toEqual([`review:${THREAD_ID}`]);
      await host.harness.dispose();
    },
  );

  it("still disarms when the failed deny's queued review cannot be withdrawn", async () => {
    const host = createHost({
      sendDelivery: "queued",
      resolveThrows: true,
      deleteQueuedThrows: true,
    });
    await plugin(host.bb);
    const { errors } = await emitPlan(host);
    expect(errors).toEqual([]);
    expect(host.deletedQueued).toEqual([]);
    expect(host.metadata.planReviewArmedAt).toBeUndefined();
    expect(host.metadata.planReviewEntryId).toBeUndefined();
    expect(warnings(host)).toContainEqual(
      expect.stringContaining(
        `could not withdraw the queued plan review qm-1 in ${THREAD_ID}: already dispatched`,
      ),
    );
    expect(await lastFireOf(host)).toMatchObject({ reason: "send-failed" });
    await host.harness.dispose();
  });
});
