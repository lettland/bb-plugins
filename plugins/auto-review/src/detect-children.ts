import type { BbPluginApi } from "@get-bb/plugin-sdk";

import type { ThreadListEntry } from "./detect-workspace.js";

/**
 * Threads spawned under this one, transitively, excluding plugin-originated
 * helpers (the advisor and similar): those send no wake-up and must never
 * hold a turn. Only `parentThreadId` links are walked — a thread merely
 * `lifecycleOwnerThreadId`-owned gets no wake-up either. A visited set makes
 * the walk cycle-safe. Archived children are walked through, since archiving
 * does not reliably take their children along; deleted ones never come back
 * from `threads.list`, so a grandchild under a deleted child is not seen. One
 * list call per descendant, archived ones included.
 */
async function spawnedDescendants(
  bb: BbPluginApi,
  threadId: string,
): Promise<ThreadListEntry[]> {
  const descendants: ThreadListEntry[] = [];
  const visited = new Set<string>([threadId]);
  const queue: string[] = [threadId];
  for (let index = 0; index < queue.length; index += 1) {
    const parentId = queue[index];
    const children = await bb.sdk.threads.list({
      parentThreadId: parentId,
      includeHidden: true,
    });
    for (const child of children) {
      if (
        visited.has(child.id) ||
        child.originPluginId !== null ||
        // Defence if the list filter is ever ignored: a row that isn't
        // actually this parent's child must not be walked as one.
        child.parentThreadId !== parentId
      ) {
        continue;
      }
      visited.add(child.id);
      queue.push(child.id);
      descendants.push(child);
    }
  }
  return descendants;
}

function isRunning(entry: ThreadListEntry): boolean {
  return (
    entry.archivedAt === null &&
    entry.deletedAt === null &&
    entry.status !== "idle" &&
    entry.status !== "error"
  );
}

/** Every spawned descendant of a thread, and the ones still running, from one walk. */
export interface SpawnedDescendantIds {
  all: Set<string>;
  running: string[];
}

export async function spawnedDescendantIds(
  bb: BbPluginApi,
  threadId: string,
): Promise<SpawnedDescendantIds> {
  const descendants = await spawnedDescendants(bb, threadId);
  return {
    all: new Set(descendants.map((entry) => entry.id)),
    running: descendants.filter(isRunning).map((entry) => entry.id),
  };
}

/**
 * Every spawned descendant of a thread as its raw `threads.list` rows — the
 * ids of `spawnedDescendantIds` plus the fields the plan review's round tally
 * reads (`title`, `createdAt`, `originPluginId`, `parentThreadId`). The walk's
 * plugin-origin filter holds here too, so a row in the result is never a
 * plugin helper; finished and archived rows are kept, since the tally counts a
 * review's children exactly once they are done. Deleted descendants never come
 * back from `threads.list` and are unseen, as with `spawnedDescendantIds`.
 */
export async function spawnedDescendantEntries(
  bb: BbPluginApi,
  threadId: string,
): Promise<ThreadListEntry[]> {
  return spawnedDescendants(bb, threadId);
}

/**
 * Spawned children (and grandchildren) still running. bb wakes this thread
 * when one of them ends, so a turn that finds any of these should park
 * instead of reviewing a tree snapshot the child is about to overwrite.
 * `pending` counts: a child spawned just before the turn ends still holds it.
 */
export async function runningChildIds(
  bb: BbPluginApi,
  threadId: string,
): Promise<string[]> {
  return (await spawnedDescendantIds(bb, threadId)).running;
}
