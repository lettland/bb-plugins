import { describe, expect, it } from "vitest";

import { createOwnershipReader, isAttachedChild, ownershipReaderFor, subtreeIds, threadMembership } from "./detect-attached.js";
import { runningChildIds, spawnedDescendantEntries } from "./detect-children.js";
import { kinEvidence, siblingAuthoredPaths } from "./detect-timeline.js";

/**
 * Regression, learned from thr_jyuay4qg8s: a thread created top-level and later
 * attached under another (a `thread update --parent-thread`) is not part of the
 * parent's family. The signal is the child's own `system/operation` event with
 * `operation: "ownership_change"`. Reported in thr_8rryqyy9me.
 */

const LEAK = "leak-token-77c1";
/** When the ownership changes were made; a row from half an hour before it on counts. */
const CHANGED_AT = 5_000_000;
const noSubtree = async (): Promise<string[]> => [];
/** A command row that runs `bb thread update`, started when the ownership changes were made. */
const updateRow = () => ({
  kind: "work",
  workKind: "command",
  status: "completed",
  approvalStatus: null,
  command: "bb thread update --self --parent-thread self",
  cwd: "",
  threadId: "t",
  startedAt: CHANGED_AT,
  createdAt: CHANGED_AT,
  completedAt: CHANGED_AT + 10,
});

interface Entry {
  id: string;
  parentThreadId: string | null;
  lifecycleOwnerThreadId: string | null;
  originPluginId: string | null;
  archivedAt: number | null;
  deletedAt: number | null;
  status: string;
  updatedAt: number;
}

const entry = (id: string, extra: Partial<Entry> = {}): Entry => ({
  id,
  parentThreadId: null,
  lifecycleOwnerThreadId: null,
  originPluginId: null,
  archivedAt: null,
  deletedAt: null,
  status: "idle",
  updatedAt: 50_000,
  ...extra,
});

/** An ownership change as the event log carries it. */
const change = (seq: number, previous: string | null, next: string | null, operation = "ownership_change") => ({
  seq,
  createdAt: CHANGED_AT + seq,
  type: "system/operation",
  scope: { kind: "thread" },
  data: {
    operation,
    operationId: `op-${seq}`,
    status: "completed",
    message: `${LEAK} moved`,
    metadata: { action: "assign", previousParentThreadId: previous, nextParentThreadId: next },
  },
});

type Events = Record<string, unknown[] | Error>;

function fakeBb(entries: Entry[], events: Events = {}, rows: Events = {}) {
  const infos: string[] = [];
  const reads: string[] = [];
  const bb = {
    log: { info: (message: string) => infos.push(message) },
    sdk: {
      threads: {
        list: async (args: { parentThreadId?: string }) => entries.filter((candidate) => candidate.parentThreadId === args.parentThreadId),
        events: {
          list: async ({ threadId, types }: { threadId: string; types: string[] }) => {
            reads.push(threadId);
            expect(types).toEqual(["system/operation"]);
            const served = events[threadId] ?? [];
            if (served instanceof Error) {
              throw served;
            }
            return served;
          },
        },
        timeline: async ({ threadId }: { threadId: string }) => {
          const served = rows[threadId] ?? [];
          if (served instanceof Error) {
            throw served;
          }
          return { rows: served, maxSeq: 0, timelinePage: { historySnapshot: "default", olderCursor: null, returnedSegmentCount: 0 } };
        },
      },
    },
  } as never;
  return { bb, infos, reads };
}

describe("isAttachedChild: the rule table", () => {
  const family = new Set(["parent"]);
  const child = entry("kid", { parentThreadId: "parent" });
  const attached = async (events: unknown[] | Error, over: Partial<Entry> = {}, members = family) => {
    const { bb, infos } = fakeBb([], { kid: events });
    return { yes: await isAttachedChild(bb, createOwnershipReader(bb), { ...child, ...over }, members, noSubtree), infos };
  };

  it("is attached when created top-level and later assigned to the parent", async () => {
    const { yes, infos } = await attached([change(5, null, "parent")]);
    expect(yes).toBe(true);
    expect(infos).toEqual(["auto-review: thread kid was attached under parent at seq 5; it is not part of that thread's family"]);
  });

  it("is family when it was spawned: no ownership change at all", async () => {
    expect((await attached([])).yes).toBe(false);
  });

  it("is family when it was moved away and moved back", async () => {
    expect((await attached([change(5, "parent", "other"), change(6, "other", "parent")])).yes).toBe(false);
  });

  it("is family when it was spawned under the parent, detached and attached elsewhere", async () => {
    expect((await attached([change(5, "parent", null), change(6, null, "other")], { parentThreadId: "other" }, new Set(["other"]))).yes).toBe(false);
  });

  it("is attached when it was created top-level, moved and moved back", async () => {
    // Its earliest change has no previous parent and its latest names the current parent.
    expect((await attached([change(5, null, "other"), change(6, "other", "parent")])).yes).toBe(true);
  });

  it("is family when its latest change names another parent than the current one", async () => {
    expect((await attached([change(5, null, "other")])).yes).toBe(false);
  });

  it("is family when its lifecycle owner is in the family", async () => {
    expect((await attached([change(5, null, "parent")], { lifecycleOwnerThreadId: "parent" })).yes).toBe(false);
  });

  it("is attached when its lifecycle owner is outside the family", async () => {
    expect((await attached([change(5, null, "parent")], { lifecycleOwnerThreadId: "elsewhere" })).yes).toBe(true);
  });

  it("is not a child at all without a parent", async () => {
    expect((await attached([change(5, null, "parent")], { parentThreadId: null })).yes).toBe(false);
  });

  it("matches the operation, not any other system operation or its text", async () => {
    expect((await attached([change(5, null, "parent", "workspace_ready")])).yes).toBe(false);
  });

  it("is family when the read fails, and logs the error class only", async () => {
    class Boom extends Error {
      override name = "Boom";
    }
    const { yes, infos } = await attached(new Boom(`${LEAK} /secret/path`));
    expect(yes).toBe(false);
    expect(infos).toEqual(["auto-review: could not read the ownership changes of thread kid: Boom"]);
  });

  it("names the type of a failure that is not an error", async () => {
    const { bb, infos } = fakeBb([]);
    (bb as { sdk: { threads: { events: { list: unknown } } } }).sdk.threads.events.list = async () => {
      throw LEAK;
    };
    expect(await isAttachedChild(bb, createOwnershipReader(bb), entry("kid", { parentThreadId: "parent" }), new Set(["parent"]), noSubtree)).toBe(false);
    expect(infos).toEqual(["auto-review: could not read the ownership changes of thread kid: string"]);
  });

  it("is family when a change carries no readable parent, or no metadata", async () => {
    const odd = { ...change(5, null, "parent"), data: { ...change(5, null, "parent").data, metadata: { previousParentThreadId: null } } };
    expect((await attached([odd])).yes).toBe(false);
    const bare = { ...change(5, null, "parent"), data: { operation: "ownership_change", operationId: "o", status: "x", message: "m" } };
    expect((await attached([bare])).yes).toBe(false);
    const listed = { ...change(5, null, "parent"), data: { ...change(5, null, "parent").data, metadata: [] } };
    expect((await attached([listed])).yes).toBe(false);
  });

  it("is family when the walk hits the page cap", async () => {
    const full = Array.from({ length: 100 }, (_, at) => change(at + 1, null, "parent", "other_operation"));
    const { bb, infos } = fakeBb([], { kid: full });
    expect(await isAttachedChild(bb, createOwnershipReader(bb), child, family, noSubtree)).toBe(false);
    expect(infos[0]).toMatch(/^auto-review: could not read the ownership changes of thread kid: Error$/u);
  });

  it("reads once per reader, and logs one attach per pair", async () => {
    const { bb, infos, reads } = fakeBb([], { kid: [change(5, null, "parent")] });
    const reader = createOwnershipReader(bb);
    await isAttachedChild(bb, reader, child, family, noSubtree);
    await isAttachedChild(bb, reader, child, family, noSubtree);
    expect(reads).toEqual(["kid"]);
    expect(infos).toHaveLength(1);
  });

  it("shares one reader per thread list and bb, and no other", () => {
    const { bb } = fakeBb([]);
    const { bb: other } = fakeBb([]);
    const list = [entry("a")] as never;
    expect(ownershipReaderFor(bb, list)).toBe(ownershipReaderFor(bb, list));
    expect(ownershipReaderFor(other, list)).not.toBe(ownershipReaderFor(bb, list));
    expect(ownershipReaderFor(bb, [entry("a")] as never)).not.toBe(ownershipReaderFor(bb, list));
  });
});

describe("a thread that can move itself is never attached", () => {
  // The review of the first round: a child that ran `bb thread update --parent-thread` may have attached
  // itself under a parent to leave its own review, so it stays in the family. Read as commands, never as text.
  const family = new Set(["parent"]);
  const attach = [change(5, null, "parent")];
  const work = (command: string, startedAt = CHANGED_AT, over: Record<string, unknown> = {}) => ({
    kind: "work",
    workKind: "command",
    status: "completed",
    approvalStatus: null,
    command,
    cwd: "",
    threadId: "t",
    startedAt,
    createdAt: startedAt,
    completedAt: startedAt + 10,
    ...over,
  });
  const verdict = async (rows: Events, subtree: string[] = [], events: Events = { kid: attach }) => {
    const { bb, infos } = fakeBb([], events, rows);
    const yes = await isAttachedChild(bb, createOwnershipReader(bb), entry("kid", { parentThreadId: "parent" }), family, async () => subtree);
    return { yes, infos };
  };

  it("is family when the child ran bb thread update on itself", async () => {
    expect((await verdict({ kid: [work("bb thread update --self --parent-thread parent")] })).yes).toBe(false);
  });

  it("is family when it ran it through a wrapper, a shell string or the variable that holds the path", async () => {
    for (const text of [
      "timeout 5 bb thread update --self --visibility hidden",
      "sh -c 'bb thread update --self --clear-parent-thread'",
      '"$BB_CLI" thread update --self --title x',
      "cd /w && vbb thread update thr_1 --parent-thread x",
    ]) {
      expect((await verdict({ kid: [work(text)] })).yes, text).toBe(false);
    }
  });

  it("is family when the update was run in a tool row's command field", async () => {
    const tool = { ...work("x"), workKind: "tool", toolName: "Bash", toolArgs: { command: "bb thread update --self --parent-thread parent" } };
    expect((await verdict({ kid: [tool] })).yes).toBe(false);
  });

  it("is family when a thread in the child's subtree ran it", async () => {
    expect((await verdict({ grand: [work("bb thread update --self --parent-thread parent")] }, ["grand"])).yes).toBe(false);
  });

  it("is attached when an outside thread attached it: no row of the child or its subtree runs the update", async () => {
    // `bb thread updates` is no known subcommand, so it is opaque: it ran long before the change, which does not count.
    const rows = {
      kid: [work("bb thread show thr_1"), work("bb thread updates x", CHANGED_AT - 20 * 60_000), work("echo bb thread update")],
      grand: [work("npm test")],
    };
    expect((await verdict(rows, ["grand"])).yes).toBe(true);
  });

  it("is family when an opaque row of the child was running when the ownership changed: a script can run the update with no bb in its text", async () => {
    // Window with its slack: 10 s before the change to 10 s after.
    const running = work("node move.js", CHANGED_AT + 5 * 1_000 - 10_000, { completedAt: CHANGED_AT + 5_000 });
    expect((await verdict({ kid: [running] })).yes).toBe(false);
    // A row of the subtree counts as well, and so does one with no recorded end that began before the change.
    expect((await verdict({ grand: [running] }, ["grand"])).yes).toBe(false);
    expect((await verdict({ kid: [work("node move.js", CHANGED_AT - 60_000, { completedAt: null })] })).yes).toBe(false);
    expect((await verdict({ kid: [work("node move.js", CHANGED_AT - 60_000, { completedAt: undefined, status: "pending" })] })).yes).toBe(false);
  });

  it("stays attached when the opaque row ran only after the change, as a daemon started after the attach does", async () => {
    expect((await verdict({ kid: [work("(some-daemon --port 1 &)", CHANGED_AT + 60_000)] })).yes).toBe(true);
  });

  it("stays attached when the opaque row ended well before the change", async () => {
    expect((await verdict({ kid: [work("(some-daemon --port 1 &)", CHANGED_AT - 600_000)] })).yes).toBe(true);
  });

  it("does not count a read-only row that was running when the ownership changed", async () => {
    expect((await verdict({ kid: [work("rg foo lib", CHANGED_AT - 1_000, { completedAt: CHANGED_AT + 1_000 })] })).yes).toBe(true);
  });

  it("does not count an update older than half an hour before the change", async () => {
    expect((await verdict({ kid: [work("bb thread update --self --title x", CHANGED_AT - 40 * 60_000)] })).yes).toBe(true);
  });

  it("is family when a row that began over half an hour before the change was still running at it (closure review, thr_8rryqyy9me)", async () => {
    const stillRunning = { completedAt: CHANGED_AT + 5_000 };
    expect((await verdict({ kid: [work("node move.js", CHANGED_AT - 40 * 60_000, stillRunning)] })).yes).toBe(false);
    expect((await verdict({ kid: [work("bb thread update --self --parent-thread p", CHANGED_AT - 40 * 60_000, stillRunning)] })).yes).toBe(false);
  });

  it("is family when a row that writes, not only an opaque one, was running when the ownership changed", async () => {
    expect((await verdict({ kid: [work("printf x > note.txt", CHANGED_AT - 1_000, { completedAt: CHANGED_AT + 1_000 })] })).yes).toBe(false);
  });

  it("is family when the child's rows cannot be read, or a subtree thread's, or the subtree cannot be listed", async () => {
    expect((await verdict({ kid: new TypeError(LEAK) })).yes).toBe(false);
    expect((await verdict({ grand: new RangeError(LEAK) }, ["grand"])).yes).toBe(false);
    const { bb, infos } = fakeBb([], { kid: attach });
    const yes = await isAttachedChild(bb, createOwnershipReader(bb), entry("kid", { parentThreadId: "parent" }), family, async () => {
      throw new RangeError(LEAK);
    });
    expect(yes).toBe(false);
    expect(infos).toContain("auto-review: could not check whether thread kid or its subtree changed its own parent: RangeError");
    expect(JSON.stringify(infos)).not.toContain(LEAK);
  });

  it("is family when a read is truncated: the rows could be older than the page cap", async () => {
    const { bb, infos } = fakeBb([], { kid: attach });
    (bb as { sdk: { threads: { timeline: unknown } } }).sdk.threads.timeline = async () => ({
      rows: [],
      maxSeq: 0,
      timelinePage: { historySnapshot: "default", olderCursor: { anchorId: "a", anchorSeq: 1 }, returnedSegmentCount: 1 },
    });
    const yes = await isAttachedChild(bb, createOwnershipReader(bb), entry("kid", { parentThreadId: "parent" }), family, noSubtree);
    expect(yes).toBe(false);
    expect(infos).toContain("auto-review: could not read the rows of thread kid to see whether it changed its own parent");
  });

  it("is family when the text is too long to read", async () => {
    expect((await verdict({ kid: [work(`echo ${"x".repeat(70_000)}`)] })).yes).toBe(false);
  });

  it("reads the rows once per child", async () => {
    const { bb } = fakeBb([], { kid: attach });
    let reads = 0;
    (bb as { sdk: { threads: { timeline: unknown } } }).sdk.threads.timeline = async () => {
      reads += 1;
      return { rows: [], maxSeq: 0, timelinePage: { historySnapshot: "default", olderCursor: null, returnedSegmentCount: 0 } };
    };
    const reader = createOwnershipReader(bb);
    const kid = entry("kid", { parentThreadId: "parent" });
    await isAttachedChild(bb, reader, kid, family, noSubtree);
    await isAttachedChild(bb, reader, kid, family, noSubtree);
    expect(reads).toBe(1);
  });

  it("walks the subtree through the thread list, in any environment, hidden threads included", async () => {
    const calls: unknown[] = [];
    const { bb } = fakeBb([entry("grand", { parentThreadId: "kid" })], { kid: attach }, { grand: [work("bb thread update --self --parent-thread parent")] });
    const list = (bb as { sdk: { threads: { list: (args: unknown) => Promise<unknown[]> } } }).sdk.threads;
    const original = list.list;
    list.list = async (args) => {
      calls.push(args);
      return original(args);
    };
    expect(await isAttachedChild(bb, createOwnershipReader(bb), entry("kid", { parentThreadId: "parent" }), family, () => subtreeIds(bb, "kid"))).toBe(false);
    expect(calls).toEqual([{ parentThreadId: "kid", includeHidden: true }, { parentThreadId: "grand", includeHidden: true }]);
  });

  it("keeps the child in the family when the subtree list fails", async () => {
    const { bb, infos } = fakeBb([], { kid: attach });
    (bb as { sdk: { threads: { list: unknown } } }).sdk.threads.list = async () => {
      throw new RangeError(LEAK);
    };
    expect(await isAttachedChild(bb, createOwnershipReader(bb), entry("kid", { parentThreadId: "parent" }), family, () => subtreeIds(bb, "kid"))).toBe(false);
    expect(infos).toContain("auto-review: could not check whether thread kid or its subtree changed its own parent: RangeError");
    expect(JSON.stringify(infos)).not.toContain(LEAK);
  });

  it("keeps the child in the family when its subtree is over 200 threads, and checks one of exactly 200", async () => {
    const below = (count: number) => Array.from({ length: count }, (_, at) => entry(`t${at}`, { parentThreadId: "kid" }));
    const walk = async (count: number) => {
      const { bb } = fakeBb(below(count), { kid: attach });
      return isAttachedChild(bb, createOwnershipReader(bb), entry("kid", { parentThreadId: "parent" }), family, () => subtreeIds(bb, "kid"));
    };
    expect(await walk(200)).toBe(true);
    expect(await walk(201)).toBe(false);
  });

  it("threadMembership keeps such a child, and a thread below it, in the family", async () => {
    const entries = [entry("self"), entry("kid", { parentThreadId: "self" }), entry("grand", { parentThreadId: "kid" }), entry("other", { parentThreadId: "self" })];
    const { bb } = fakeBb(
      entries,
      { kid: [change(5, null, "self")], other: [change(6, null, "self")] },
      { grand: [work("bb thread update --self --parent-thread self")] },
    );
    const { family: members, attached } = await threadMembership(bb, entries as never, "self");
    // `kid` is family because its subtree thread ran the update; `grand` is then family below it, and `other` is attached.
    expect([...members].sort()).toEqual(["grand", "kid", "self"]);
    expect([...attached]).toEqual(["other"]);
  });
});

describe("threadMembership", () => {
  it("keeps a spawned child and a lifecycle-owned helper, and splits off an attached child", async () => {
    const entries = [
      entry("self"),
      entry("spawned", { parentThreadId: "self" }),
      entry("owned", { lifecycleOwnerThreadId: "self" }),
      entry("attached", { parentThreadId: "self" }),
    ];
    const { bb } = fakeBb(entries, { attached: [change(9, null, "self")] });
    const { family, attached } = await threadMembership(bb, entries as never, "self");
    expect([...family].sort()).toEqual(["owned", "self", "spawned"]);
    expect([...attached]).toEqual(["attached"]);
  });

  it("leaves a grandchild under an attached child out of the family, and with the attached threads", async () => {
    const entries = [
      entry("self"),
      entry("attached", { parentThreadId: "self" }),
      entry("grand", { parentThreadId: "attached" }),
      entry("grand-owned", { lifecycleOwnerThreadId: "attached" }),
    ];
    const { bb } = fakeBb(entries, { attached: [change(9, null, "self")] });
    const { family, attached } = await threadMembership(bb, entries as never, "self");
    expect([...family]).toEqual(["self"]);
    expect([...attached].sort()).toEqual(["attached", "grand", "grand-owned"]);
  });

  it("keeps a thread below an attached child that a family member owns too", async () => {
    const entries = [
      entry("self"),
      entry("attached", { parentThreadId: "self" }),
      entry("shared", { parentThreadId: "attached", lifecycleOwnerThreadId: "self" }),
    ];
    const { bb } = fakeBb(entries, { attached: [change(9, null, "self")] });
    const { family, attached } = await threadMembership(bb, entries as never, "self");
    expect([...family].sort()).toEqual(["self", "shared"]);
    expect([...attached]).toEqual(["attached"]);
  });

  it("draws the verdict again once a later family member owns the child", async () => {
    // `late` is listed before the lifecycle owner that makes it family, which joins in a later pass.
    const entries = [
      entry("self"),
      entry("late", { parentThreadId: "self", lifecycleOwnerThreadId: "owner" }),
      entry("owner", { parentThreadId: "self" }),
    ];
    const { bb } = fakeBb(entries, { late: [change(9, null, "self")] });
    const { family, attached } = await threadMembership(bb, entries as never, "self");
    expect([...family].sort()).toEqual(["late", "owner", "self"]);
    expect(attached.size).toBe(0);
  });
});

describe("the walks apply the attached filter with their own link rules", () => {
  const entries = [
    entry("self"),
    entry("spawned", { parentThreadId: "self", status: "active" }),
    entry("attached", { parentThreadId: "self", status: "active" }),
    entry("grand", { parentThreadId: "attached", status: "active" }),
    entry("advisor", { parentThreadId: "self", status: "active", originPluginId: "advisor" }),
  ];
  const events = { attached: [change(9, null, "self")] };

  it("spawnedDescendants and runningChildIds skip an attached child and what is below it, and a plugin helper", async () => {
    const { bb } = fakeBb(entries, events);
    expect((await spawnedDescendantEntries(bb, "self")).map(({ id }) => id)).toEqual(["spawned"]);
    expect(await runningChildIds(bb, "self")).toEqual(["spawned"]);
  });

  it("a child spawned instead of attached still holds the turn", async () => {
    const { bb } = fakeBb(entries, {});
    expect(await runningChildIds(bb, "self")).toEqual(["spawned", "attached", "grand"]);
  });

  it("spawnedDescendants reads the subtree through parent links, and skips a row the list returns that is not the parent's child", async () => {
    // The list ignores its filter, as a buggy list call might: only real children count, and a thread already seen is not walked twice.
    const all = [
      entry("self"),
      entry("kid", { parentThreadId: "self", status: "active" }),
      entry("grand", { parentThreadId: "kid", status: "active" }),
      entry("stray", { parentThreadId: null, status: "active" }),
    ];
    const run = (rows: Events) => {
      const { bb } = fakeBb(all, { kid: [change(9, null, "self")] }, rows);
      (bb as { sdk: { threads: { list: unknown } } }).sdk.threads.list = async () => all;
      return runningChildIds(bb, "self");
    };
    // `stray` is no part of kid's subtree, so its update does not count; `grand` is, so its update does.
    expect(await run({ stray: [updateRow()] })).toEqual([]);
    expect(await run({ grand: [updateRow()] })).toEqual(["kid", "grand"]);
  });

  it("a child whose subtree is over 200 threads stays family and still holds the turn", async () => {
    const many = Array.from({ length: 201 }, (_, at) => entry(`t${at}`, { parentThreadId: "kid", status: "idle", originPluginId: "helper" }));
    const all = [entry("self"), entry("kid", { parentThreadId: "self", status: "active" }), ...many];
    const { bb } = fakeBb(all, { kid: [change(9, null, "self")] });
    expect(await runningChildIds(bb, "self")).toEqual(["kid"]);
  });

  it("pins the difference between the walks: a child owned through a lifecycle link only is attached to spawnedDescendants and family to threadMembership", async () => {
    // `owner` is family only because `self` owns it (a lifecycle link); `kid` is parented to `self` and owned by `owner`.
    // spawnedDescendants follows `parentThreadId` links only, so `owner` is not in its visited set and `kid` reads as attached there.
    const pair = [
      entry("self"),
      entry("owner", { lifecycleOwnerThreadId: "self", status: "active" }),
      entry("kid", { parentThreadId: "self", lifecycleOwnerThreadId: "owner", status: "active" }),
    ];
    const { bb } = fakeBb(pair, { kid: [change(9, null, "self")] });
    expect((await spawnedDescendantEntries(bb, "self")).map(({ id }) => id)).toEqual([]);
    expect([...(await threadMembership(bb, pair as never, "self")).family].sort()).toEqual(["kid", "owner", "self"]);
  });

  it("kinEvidence adds only an attached thread's own tool edits: no windows, text, thread or incompleteness", async () => {
    const edit = (path: string) => ({ kind: "work", workKind: "file-change", createdAt: 20_000, change: { path, movePath: null } });
    const command = { kind: "work", workKind: "command", status: "completed", approvalStatus: null, command: "node x.js", cwd: "", startedAt: 20_000, createdAt: 20_000, completedAt: 21_000 };
    const { bb } = fakeBb(entries, events);
    const rows: Record<string, unknown[]> = { attached: [edit("by-attached.ts"), command], spawned: [edit("by-spawned.ts"), { ...command, command: "node y.js" }] };
    (bb as { sdk: { threads: { timeline: unknown } } }).sdk.threads.timeline = async ({ threadId }: { threadId: string }) => ({
      rows: rows[threadId] ?? [],
      maxSeq: 0,
      timelinePage: { historySnapshot: "default", olderCursor: null, returnedSegmentCount: 1 },
    });
    const evidence = await kinEvidence(bb, entries as never, "self", 10_000, 90_000);
    expect([...evidence.paths].sort()).toEqual(["by-attached.ts", "by-spawned.ts"]);
    expect(evidence.threadIds).toEqual(["spawned", "advisor"]);
    expect(evidence.complete).toBe(true);
    expect(evidence.windows).toHaveLength(1);
    expect(evidence.texts.map(({ text }) => text)).toEqual(["node y.js"]);
  });

  it("kinEvidence ignores an attached thread whose timeline cannot be read", async () => {
    const { bb } = fakeBb(entries, events);
    // The first read of the attached thread is the check that it did not move itself; the next one fails.
    let reads = 0;
    (bb as { sdk: { threads: { timeline: unknown } } }).sdk.threads.timeline = async ({ threadId }: { threadId: string }) => {
      if (threadId === "attached" && (reads += 1) > 1) {
        throw new Error(LEAK);
      }
      return { rows: [], maxSeq: 0, timelinePage: { historySnapshot: "default", olderCursor: null, returnedSegmentCount: 0 } };
    };
    const evidence = await kinEvidence(bb, entries as never, "self", 10_000, 90_000);
    expect(evidence.complete).toBe(true);
    expect(evidence.paths.size).toBe(0);
  });

  it("siblingAuthoredPaths skips an attached child's paths but keeps its commands and git on the sibling side", async () => {
    const edit = { kind: "work", workKind: "file-change", createdAt: 20_000, change: { path: "by-attached.ts", movePath: null } };
    const command = { kind: "work", workKind: "command", status: "completed", approvalStatus: null, command: "node gen.js", cwd: "", startedAt: 20_000, createdAt: 20_000, completedAt: 21_000 };
    const { bb } = fakeBb(entries, events);
    (bb as { sdk: { threads: { timeline: unknown } } }).sdk.threads.timeline = async ({ threadId }: { threadId: string }) => ({
      rows: threadId === "attached" ? [edit, command] : [],
      maxSeq: 0,
      timelinePage: { historySnapshot: "default", olderCursor: null, returnedSegmentCount: 1 },
    });
    const evidence = await siblingAuthoredPaths(bb, entries as never, "self", 10_000);
    expect(evidence.paths.size).toBe(0);
    expect(evidence.texts.map(({ threadId, text }) => [threadId, text])).toContainEqual(["attached", "node gen.js"]);
    expect(evidence.rows.has("attached")).toBe(true);
  });
});
