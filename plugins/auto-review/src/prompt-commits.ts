/** Review-prompt text about the commits of the turn, this thread's, another thread's and the remote base's. Shas arrive already validated. */

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

/**
 * Commits that arrived with the remote base during the turn, merged by someone
 * else. The range after the turn-start head holds them next to this thread's
 * own commits, so both sets are named: the own ones are what to review.
 */
export function upstreamCommitNote(
  upstream: readonly string[],
  own: readonly string[],
  rangeFrom: string,
): string {
  const many = upstream.length > 1;
  const reviewOwn =
    own.length === 0
      ? ""
      : ` This thread's own ${own.length === 1 ? "commit is" : "commits are"} ${own.join(", ")}: review exactly ${own.length === 1 ? "that one" : "those"} (\`git show <sha>\`), not the rest of the range, and ignore the other commits' files in the range's diff.`;
  return `The range after ${rangeFrom} also holds ${many ? "commits" : "a commit"} merged from the remote base, not made by this thread: ${upstream.join(", ")}. ${many ? "They" : "It"} may appear in that range and in its diff, but ${many ? "are" : "is"} not part of your work: do not review, stage, complete, amend, or otherwise rewrite ${many ? "them" : "it"}; only a secret in ${many ? "them" : "it"} is reported (step 5).${reviewOwn}`;
}

export interface CommitScanInput {
  scanSince: string | null;
  /** Commits another thread made during the turn. */
  hasForeign: boolean;
  /** Commits merged from the remote base during the turn. */
  hasUpstream: boolean;
  /** Commits this thread made during the turn. */
  hasOwn: boolean;
  /** Step 8, the merge, is part of this prompt. */
  merge: boolean;
}

/** Step 5's scan of the turn's commits; empty when the turn made none. */
export function commitScan({ scanSince, hasForeign, hasUpstream, hasOwn, merge }: CommitScanInput): string {
  if (scanSince === null) {
    return "";
  }
  const range = `\`git diff ${scanSince}..HEAD\``;
  const stop = "is already committed, so STOP and report it — do not rewrite history to remove it.";
  if (!hasForeign && !hasUpstream) {
    return ` Scan this turn's commits too (${range}); a secret found there ${stop}`;
  }
  const scanned = hasOwn
    ? hasUpstream
      ? `Scan this turn's commits too, yours and the other commits in that range (${range}); a secret found in one of your commits ${stop} A secret found only in one of the other commits`
      : `Scan this turn's commits too, yours and the other thread's (${range}); a secret found in one of your commits ${stop} A secret found only in the other thread's commit`
    : hasUpstream
      ? `Scan the other commits in that range too (${range}); a secret found there`
      : `Scan the commits the other thread made this turn too (${range}); a secret found there`;
  const skipMerge = merge ? " and skip the merge in step 8, saying so in your reply" : "";
  return ` ${scanned} is not yours: report it by file:line and type, never by value, and do not rewrite history. Do not STOP for it: still commit your own work${skipMerge}.`;
}
