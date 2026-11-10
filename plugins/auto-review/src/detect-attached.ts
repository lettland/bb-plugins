import type { BbPluginApi } from "@get-bb/plugin-sdk";

import { eventsSince } from "./detect-event-log.js";
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
    };

export interface OwnershipReader {
  /** The ownership changes of a thread, read once per reader. */
  read: (threadId: string) => Promise<OwnershipRead>;
  /** The parent-child pairs already logged as attached. */
  logged: Set<string>;
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
    }
  } catch (error) {
    // A failed or partial read (including the page cap) never decides attachment: the child stays in the family.
    bb.log.info(`auto-review: could not read the ownership changes of thread ${threadId}: ${errorClass(error)}`);
    return { kind: "failed" };
  }
  return firstPrevious === undefined ? { kind: "none" } : { kind: "changed", firstPrevious, lastNext, seq };
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

/**
 * Whether a child of a family is attached: its lifecycle owner is not in the
 * family, it was created top-level (its earliest ownership change has no
 * previous parent), and its latest ownership change made its current parent
 * the parent. A spawned child, one moved away and back, and one spawned,
 * detached and attached elsewhere are all family; so is any child whose
 * changes could not be read in full.
 */
export async function isAttachedChild(
  bb: BbPluginApi,
  reader: OwnershipReader,
  child: Pick<ThreadListEntry, "id" | "parentThreadId" | "lifecycleOwnerThreadId">,
  family: ReadonlySet<string>,
): Promise<boolean> {
  const { id, parentThreadId, lifecycleOwnerThreadId } = child;
  if (parentThreadId === null || (lifecycleOwnerThreadId !== null && family.has(lifecycleOwnerThreadId))) {
    return false;
  }
  const read = await reader.read(id);
  if (read.kind !== "changed" || read.firstPrevious !== null || read.lastNext !== parentThreadId) {
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
      if (await isAttachedChild(bb, reader, entry, family)) {
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
