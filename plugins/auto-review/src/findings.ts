import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { SCOPE_PATH_ALLOW, type PromptFinding } from "./prompt.js";
import { publishThreadReview } from "./state.js";
import { stripControl } from "./text.js";

/**
 * What each auto-review found, kept per thread so the next review starts from
 * it instead of rediscovering (and re-dismissing) the same issues.
 *
 * A finding is a *chain*: one key the review agent reuses for the same issue
 * across reviews, with the history that decides whether a report is a repeat.
 * Everything here is data the agent reported, never verified against git, and
 * every free-text field is cleaned at the schema so the CLI, the RPC and the
 * badge only ever see plain text.
 */

export const FINDING_SEVERITIES = ["blocker", "high", "medium", "low"] as const;
export type FindingSeverity = (typeof FINDING_SEVERITIES)[number];

export const FINDING_STATUSES = ["open", "fixed", "false-positive"] as const;
export type FindingStatus = (typeof FINDING_STATUSES)[number];

/** What the review agent can report about the review as a whole. */
export const AGENT_OUTCOMES = ["committed", "merged", "uncommitted", "blocked", "no-changes"] as const;
export type AgentOutcome = (typeof AGENT_OUTCOMES)[number];

/**
 * The plugin's own outcomes, for reviews that ended without a report: it ran
 * but never reported, the user stopped it, or it could not be sent at all. They
 * exist so such a review never looks like a pass.
 */
export const PLUGIN_OUTCOMES = ["not-reported", "stopped", "unavailable"] as const;
export type PluginOutcome = (typeof PLUGIN_OUTCOMES)[number];

export const REVIEW_OUTCOMES = [...AGENT_OUTCOMES, ...PLUGIN_OUTCOMES] as const;
export type ReviewOutcome = (typeof REVIEW_OUTCOMES)[number];

/** How many chains one thread keeps, and how many incidents. */
export const MAX_CHAINS = 100;
export const MAX_INCIDENTS = 20;
/** A dismissed false positive stays in the next prompt this long, so its key gets reused. */
export const FALSE_POSITIVE_PROMPT_WINDOW_MS = 7 * 24 * 60 * 60 * 1_000;
/** The most findings the next review's prompt lists; the rest are only counted. */
export const MAX_PROMPT_FINDINGS = 15;

/** Free text from the agent: length-capped on the way in, control characters stripped on the way out. */
function cleanText(max: number) {
  return z.string().max(max).transform(stripControl);
}

const findingKeySchema = z.string().regex(/^[a-z0-9][a-z0-9._:/-]{0,79}$/u);

/** One finding as the review agent reports it (the `ReportReview` tool's input). */
export const reportedFindingSchema = z
  .object({
    key: findingKeySchema,
    title: cleanText(200).pipe(z.string().min(1)),
    file: z.string().max(300).regex(SCOPE_PATH_ALLOW),
    line: z.number().int().positive().optional(),
    severity: z.enum(FINDING_SEVERITIES),
    status: z.enum(FINDING_STATUSES),
    reason: cleanText(300).optional(),
  })
  .refine(
    (finding) =>
      finding.status !== "false-positive" || (finding.reason?.trim() ?? "").length > 0,
    { message: "A false-positive finding needs a reason.", path: ["reason"] },
  );
export type ReportedFinding = z.output<typeof reportedFindingSchema>;

/** The `ReportReview` tool's whole input. */
export const reviewReportSchema = z.object({
  outcome: z.enum(AGENT_OUTCOMES),
  summary: cleanText(500),
  findings: z.array(reportedFindingSchema).max(50).default([]),
});
export type ReviewReport = z.output<typeof reviewReportSchema>;

const chainStateSchema = z.object({
  title: z.string(),
  file: z.string(),
  line: z.number().optional(),
  severity: z.enum(FINDING_SEVERITIES),
  status: z.enum(FINDING_STATUSES),
  reason: z.string().optional(),
  dismissReason: z.string().optional(),
  lastSeenAt: z.number(),
  raisedCount: z.number().int().nonnegative(),
  dismissCount: z.number().int().nonnegative(),
  reRaised: z.boolean(),
  lastReviewId: z.number(),
});

export const findingChainSchema = chainStateSchema.extend({
  key: z.string(),
  firstSeenAt: z.number(),
  /** Set while the chain was born in the review `lastReviewId` names, so a later report in that review can drop it. */
  createdByReviewId: z.number().optional(),
  /** The chain as it stood before the review `lastReviewId` names first touched it. */
  before: chainStateSchema.optional(),
});
export type FindingChain = z.infer<typeof findingChainSchema>;

const countsSchema = z.object({
  open: z.number().int().nonnegative(),
  fixed: z.number().int().nonnegative(),
  falsePositive: z.number().int().nonnegative(),
});
export type FindingCounts = z.infer<typeof countsSchema>;

export const reviewRecordSchema = z.object({
  /** `reviewDeliveredAt` of the review this describes (`dispatchedAt` or the time for one that never reached the agent). */
  reviewId: z.number(),
  at: z.number(),
  outcome: z.enum(REVIEW_OUTCOMES),
  summary: z.string(),
  counts: countsSchema,
});
export type ReviewRecord = z.infer<typeof reviewRecordSchema>;

export const incidentSchema = z.object({
  at: z.number(),
  kind: z.enum(["send-failed", "not-reported"]),
  detail: z.string(),
});
export type Incident = z.infer<typeof incidentSchema>;

export const findingsStoreSchema = z.object({
  chains: z.record(z.string(), findingChainSchema).default({}),
  lastReport: reviewRecordSchema.optional(),
  incidents: z.array(incidentSchema).default([]),
});
export type FindingsStore = z.infer<typeof findingsStoreSchema>;

export function emptyStore(): FindingsStore {
  return { chains: {}, incidents: [] };
}

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

function normalizeReason(reason: string | undefined): string {
  return (reason ?? "").trim().toLowerCase();
}

function severityRank(severity: FindingSeverity): number {
  return FINDING_SEVERITIES.indexOf(severity);
}

/** The more severe of two (lower index is more severe). */
function maxSeverity(left: FindingSeverity, right: FindingSeverity): FindingSeverity {
  return severityRank(left) <= severityRank(right) ? left : right;
}

function snapshot(chain: FindingChain): NonNullable<FindingChain["before"]> {
  return {
    title: chain.title,
    file: chain.file,
    line: chain.line,
    severity: chain.severity,
    status: chain.status,
    reason: chain.reason,
    dismissReason: chain.dismissReason,
    lastSeenAt: chain.lastSeenAt,
    raisedCount: chain.raisedCount,
    dismissCount: chain.dismissCount,
    reRaised: chain.reRaised,
    lastReviewId: chain.lastReviewId,
  };
}

/**
 * Undoes what an earlier report in the same review did, so the last report
 * replaces it instead of stacking on it: chains it created are dropped, chains
 * it touched go back to how the review found them.
 */
function revertReview(
  chains: Record<string, FindingChain>,
  reviewId: number,
): Record<string, FindingChain> {
  const reverted: Record<string, FindingChain> = {};
  for (const [key, chain] of Object.entries(chains)) {
    if (chain.createdByReviewId === reviewId) {
      continue;
    }
    if (chain.lastReviewId === reviewId && chain.before !== undefined) {
      const { before, ...rest } = chain;
      // Optional fields are named: a snapshot that went through JSON has lost
      // its undefined ones, and a plain spread would keep the reviewed value.
      reverted[key] = {
        ...rest,
        ...before,
        line: before.line,
        reason: before.reason,
        dismissReason: before.dismissReason,
      };
      continue;
    }
    reverted[key] = chain;
  }
  return reverted;
}

interface IgnoredFinding {
  key: string;
  why: string;
}

/**
 * A chain already dismissed once (and not yet resolved since) is only dismissed
 * again for a different reason; the same one is the agent repeating itself, not
 * new information.
 */
function repeatsDismissal(existing: FindingChain, finding: ReportedFinding): boolean {
  const reason = normalizeReason(finding.reason);
  return (
    finding.status === "false-positive" &&
    existing.dismissCount > 0 &&
    (existing.status === "false-positive" || existing.reRaised) &&
    (reason === "" || reason === normalizeReason(existing.dismissReason))
  );
}

/** What a finding does to the chain it belongs to. */
function applyFinding(
  existing: FindingChain | undefined,
  finding: ReportedFinding,
  reviewId: number,
  now: number,
): { chain: FindingChain } | { ignored: IgnoredFinding } {
  const text = { title: finding.title, file: finding.file, line: finding.line };
  if (existing === undefined) {
    return {
      chain: {
        key: finding.key,
        ...text,
        severity: finding.severity,
        status: finding.status,
        reason: finding.reason,
        firstSeenAt: now,
        lastSeenAt: now,
        raisedCount: finding.status === "fixed" ? 0 : 1,
        dismissCount: finding.status === "false-positive" ? 1 : 0,
        dismissReason: finding.status === "false-positive" ? finding.reason : undefined,
        reRaised: false,
        lastReviewId: reviewId,
        createdByReviewId: reviewId,
      },
    };
  }

  if (repeatsDismissal(existing, finding)) {
    return {
      ignored: {
        key: finding.key,
        why: "already dismissed with this reason; give a new reason to dismiss it again",
      },
    };
  }

  const next: FindingChain = {
    ...existing,
    ...text,
    severity: maxSeverity(existing.severity, finding.severity),
    status: finding.status,
    reason: finding.reason,
    lastSeenAt: now,
    lastReviewId: reviewId,
    before: snapshot(existing),
  };
  if (finding.status === "open") {
    next.raisedCount = existing.raisedCount + 1;
    next.reRaised = existing.status !== "open" || existing.reRaised;
  } else if (finding.status === "false-positive") {
    next.raisedCount = existing.raisedCount + 1;
    next.dismissCount = existing.dismissCount + 1;
    next.dismissReason = finding.reason;
    next.reRaised = false;
  } else {
    next.reRaised = false;
  }
  return { chain: next };
}

/** Drops the oldest settled chains first, then the oldest open ones, never one the report touched. */
function evict(
  chains: Record<string, FindingChain>,
  touched: ReadonlySet<string>,
): Record<string, FindingChain> {
  const keys = Object.keys(chains);
  if (keys.length <= MAX_CHAINS) {
    return chains;
  }
  const candidates = keys
    .filter((key) => !touched.has(key))
    .map((key) => chains[key] as FindingChain)
    .sort(
      (left, right) =>
        Number(left.status === "open") - Number(right.status === "open") ||
        left.lastSeenAt - right.lastSeenAt,
    );
  const kept = { ...chains };
  for (const chain of candidates.slice(0, keys.length - MAX_CHAINS)) {
    delete kept[chain.key];
  }
  return kept;
}

interface MergeResult {
  store: FindingsStore;
  /** Findings left unchanged because they repeated a dismissal without a new reason. */
  ignored: IgnoredFinding[];
  counts: FindingCounts;
}

function countFindings(findings: readonly ReportedFinding[]): FindingCounts {
  return {
    open: findings.filter((finding) => finding.status === "open").length,
    fixed: findings.filter((finding) => finding.status === "fixed").length,
    falsePositive: findings.filter((finding) => finding.status === "false-positive").length,
  };
}

/**
 * Folds one review's report into the store. Pure.
 *
 * The last report of a review replaces earlier ones: those are reverted first,
 * so a repeat call never double-counts, a chain only an earlier report named
 * goes away or reverts, and fixed-then-open within one review is not a
 * re-raise. A report is never refused as a whole — a repeated dismissal
 * without a new reason is skipped finding by finding, so the outcome is kept.
 */
export function mergeReport(
  store: FindingsStore,
  report: ReviewReport,
  reviewId: number,
  now: number,
): MergeResult {
  // The same key twice in one report is one finding; the later entry wins.
  const byKey = new Map(report.findings.map((finding) => [finding.key, finding]));
  let chains = revertReview(store.chains, reviewId);
  const ignored: IgnoredFinding[] = [];
  for (const finding of byKey.values()) {
    const applied = applyFinding(chains[finding.key], finding, reviewId, now);
    if ("ignored" in applied) {
      ignored.push(applied.ignored);
    } else {
      chains = { ...chains, [finding.key]: applied.chain };
    }
  }
  const counts = countFindings(report.findings);
  return {
    store: {
      chains: evict(chains, new Set(byKey.keys())),
      lastReport: { reviewId, at: now, outcome: report.outcome, summary: report.summary, counts },
      incidents: store.incidents,
    },
    ignored,
    counts,
  };
}

/** The outcome of a review the plugin ended without a report. */
interface UnreportedOutcome {
  reviewId: number;
  outcome: PluginOutcome;
  summary: string;
  incident?: { kind: Incident["kind"]; detail: string };
}

/** Pure counterpart of `mergeReport` for `not-reported` / `stopped` / `unavailable`. */
export function withUnreportedOutcome(
  store: FindingsStore,
  entry: UnreportedOutcome,
  now: number,
): FindingsStore {
  const incidents =
    entry.incident === undefined
      ? store.incidents
      : [
          ...store.incidents,
          { at: now, kind: entry.incident.kind, detail: stripControl(entry.incident.detail).slice(0, 300) },
        ].slice(-MAX_INCIDENTS);
  return {
    chains: store.chains,
    lastReport: {
      reviewId: entry.reviewId,
      at: now,
      outcome: entry.outcome,
      summary: stripControl(entry.summary).slice(0, 500),
      counts: { open: 0, fixed: 0, falsePositive: 0 },
    },
    incidents,
  };
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

/** Whether the agent has reported (or the plugin has recorded) the review with this id. */
export function reviewRecorded(store: FindingsStore, reviewId: number | undefined): boolean {
  return reviewId !== undefined && store.lastReport?.reviewId === reviewId;
}

export function openChains(store: FindingsStore): FindingChain[] {
  return Object.values(store.chains).filter((chain) => chain.status === "open");
}

function promptOrder(left: FindingChain, right: FindingChain): number {
  return (
    Number(right.reRaised) - Number(left.reRaised) ||
    severityRank(left.severity) - severityRank(right.severity) ||
    right.lastSeenAt - left.lastSeenAt
  );
}

/**
 * The chains the next review is told about: every open one (re-raised first,
 * then by severity) plus recently dismissed false positives, whose keys the
 * agent should reuse. Capped; `omitted` says how many did not fit.
 */
export function openFindingsForPrompt(
  store: FindingsStore,
  now: number,
): { findings: PromptFinding[]; omitted: number } {
  const chains = Object.values(store.chains).filter(
    (chain) =>
      chain.status === "open" ||
      (chain.status === "false-positive" && now - chain.lastSeenAt <= FALSE_POSITIVE_PROMPT_WINDOW_MS),
  );
  chains.sort(
    (left, right) =>
      Number(right.status === "open") - Number(left.status === "open") || promptOrder(left, right),
  );
  const listed = chains.slice(0, MAX_PROMPT_FINDINGS);
  return {
    findings: listed.map((chain) => ({
      key: chain.key,
      severity: chain.severity,
      status: chain.status,
      file: chain.file,
      line: chain.line,
      title: chain.title,
      reason: chain.reason,
    })),
    omitted: chains.length - listed.length,
  };
}

export type ReviewStatus = ReviewOutcome | "pending" | "none";

/** The thread's review state for the status line, the RPC and the badge. */
export function reviewStatusOf(store: FindingsStore, inFlight: boolean): ReviewStatus {
  if (inFlight) {
    return "pending";
  }
  return store.lastReport?.outcome ?? "none";
}

interface ReviewSummary {
  status: ReviewStatus;
  at: number | null;
  openCount: number;
  reRaisedCount: number;
  lastIncident: Incident | null;
}

export function summarizeReview(store: FindingsStore, inFlight: boolean): ReviewSummary {
  const open = openChains(store);
  return {
    status: reviewStatusOf(store, inFlight),
    at: store.lastReport?.at ?? null,
    openCount: open.length,
    reRaisedCount: open.filter((chain) => chain.reRaised).length,
    lastIncident: store.incidents.at(-1) ?? null,
  };
}

/** Whether `error` is the host saying a thread does not exist, as opposed to a transient failure. */
export function isThreadNotFound(error: unknown): boolean {
  if (error === null || typeof error !== "object") {
    return false;
  }
  const { message, code, status } = error as { message?: unknown; code?: unknown; status?: unknown };
  return (
    status === 404 ||
    code === "not_found" ||
    code === "thread_not_found" ||
    (typeof message === "string" && /\bnot found\b/iu.test(message))
  );
}
