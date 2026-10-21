import { stripControl } from "./text.js";
import {
  FALSE_POSITIVE_PROMPT_WINDOW_MS,
  FINDING_SEVERITIES,
  INCOMPLETE_OUTCOME,
  MAX_CHAINS,
  MAX_INCIDENTS,
  MAX_PROMPT_FINDINGS,
  type FindingChain,
  type FindingCounts,
  type FindingSeverity,
  type FindingsStore,
  type Incident,
  type PluginOutcome,
  type ReportedFinding,
  type ReviewOutcome,
  type ReviewReport,
} from "./findings-schema.js";
import type { PromptFinding } from "./prompt-findings.js";

/**
 * The pure half of the per-thread findings: how a report folds into the
 * chains, what the next review's prompt lists, and the badge's summary. The
 * schemas live in `findings-schema.ts`, the KV reads and writes in
 * `findings-store.ts`.
 */

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
    // A fix is a real resolution: a later dismissal is a new judgement, not a
    // repeat of the one before the fix.
    next.reRaised = false;
    next.dismissReason = undefined;
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

/** Incident detail as it is stored: control characters stripped, capped. */
function cleanIncidentDetail(detail: string): string {
  return stripControl(detail).slice(0, 300);
}

/**
 * Replaces this review's `incomplete` incident, never appending a duplicate;
 * without a detail, a passing report for the same review drops it. Other
 * incidents are untouched.
 */
function replaceIncompleteIncident(
  incidents: Incident[],
  reviewId: number,
  now: number,
  detail: string | undefined,
): Incident[] {
  const kept = incidents.filter(
    (incident) => incident.kind !== "incomplete" || incident.reviewId !== reviewId,
  );
  if (detail === undefined) {
    return kept;
  }
  const incident: Incident = {
    at: now,
    kind: "incomplete",
    detail: cleanIncidentDetail(detail),
    reviewId,
  };
  return [...kept, incident].slice(-MAX_INCIDENTS);
}

/**
 * Folds one review's report into the store. Pure.
 *
 * The last report of a review replaces earlier ones: those are reverted first,
 * so a repeat call never double-counts, a chain only an earlier report named
 * goes away or reverts, and fixed-then-open within one review is not a
 * re-raise. A report is never refused as a whole — a repeated dismissal
 * without a new reason is skipped finding by finding, so the outcome is kept.
 *
 * With `incomplete`, the record's outcome becomes `incomplete` (the summary is
 * kept unchanged) and the review's incident is written; without it, a passing
 * report of the same review drops that incident again.
 */
export function mergeReport(
  store: FindingsStore,
  report: ReviewReport,
  reviewId: number,
  now: number,
  incomplete?: { detail: string },
): MergeResult {
  // The same key twice in one report is one finding; the later entry wins.
  const byKey = new Map(report.findings.map((finding) => [finding.key, finding]));
  let chains = revertReview(store.chains, reviewId);
  const ignored: IgnoredFinding[] = [];
  // Counted from what was applied: a duplicate key or an ignored re-dismissal
  // changed nothing, so the review did not find it.
  const applied: ReportedFinding[] = [];
  for (const finding of byKey.values()) {
    const result = applyFinding(chains[finding.key], finding, reviewId, now);
    if ("ignored" in result) {
      ignored.push(result.ignored);
    } else {
      chains = { ...chains, [finding.key]: result.chain };
      applied.push(finding);
    }
  }
  const counts = countFindings(applied);
  return {
    store: {
      chains: evict(chains, new Set(byKey.keys())),
      lastReport: {
        reviewId,
        at: now,
        outcome: incomplete === undefined ? report.outcome : INCOMPLETE_OUTCOME,
        summary: report.summary,
        counts,
      },
      incidents: replaceIncompleteIncident(store.incidents, reviewId, now, incomplete?.detail),
    },
    ignored,
    counts,
  };
}

/** The outcome of a review the plugin ended without a report. */
export interface UnreportedOutcome {
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
          { at: now, kind: entry.incident.kind, detail: cleanIncidentDetail(entry.incident.detail) },
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
  /** When the last review ended; null while one is pending, so the old review's time is not shown against it. */
  at: number | null;
  openCount: number;
  reRaisedCount: number;
  /** Open findings the next review's prompt cannot list (see `MAX_PROMPT_FINDINGS`). */
  omittedFromPrompt: number;
  lastIncident: Incident | null;
}

/**
 * How many open chains the next review's prompt cannot list. Open chains sort
 * ahead of dismissed ones, so the cap only ever cuts open chains once they
 * alone exceed it; recent false positives in the omitted count would make
 * "3 open — 8 not listed" possible.
 */
export function omittedOpenCount(store: FindingsStore): number {
  return Math.max(0, openChains(store).length - MAX_PROMPT_FINDINGS);
}

export function summarizeReview(store: FindingsStore, inFlight: boolean): ReviewSummary {
  const open = openChains(store);
  const status = reviewStatusOf(store, inFlight);
  return {
    status,
    at: status === "pending" ? null : (store.lastReport?.at ?? null),
    openCount: open.length,
    reRaisedCount: open.filter((chain) => chain.reRaised).length,
    omittedFromPrompt: omittedOpenCount(store),
    lastIncident: store.incidents.at(-1) ?? null,
  };
}
