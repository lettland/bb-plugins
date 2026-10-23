import { createHash } from "node:crypto";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { createTwoFilesPatch } from "diff";
import { z } from "zod";
import { HASH_CONCURRENCY, mapLimit } from "./detect-limit.js";
import { headShaOf, type AvailableWorkspace } from "./detect-workspace.js";
import { openChains } from "./findings.js";
import { readFindings } from "./findings-store.js";
import type { CodeFileScope, PlanScope } from "./prompt-baseline.js";

/**
 * Review baselines, kept by the plugin in its KV store: what the last clean
 * review of a thread read, so a later review covers only what changed since.
 * The plugin computes each delta itself and puts the diff into the prompt, so
 * the agent never copies, hashes or diffs anything.
 *
 * A record holds a promoted `copy` and a `pending` one. Arming a review stages
 * the content it reads as `pending`; the review's clean end promotes it (this
 * cycle's own fixes then show up in the next delta), any other end drops it.
 * Callers hold the thread's lock. Every function is best-effort: a store or
 * environment failure is logged and means a full review, never a failed one.
 */

/** A record untouched this long is dropped the next time it is read. */
export const BASELINE_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
/** A file larger than this gets no baseline. */
export const MAX_BASELINE_FILE_BYTES = 256 * 1024;
/** The most files a thread's code baseline keeps, and the most bytes across them. */
export const MAX_CODE_BASELINE_FILES = 200;
export const MAX_CODE_BASELINE_BYTES = 4 * 1024 * 1024;
/** A delta larger than this is not embedded: the plan, or every file of a code review in total, gets a full review. */
export const PLAN_DELTA_BUDGET = 40_000;
export const CODE_DELTA_BUDGET = 80_000;
const DELTA_CONTEXT_LINES = 3;
/** A diff needing more changed lines than this is abandoned: past the budget anyway, and it bounds the time spent. */
const MAX_DELTA_EDIT_LINES = 4_000;

const planRecordSchema = z.object({
  copy: z.object({ content: z.string(), at: z.number() }).optional(),
  pending: z.object({ content: z.string(), at: z.number() }).optional(),
});
type PlanRecord = z.infer<typeof planRecordSchema>;

const codeRecordSchema = z.object({
  /**
   * Repo-relative path -> what the last clean review read. A copy is compared
   * by content, so it stays valid whatever HEAD does; `headSha` is kept only
   * so stored records still parse.
   */
  copies: z
    .record(z.string(), z.object({ content: z.string(), headSha: z.string(), at: z.number() }))
    .default({}),
  /** What the review in flight reads: content per path, null for a file deleted since. */
  pending: z
    .object({ headSha: z.string(), at: z.number(), files: z.record(z.string(), z.string().nullable()) })
    .optional(),
  /** Whether that review's last report ended clean (no open Blocker or security Concern). */
  clean: z.boolean().optional(),
});
type CodeRecord = z.infer<typeof codeRecordSchema>;

const planKeyPrefix = (threadId: string): string => `baseline:plan:${threadId}:`;
const codeKey = (threadId: string): string => `baseline:code:${threadId}`;

function planKey(threadId: string, planPath: string): string {
  return `${planKeyPrefix(threadId)}${createHash("sha256").update(planPath).digest("hex")}`;
}

function problem(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The stored record, or undefined when there is none or it cannot be read (logged). */
async function readRecord<T>(
  bb: BbPluginApi,
  key: string,
  schema: z.ZodType<T>,
): Promise<T | undefined> {
  try {
    const raw = await bb.storage.kv.get<unknown>(key);
    if (raw === null || raw === undefined) {
      return undefined;
    }
    const parsed = schema.safeParse(raw);
    if (parsed.success) {
      return parsed.data;
    }
    bb.log.warn(`auto-review: discarding an unparseable review baseline (${key}); reviewing in full`);
  } catch (error) {
    bb.log.warn(`auto-review: could not read the review baseline (${key}); reviewing in full: ${problem(error)}`);
  }
  return undefined;
}

async function writeRecord(bb: BbPluginApi, key: string, record: unknown): Promise<void> {
  try {
    await bb.storage.kv.set(key, record);
  } catch (error) {
    bb.log.warn(`auto-review: could not save the review baseline (${key}): ${problem(error)}`);
  }
}

async function deleteRecord(bb: BbPluginApi, key: string): Promise<void> {
  try {
    await bb.storage.kv.delete(key);
  } catch (error) {
    bb.log.warn(`auto-review: could not delete the review baseline (${key}): ${problem(error)}`);
  }
}

const fresh = (at: number, now: number): boolean => now - at <= BASELINE_TTL_MS;
const tooBig = (content: string): boolean => Buffer.byteLength(content) > MAX_BASELINE_FILE_BYTES;

/** A unified diff with a few lines of context; empty when nothing changed, undefined when too much did to diff. */
export function unifiedDelta(before: string, after: string, label: string): string | undefined {
  if (before === after) {
    return "";
  }
  return createTwoFilesPatch(`a/${label}`, `b/${label}`, before, after, undefined, undefined, {
    context: DELTA_CONTEXT_LINES,
    maxEditLength: MAX_DELTA_EDIT_LINES,
  });
}

/** Whether the thread has a Blocker open: a review that left one is not a clean baseline. */
async function blockerOpen(bb: BbPluginApi, threadId: string): Promise<boolean> {
  try {
    return openChains(await readFindings(bb, threadId)).some((chain) => chain.severity === "blocker");
  } catch (error) {
    bb.log.warn(`auto-review: could not read the findings of ${threadId}; keeping no baseline: ${problem(error)}`);
    return true;
  }
}

// ---- plans -----------------------------------------------------------------

/**
 * What a plan review covers: the delta against the plan's promoted copy when
 * one exists and fits the budget, nothing to review when it is empty, else
 * the whole plan. A null path or content (unreadable) means no baseline.
 */
export async function planScope(
  bb: BbPluginApi,
  threadId: string,
  planPath: string | null,
  content: string | null,
  now: number,
): Promise<PlanScope> {
  const full: PlanScope = { kind: "full" };
  if (planPath === null || content === null || tooBig(content)) {
    return full;
  }
  const key = planKey(threadId, planPath);
  const record = await readRecord<PlanRecord>(bb, key, planRecordSchema);
  if (record?.copy === undefined) {
    return full;
  }
  if (!fresh(record.copy.at, now)) {
    await deleteRecord(bb, key);
    return full;
  }
  const diff = unifiedDelta(record.copy.content, content, "plan");
  if (diff === "") {
    return { kind: "unchanged" };
  }
  return diff === undefined || diff.length > PLAN_DELTA_BUDGET ? full : { kind: "delta", diff };
}

/** Stages the plan as the review now being armed reads it; an unreadable or oversize one ends the plan's baseline. */
export async function stagePlanPending(
  bb: BbPluginApi,
  threadId: string,
  planPath: string | null,
  content: string | null,
  now: number,
): Promise<void> {
  if (planPath === null) {
    return;
  }
  const key = planKey(threadId, planPath);
  if (content === null || tooBig(content)) {
    await deleteRecord(bb, key);
    return;
  }
  const record = await readRecord<PlanRecord>(bb, key, planRecordSchema);
  const copy = record?.copy !== undefined && fresh(record.copy.at, now) ? record.copy : undefined;
  await writeRecord(bb, key, { ...(copy === undefined ? {} : { copy }), pending: { content, at: now } });
}

/**
 * The review's end: the pending content becomes the baseline when the review
 * completed and no Blocker is open, else it is dropped (the older copy stays).
 */
export async function settlePlanBaseline(
  bb: BbPluginApi,
  threadId: string,
  planPath: string | null,
  reviewCompleted: boolean,
): Promise<void> {
  if (planPath === null) {
    return;
  }
  const key = planKey(threadId, planPath);
  const record = await readRecord<PlanRecord>(bb, key, planRecordSchema);
  if (record?.pending === undefined) {
    return;
  }
  const promote = reviewCompleted && !(await blockerOpen(bb, threadId));
  const copy = promote ? record.pending : record.copy;
  if (copy === undefined) {
    await deleteRecord(bb, key);
  } else {
    await writeRecord(bb, key, { copy });
  }
}

/** Ends a plan's baseline: an approval, or a redo that reviews the whole plan again. */
export async function clearPlanBaseline(
  bb: BbPluginApi,
  threadId: string,
  planPath: string | null,
): Promise<void> {
  if (planPath !== null) {
    await deleteRecord(bb, planKey(threadId, planPath));
  }
}

/** Drops everything a deleted thread's reviews kept. */
export async function deleteBaselines(bb: BbPluginApi, threadId: string): Promise<void> {
  try {
    for (const key of await bb.storage.kv.list(planKeyPrefix(threadId))) {
      await deleteRecord(bb, key);
    }
  } catch (error) {
    bb.log.warn(`auto-review: could not list the plan baselines of ${threadId}: ${problem(error)}`);
  }
  await deleteRecord(bb, codeKey(threadId));
}

// code baselines.

/**
 * Whether `error` is the CLI's report of a missing path: the structured
 * `code: "ENOENT"` the 404 body leaves on the error thrown in-process. Nothing
 * else counts: the bare 404 of an unknown environment or route carries no
 * code, and the message is never matched, since it embeds an absolute path.
 */
function isMissingPath(error: unknown): boolean {
  return (error as { code?: unknown } | undefined)?.code === "ENOENT";
}

/**
 * One file's read for a baseline: its working-tree `content` (null once
 * deleted), a read that `failed` (nothing is staged; the copy is kept for the
 * next review), or content `unusable` as a baseline (not utf8 text, or over
 * the size guard; the copy is dropped, as it always has been).
 */
type FileRead = { content: string | null } | { failed: true } | { unusable: true };

/**
 * The file's content in the working tree, read whatever its working-tree
 * status (a committed, clean file reads like an edited one): the content, null
 * once deleted — status `"D"`, or a read failing with the ENOENT code, a
 * deletion that was already committed.
 */
async function currentContent(
  bb: BbPluginApi,
  environmentId: string,
  path: string,
  status: string | undefined,
): Promise<FileRead> {
  if (status === "D") {
    return { content: null };
  }
  try {
    const result = await bb.sdk.environments.diffFile({
      environmentId,
      target: "uncommitted",
      path,
      side: "new",
    });
    return result.contentEncoding === "utf8" && !tooBig(result.content)
      ? { content: result.content }
      : { unusable: true };
  } catch (error) {
    return isMissingPath(error) ? { content: null } : { failed: true };
  }
}

export interface CodeBaselineInput {
  threadId: string;
  environmentId: string;
  /** The listed, safe-named files in scope. */
  paths: readonly string[];
  workspace: AvailableWorkspace | null;
  now: number;
}

/**
 * The deltas of a review, for the files whose earlier copy still matches the
 * file's content and whose delta fits the budget; every other file gets the
 * full review. A copy is matched by content, so a branch switch or a pull
 * between reviews only makes the delta larger — upstream changes are then
 * reviewed, never skipped, and past `CODE_DELTA_BUDGET` the whole file falls
 * back to a full review. At most `MAX_CODE_BASELINE_FILES` paths are read; a
 * listed path past the cap loses its copy, as a file past the limit always
 * did. Stages what the files read now as pending, for the review's clean end
 * to promote. Retention is unchanged: the 7-day TTL and the size caps still
 * prune copies, and `deleteBaselines` still drops the record with the thread.
 */
export async function prepareCodeBaseline(
  bb: BbPluginApi,
  input: CodeBaselineInput,
): Promise<CodeFileScope[]> {
  const { threadId, environmentId, paths, workspace, now } = input;
  const key = codeKey(threadId);
  const head = workspace === null ? null : headShaOf(workspace);
  const stored = await readRecord<CodeRecord>(bb, key, codeRecordSchema);
  const copies = Object.fromEntries(
    Object.entries(stored?.copies ?? {}).filter(([, copy]) => fresh(copy.at, now)),
  );
  if (workspace === null || head === null) {
    await writeRecord(bb, key, { copies });
    return [];
  }
  const statuses = new Map(workspace.workingTree.files.map((file) => [file.path, file.status]));
  // The read is the costly step: past the cap a path's copy is dropped without reading it,
  // so entries past the cap in `contents` are undefined.
  const contents: (FileRead | undefined)[] = await mapLimit(
    paths.slice(0, MAX_CODE_BASELINE_FILES),
    HASH_CONCURRENCY,
    (path) => currentContent(bb, environmentId, path, statuses.get(path)),
  );
  const scope: CodeFileScope[] = [];
  const files: Record<string, string | null> = {};
  let budget = CODE_DELTA_BUDGET;
  paths.forEach((path, index) => {
    const read = contents[index];
    if (read === undefined || "unusable" in read) {
      delete copies[path];
      return;
    }
    if ("failed" in read) {
      // A failed read keeps the file's copy; nothing is staged for it.
      return;
    }
    files[path] = read.content;
    const copy = copies[path];
    if (copy === undefined) {
      return;
    }
    const diff = unifiedDelta(copy.content, read.content ?? "", path);
    const kind = read.content === null ? "removed" : diff === "" ? "unchanged" : "delta";
    if (diff !== undefined && diff.length <= budget) {
      budget -= diff.length;
      scope.push({ path, kind, diff });
    }
  });
  await writeRecord(bb, key, { copies, pending: { headSha: head, at: now, files } });
  return scope;
}

/**
 * A review's report: a finding about a secret or other security issue ends its
 * file's baseline (copy and pending alike), and the report decides whether the
 * pending content may be promoted — not with a Blocker or security Concern open.
 */
export async function recordCodeReport(
  bb: BbPluginApi,
  threadId: string,
  report: { findings: readonly { file: string; status: string; security?: boolean | undefined }[] },
  blockerOpenNow: boolean,
): Promise<void> {
  const key = codeKey(threadId);
  const record = await readRecord<CodeRecord>(bb, key, codeRecordSchema);
  if (record === undefined) {
    return;
  }
  const secure = report.findings.filter((finding) => finding.security === true);
  const copies = { ...record.copies };
  const files = { ...record.pending?.files };
  for (const { file } of secure) {
    delete copies[file];
    delete files[file];
  }
  const clean = !blockerOpenNow && !secure.some((finding) => finding.status === "open");
  await writeRecord(bb, key, {
    copies,
    ...(record.pending === undefined ? {} : { pending: { ...record.pending, files } }),
    clean,
  });
}

/**
 * A review's end, reported or not: the pending files become the baseline when
 * its last report ended clean, else they are dropped. A deleted file's copy goes
 * either way it is promoted; the oldest copies go past the size limits.
 */
export async function settleCodeBaseline(bb: BbPluginApi, threadId: string, now: number): Promise<void> {
  const key = codeKey(threadId);
  const record = await readRecord<CodeRecord>(bb, key, codeRecordSchema);
  if (record?.pending === undefined) {
    return;
  }
  const copies = { ...record.copies };
  if (record.clean === true) {
    for (const [path, content] of Object.entries(record.pending.files)) {
      if (content === null) {
        delete copies[path];
      } else {
        copies[path] = { content, headSha: record.pending.headSha, at: record.pending.at };
      }
    }
  }
  let bytes = 0;
  const kept = Object.entries(copies)
    .filter(([, copy]) => fresh(copy.at, now))
    .sort(([, left], [, right]) => right.at - left.at)
    .filter(([, copy], index) => {
      bytes += Buffer.byteLength(copy.content);
      return index < MAX_CODE_BASELINE_FILES && bytes <= MAX_CODE_BASELINE_BYTES;
    });
  await writeRecord(bb, key, { copies: Object.fromEntries(kept) });
}
