import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { emptyStore, findingsStoreSchema, type FindingsStore } from "./findings-schema.js";
import { reviewRecorded, withUnreportedOutcome, type UnreportedOutcome } from "./findings.js";
import { publishThreadReview } from "./state.js";

/** Where a thread's findings live in the plugin KV, and how they are read, written and found again. */

const KEY_PREFIX = "findings:";

export function findingsKey(threadId: string): string {
  return `${KEY_PREFIX}${threadId}`;
}

/** The store, or an empty one when none exists or the stored value cannot be parsed (logged, like `readState`). */
export async function readFindings(bb: BbPluginApi, threadId: string): Promise<FindingsStore> {
  const raw = await bb.storage.kv.get<unknown>(findingsKey(threadId));
  if (raw === null || raw === undefined) {
    return emptyStore();
  }
  const parsed = findingsStoreSchema.safeParse(raw);
  if (parsed.success) {
    return parsed.data;
  }
  bb.log.warn(`auto-review: discarding unparseable findings for ${threadId}; starting empty`);
  return emptyStore();
}

/** Persists the store and tells the badge. Callers hold the thread's lock. */
export async function writeFindings(
  bb: BbPluginApi,
  threadId: string,
  store: FindingsStore,
): Promise<void> {
  await bb.storage.kv.set(findingsKey(threadId), store);
  publishThreadReview(bb, threadId);
}

export async function deleteFindings(bb: BbPluginApi, threadId: string): Promise<void> {
  await bb.storage.kv.delete(findingsKey(threadId));
}

/** Thread ids that have a findings key, for the orphan sweep. */
export async function listFindingThreadIds(bb: BbPluginApi): Promise<string[]> {
  const keys = await bb.storage.kv.list(KEY_PREFIX);
  return keys.map((key) => key.slice(KEY_PREFIX.length));
}

/**
 * Records a review that ended without a report. A report the agent did make
 * for the same review is never overwritten. Callers hold the thread's lock.
 */
export async function recordUnreported(
  bb: BbPluginApi,
  threadId: string,
  entry: UnreportedOutcome,
): Promise<void> {
  const store = await readFindings(bb, threadId);
  if (reviewRecorded(store, entry.reviewId)) {
    return;
  }
  await writeFindings(bb, threadId, withUnreportedOutcome(store, entry, Date.now()));
}

/**
 * Whether `error` is the host saying a thread does not exist. Only structured
 * signals count: `code: "thread_not_found"` — the shape bb's own tasks plugin
 * checks on a failed `threads.get`, from the HTTP API's 404 with
 * `{error:{code:"thread_not_found"}}` — or a 404 status. Free text is not
 * evidence: "method not found" from a version-skewed host, or "not found:
 * <cmd>" from a missing binary, says nothing about the thread, and one wrong
 * answer here deletes a live thread's findings.
 */
export function isThreadNotFound(error: unknown): boolean {
  if (error === null || typeof error !== "object") {
    return false;
  }
  const { code, status } = error as { code?: unknown; status?: unknown };
  return code === "thread_not_found" || status === 404;
}
