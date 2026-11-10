import type { BbPluginApi } from "@get-bb/plugin-sdk";

import { rowEffect } from "./detect-claim.js";
import { runsBbThreadUpdate } from "./detect-claim-shell.js";
import { eventsSince } from "./detect-event-log.js";
import { FAMILY_LOOKBACK_MS, rowsSince } from "./detect-pages.js";
import { rowWindow, shellFields, shellText, walkRows } from "./detect-rows.js";
import type { WorkRow } from "./detect-rows.js";
import type { ThreadListEntry } from "./detect-workspace.js";

/**
 * A thread created top-level and later attached under another with an
 * ownership change is not part of that thread's family: the thread never ran
 * its commands (regression: thr_jyuay4qg8s, an attached child's detached daemon forced its
 * new parent into a sweep and held its turn; reported in thr_8rryqyy9me). The signal is the
 * child's own `system/operation` event with `operation: "ownership_change"`,
 * matched on the event type and that operation, never on message text.
 */

/** What a thread's ownership changes say, or why they could not be read. */
export type OwnershipRead =
  | { kind: "none" }
  | { kind: "failed" }
  | {
      kind: "changed";
      /** The parent before the earliest change; null when the thread was created top-level. */
      firstPrevious: string | null;
      /** The parent after the latest change. */
      lastNext: string | null;
      /** The sequence number of the latest change. */
      seq: number;
      /** When the latest change was made. */
      createdAt: number;
    };

export interface OwnershipReader {
  /** The ownership changes of a thread, read once per reader. */
  read: (threadId: string) => Promise<OwnershipRead>;
  /** The parent-child pairs already logged as attached. */
  logged: Set<string>;
  /** Whether a thread, or one below it, ran `bb thread update` since shortly before its latest ownership change; read once per thread. */
  reparents: Map<string, Promise<boolean>>;
}

/** A parent id of an ownership change: a string, or null for none. Anything else is a read that cannot be trusted. */
function parentIdOf(value: unknown): string | null {
  if (typeof value === "string" || value === null) {
    return value;
  }
  throw new TypeError("an ownership change names a parent that is neither an id nor null");
}

/** The error class only: a message can carry paths or command text. */
export function errorClass(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

async function readOwnership(bb: BbPluginApi, threadId: string): Promise<OwnershipRead> {
  let firstPrevious: string | null | undefined;
  let lastNext: string | null = null;
  let seq = 0;
  let createdAt = 0;
  try {
    for await (const event of eventsSince(bb, threadId, 0, "system/operation")) {
      if (event.data.operation !== "ownership_change") {
        continue;
      }
      const { metadata } = event.data;
      if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata)) {
        throw new TypeError("an ownership change carries no metadata");
      }
      // `??=` would treat the null of a thread created top-level as unset and overwrite it.
      firstPrevious = firstPrevious === undefined ? parentIdOf(metadata.previousParentThreadId) : firstPrevious;
      lastNext = parentIdOf(metadata.nextParentThreadId);
      seq = event.seq;
      createdAt = event.createdAt;
    }
  } catch (error) {
    // A failed or partial read (including the page cap) never decides attachment: the child stays in the family.
    bb.log.info(`auto-review: could not read the ownership changes of thread ${threadId}: ${errorClass(error)}`);
    return { kind: "failed" };
  }
  return firstPrevious === undefined ? { kind: "none" } : { kind: "changed", firstPrevious, lastNext, seq, createdAt };
}

/** A reader that reads each thread's ownership changes once. */
export function createOwnershipReader(bb: BbPluginApi): OwnershipReader {
  const reads = new Map<string, Promise<OwnershipRead>>();
  return {
    read: (threadId) => {
      const known = reads.get(threadId);
      if (known !== undefined) {
        return known;
      }
      const read = readOwnership(bb, threadId);
      reads.set(threadId, read);
      return read;
    },
    logged: new Set(),
    reparents: new Map(),
  };
}

/** One reader per thread list: the evaluation that read the list shares the reads. */
const readers = new WeakMap<object, { bb: BbPluginApi; reader: OwnershipReader }>();

/** The reader of the evaluation whose thread list this is; a list is read afresh by each evaluation. */
export function ownershipReaderFor(bb: BbPluginApi, entries: readonly ThreadListEntry[]): OwnershipReader {
  const known = readers.get(entries);
  if (known?.bb === bb) {
    return known.reader;
  }
  const reader = createOwnershipReader(bb);
  readers.set(entries, { bb, reader });
  return reader;
}

/** The most threads the subtree of a child is walked through; past it the subtree cannot be checked. */
const MAX_SUBTREE = 200;

/**
 * Every thread below one by `parentThreadId` links, in any environment, hidden
 * and archived ones included. Throws when the list fails or the subtree holds
 * more than 200 threads: a caller that reads that as "cannot check" keeps the
 * child in the family.
 */
export async function subtreeIds(bb: BbPluginApi, threadId: string): Promise<string[]> {
  const seen = new Set<string>([threadId]);
  const queue: string[] = [threadId];
  for (let index = 0; index < queue.length; index += 1) {
    const parentId = queue[index];
    // Defence if the list filter is ever ignored: a row that is not this parent's child is not walked.
    for (const child of await bb.sdk.threads.list({ parentThreadId: parentId, includeHidden: true })) {
      if (!seen.has(child.id) && child.parentThreadId === parentId) {
        if (seen.size > MAX_SUBTREE) {
          throw new RangeError(`more than ${MAX_SUBTREE} threads below ${threadId}`);
        }
        seen.add(child.id);
        queue.push(child.id);
      }
    }
  }
  seen.delete(threadId);
  return [...seen];
}

/**
 * Whether a thread, since `since`, ran `bb thread update`, or had a row that
 * was running at `changedAt` and could write (opaque, or a tool that is not
 * read-only): a script or a tool can run the update with no `bb` in its text.
 * A row that began before `since` counts when it was still running at
 * `changedAt`; a row on a page older than the pages read is not seen. A row's window has its normal slack; a row with no
 * recorded end is taken to have run on. An opaque row that ran only before or
 * after that moment does not count, so a daemon started after the attach leaves
 * the child attached. True as well when the rows cannot be read in full.
 */
async function movesItself(bb: BbPluginApi, threadId: string, since: number, changedAt: number): Promise<boolean> {
  const rows = await rowsSince(bb, threadId, since);
  if (typeof rows === "string") {
    bb.log.info(`auto-review: could not read the rows of thread ${threadId} to see whether it changed its own parent`);
    return true;
  }
  const work = [...walkRows(rows)].filter((row): row is WorkRow => row.kind === "work");
  const readable = new Set(work.map((row) => row.threadId));
  const open = { pending: Infinity, unended: Infinity };
  return work.some((row) => {
    const running = rowWindow(row, open);
    const runningThen = running !== null && running.start <= changedAt && changedAt <= running.end;
    const updates =
      (row.startedAt >= since || runningThen) &&
      [shellText(row), ...(row.workKind === "tool" ? shellFields(row.toolArgs) : [])].some((text) => text !== null && runsBbThreadUpdate(text));
    // A file-change row edits one file and cannot move a thread; it records no end, so it would read as running forever.
    return updates || (runningThen && row.workKind !== "file-change" && rowEffect(row, readable) !== "none");
  });
}

/**
 * Whether the thread, or one in its subtree, moved itself: it ran `bb thread
 * update` from 30 minutes before its latest ownership change on, or an opaque
 * row of it was running at that moment (see `movesItself`). A thread that can
 * move itself under another thread was not put there by someone else. Any
 * failed or truncated read, and a subtree too large to walk, counts as a yes,
 * and the thread stays in the family.
 */
function reparented(
  bb: BbPluginApi,
  reader: OwnershipReader,
  threadId: string,
  changedAt: number,
  subtree: () => Promise<readonly string[]>,
): Promise<boolean> {
  const known = reader.reparents.get(threadId);
  if (known !== undefined) {
    return known;
  }
  const since = changedAt - FAMILY_LOOKBACK_MS;
  const read = (async () => {
    try {
      for (const id of [threadId, ...(await subtree())]) {
        if (await movesItself(bb, id, since, changedAt)) {
          return true;
        }
      }
      return false;
    } catch (error) {
      bb.log.info(`auto-review: could not check whether thread ${threadId} or its subtree changed its own parent: ${errorClass(error)}`);
      return true;
    }
  })();
  reader.reparents.set(threadId, read);
  return read;
}

/**
 * Whether a child of a family is attached: its lifecycle owner is not in the
 * family, it was created top-level (its earliest ownership change has no
 * previous parent), and its latest ownership change made its current parent
 * the parent. A spawned child, one moved away and back, and one spawned,
 * detached and attached elsewhere are all family; so is any child whose
 * changes could not be read in full, and any child that, or whose subtree,
 * ran `bb thread update` (see `reparented`): it may have moved itself. The
 * subtree is asked for only when that check is reached.
 */
export async function isAttachedChild(
  bb: BbPluginApi,
  reader: OwnershipReader,
  child: Pick<ThreadListEntry, "id" | "parentThreadId" | "lifecycleOwnerThreadId">,
  family: ReadonlySet<string>,
  subtree: () => Promise<readonly string[]>,
): Promise<boolean> {
  const { id, parentThreadId, lifecycleOwnerThreadId } = child;
  if (parentThreadId === null || (lifecycleOwnerThreadId !== null && family.has(lifecycleOwnerThreadId))) {
    return false;
  }
  const read = await reader.read(id);
  if (read.kind !== "changed" || read.firstPrevious !== null || read.lastNext !== parentThreadId) {
    return false;
  }
  if (await reparented(bb, reader, id, read.createdAt, subtree)) {
    return false;
  }
  const pair = `${parentThreadId}>${id}`;
  if (!reader.logged.has(pair)) {
    reader.logged.add(pair);
    bb.log.info(`auto-review: thread ${id} was attached under ${parentThreadId} at seq ${read.seq}; it is not part of that thread's family`);
  }
  return true;
}

export interface Membership {
  /** The thread, the threads it spawned or owns, transitively, without attached children and what hangs below them. */
  family: Set<string>;
  /** Attached children and the threads below them that no family member owns: only their own tool edits are the family's. */
  attached: Set<string>;
}

/**
 * Splits the threads linked to `selfThreadId` by `parentThreadId` or
 * `lifecycleOwnerThreadId`, transitively, into the family and the attached
 * threads. An attached child is removed before the closure grows, so what
 * hangs below it is not family unless a family member owns it too.
 */
export async function threadMembership(
  bb: BbPluginApi,
  entries: readonly ThreadListEntry[],
  selfThreadId: string,
): Promise<Membership> {
  const reader = ownershipReaderFor(bb, entries);
  const linked = (entry: ThreadListEntry, set: ReadonlySet<string>) =>
    [entry.parentThreadId, entry.lifecycleOwnerThreadId].some((owner) => owner !== null && set.has(owner));

  const family = new Set([selfThreadId]);
  let rejected = new Set<string>();
  let grew = true;
  // A verdict is drawn again each pass: a later family member can own a child that an earlier pass rejected.
  while (grew) {
    grew = false;
    rejected = new Set();
    for (const entry of entries) {
      if (family.has(entry.id) || !linked(entry, family)) {
        continue;
      }
      if (await isAttachedChild(bb, reader, entry, family, () => subtreeIds(bb, entry.id))) {
        rejected.add(entry.id);
      } else {
        family.add(entry.id);
        grew = true;
      }
    }
  }
  const attached = new Set(rejected);
  grew = true;
  while (grew) {
    grew = false;
    for (const entry of entries) {
      if (!family.has(entry.id) && !attached.has(entry.id) && linked(entry, attached)) {
        attached.add(entry.id);
        grew = true;
      }
    }
  }
  return { family, attached };
}
