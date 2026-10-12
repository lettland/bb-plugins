/** Review-prompt text about the commits of the turn, this thread's and another thread's. Shas arrive already validated. */

/**
 * Commits another thread made during the turn. Only their shas are named, and
 * only ones shaped like a commit.
 */
export function foreignCommitNote(foreign: readonly string[], committedSince: string | null): string {
  const inRange =
    committedSince === null
      ? ""
      : ` They may appear in the range after ${committedSince}; they are still not this thread's.`;
  return `Another thread in this checkout made ${foreign.length === 1 ? "this commit" : "these commits"} during this turn: ${foreign.join(", ")}. ${foreign.length === 1 ? "It is" : "They are"} not part of your work: do not review, stage, complete, amend, or otherwise rewrite ${foreign.length === 1 ? "it" : "them"}; only a secret in ${foreign.length === 1 ? "it" : "them"} is reported (step 5).${inRange}`;
}

export interface CommitScanInput {
  scanSince: string | null;
  /** Commits another thread made during the turn. */
  hasForeign: boolean;
  /** Commits this thread made during the turn. */
  hasOwn: boolean;
  /** Step 8, the merge, is part of this prompt. */
  merge: boolean;
}

/** Step 5's scan of the turn's commits; empty when the turn made none. */
export function commitScan({ scanSince, hasForeign, hasOwn, merge }: CommitScanInput): string {
  if (scanSince === null) {
    return "";
  }
  const range = `\`git diff ${scanSince}..HEAD\``;
  const stop = "is already committed, so STOP and report it — do not rewrite history to remove it.";
  if (!hasForeign) {
    return ` Scan this turn's commits too (${range}); a secret found there ${stop}`;
  }
  const scanned = hasOwn
    ? `Scan this turn's commits too, yours and the other thread's (${range}); a secret found in one of your commits ${stop} A secret found only in the other thread's commit`
    : `Scan the commits the other thread made this turn too (${range}); a secret found there`;
  const skipMerge = merge ? " and skip the merge in step 8, saying so in your reply" : "";
  return ` ${scanned} is not yours: report it by file:line and type, never by value, and do not rewrite history. Do not STOP for it: still commit your own work${skipMerge}.`;
}
