import { describe, expect, it } from "vitest";

import { createOwnershipReader, isAttachedChild, ownershipReaderFor, threadMembership } from "./detect-attached.js";
import { runningChildIds, spawnedDescendantEntries } from "./detect-children.js";
import { kinEvidence, siblingAuthoredPaths } from "./detect-timeline.js";

/**
 * Regression, learned from thr_jyuay4qg8s: a thread created top-level and later
 * attached under another (a `thread update --parent-thread`) is not part of the
 * parent's family. The signal is the child's own `system/operation` event with
 * `operation: "ownership_change"`. Reported in thr_8rryqyy9me.
 */

const LEAK = "leak-token-77c1";

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

function fakeBb(entries: Entry[], events: Events = {}) {
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
        timeline: async () => ({
          rows: [],
          maxSeq: 0,
          timelinePage: { historySnapshot: "default", olderCursor: null, returnedSegmentCount: 0 },
        }),
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
    return { yes: await isAttachedChild(bb, createOwnershipReader(bb), { ...child, ...over }, members), infos };
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
    expect(await isAttachedChild(bb, createOwnershipReader(bb), entry("kid", { parentThreadId: "parent" }), new Set(["parent"]))).toBe(false);
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
    expect(await isAttachedChild(bb, createOwnershipReader(bb), child, family)).toBe(false);
    expect(infos[0]).toMatch(/^auto-review: could not read the ownership changes of thread kid: Error$/u);
  });

  it("reads once per reader, and logs one attach per pair", async () => {
    const { bb, infos, reads } = fakeBb([], { kid: [change(5, null, "parent")] });
    const reader = createOwnershipReader(bb);
    await isAttachedChild(bb, reader, child, family);
    await isAttachedChild(bb, reader, child, family);
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
    (bb as { sdk: { threads: { timeline: unknown } } }).sdk.threads.timeline = async ({ threadId }: { threadId: string }) => {
      if (threadId === "attached") {
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
