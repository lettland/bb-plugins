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
  const descendants = await spawnedDescendants(bb, threadId);
  return descendants
    .filter(
      (entry) =>
        entry.archivedAt === null &&
        entry.deletedAt === null &&
        entry.status !== "idle" &&
        entry.status !== "error",
    )
    .map((entry) => entry.id);
}
