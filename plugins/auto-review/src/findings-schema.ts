import { z } from "zod";
import { SCOPE_PATH_ALLOW } from "./scope-path.js";
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
 * exist so such a review never looks like a pass. An incomplete review is not
 * one of them even though the plugin records it too: it rides in through
 * `mergeReport` on the agent's own report, never as an unreported outcome.
 */
export const PLUGIN_OUTCOMES = ["not-reported", "stopped", "unavailable"] as const;
export type PluginOutcome = (typeof PLUGIN_OUTCOMES)[number];

/** The outcome for a review that did not run as asked: never an agent outcome, so no report can pass it. */
export const INCOMPLETE_OUTCOME = "incomplete";

export const REVIEW_OUTCOMES = [...AGENT_OUTCOMES, ...PLUGIN_OUTCOMES, INCOMPLETE_OUTCOME] as const;
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
    /** A secret, credential or other security issue: it ends the file's review baseline. */
    security: z.boolean().optional(),
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
  /** The parts of review step 1 the agent did not run as written. */
  skipped: z.array(cleanText(120).pipe(z.string().min(1))).max(10).optional(),
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
  kind: z.enum(["send-failed", "not-reported", "incomplete"]),
  detail: z.string(),
  /** For an `incomplete` incident: the review it belongs to, so a later report of it can replace or clear it. */
  reviewId: z.number().optional(),
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
