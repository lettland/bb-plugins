/** Review-prompt text about the commits of the turn, this thread's, another thread's, the remote base's and those that arrived while the turn waited. */

/** A commit sha, the only shape a committed range is ever rendered from. */
export const COMMIT_SHA_ALLOW = /^[0-9a-f]{7,64}$/u;

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
 * Commits that arrived while the turn waited in the review queue. Someone else
 * made them, so they are named like another thread's: they stay out of the
 * review, and only a secret in them is reported.
 */
export function parkedCommitNote(parked: readonly string[], committedSince: string | null): string {
  const one = parked.length === 1;
  const inRange =
    committedSince === null
      ? ""
      : ` ${one ? "It" : "They"} may appear in the range after ${committedSince}; ${one ? "it is" : "they are"} still not this thread's.`;
  return `${one ? "This commit" : "These commits"} arrived while this turn waited in the review queue: ${parked.join(", ")}. Someone else made ${one ? "it" : "them"}, so ${one ? "it is" : "they are"} not part of your work: do not review, stage, complete, amend, or otherwise rewrite ${one ? "it" : "them"}; only a secret in ${one ? "it" : "them"} is reported (step 5).${inRange}`;
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
      : ` This thread's own ${own.length === 1 ? "commit is" : "commits are"} ${own.join(", ")}: review exactly ${own.length === 1 ? "that one" : "those"} (\`git show <sha>\`), not the rest of the range, and ignore the other commits' changes in the range's diff, except in files this thread's own commits touch too.`;
  return `The range after ${rangeFrom} also holds ${many ? "commits" : "a commit"} merged from the remote base, not made by this thread: ${upstream.join(", ")}. ${many ? "They" : "It"} may appear in that range and in its diff, but ${many ? "are" : "is"} not part of your work: do not review, stage, complete, amend, or otherwise rewrite ${many ? "them" : "it"}; only a secret in ${many ? "them" : "it"} is reported (step 5).${reviewOwn}`;
}

export interface CommitScanInput {
  scanSince: string | null;
  /** Commits another thread made during the turn. */
  hasForeign: boolean;
  /** Commits merged from the remote base during the turn. */
  hasUpstream: boolean;
  /** Commits that arrived while the turn waited in the review queue. */
  hasParked: boolean;
  /** Commits this thread made during the turn. */
  hasOwn: boolean;
  /** Step 8, the merge, is part of this prompt. */
  merge: boolean;
}

/** Step 5's scan of the turn's commits; empty when the turn made none. */
export function commitScan({ scanSince, hasForeign, hasUpstream, hasParked, hasOwn, merge }: CommitScanInput): string {
  if (scanSince === null) {
    return "";
  }
  const range = `\`git diff ${scanSince}..HEAD\``;
  const stop = "is already committed, so STOP and report it — do not rewrite history to remove it.";
  if (!hasForeign && !hasUpstream && !hasParked) {
    return ` Scan this turn's commits too (${range}); a secret found there ${stop}`;
  }
  // Commits from the remote base or the queue are named as "the other commits", which also fits when another thread's are among them.
  const generic = hasUpstream || hasParked;
  const scanned = hasOwn
    ? generic
      ? `Scan this turn's commits too, yours and the other commits in that range (${range}); a secret found in one of your commits ${stop} A secret found only in one of the other commits`
      : `Scan this turn's commits too, yours and the other thread's (${range}); a secret found in one of your commits ${stop} A secret found only in the other thread's commit`
    : generic
      ? `Scan the other commits in that range too (${range}); a secret found there`
      : `Scan the commits the other thread made this turn too (${range}); a secret found there`;
  const skipMerge = merge ? " and skip the merge in step 8, saying so in your reply" : "";
  return ` ${scanned} is not yours: report it by file:line and type, never by value, and do not rewrite history. Do not STOP for it: still commit your own work${skipMerge}.`;
}

interface TurnCommitTextInput {
  /** Commits another thread made during the turn. */
  foreign: readonly string[];
  /** Commits merged from the remote base; named only when there is a range to put them in. */
  upstream: readonly string[];
  /** Commits that arrived while the turn waited in the review queue. */
  parked: readonly string[];
  /** This thread's own commits; named only next to `upstream`. */
  own: readonly string[];
  committedSince: string | null;
  scanSince: string | null;
  /** Step 8, the merge, is part of this prompt. */
  merge: boolean;
}

interface TurnCommitText {
  /** Notes naming the commits that are not this thread's, each its own paragraph. */
  notes: string[];
  /** The step 5 scan of the turn's commits. */
  scan: string;
  /** The step 4 sentence leaving the other commits' files out; empty when there are none. */
  skipFiles: string;
}

/**
 * The commit-related text `buildReviewPrompt` assembles. Anything not shaped
 * like a commit sha is dropped first, so a value from outside never reaches the
 * prompt.
 */
export function turnCommitText(input: TurnCommitTextInput): TurnCommitText {
  const shas = (values: readonly string[]) => values.filter((sha) => COMMIT_SHA_ALLOW.test(sha));
  const foreign = shas(input.foreign);
  const upstream = shas(input.upstream);
  const parked = shas(input.parked);
  const { committedSince, scanSince } = input;
  const rangeFrom = committedSince ?? scanSince;
  const notes: string[] = [];
  if (foreign.length > 0) {
    notes.push(foreignCommitNote(foreign, committedSince));
  }
  if (parked.length > 0) {
    notes.push(parkedCommitNote(parked, committedSince));
  }
  const upstreamNamed = upstream.length > 0 && rangeFrom !== null;
  if (upstreamNamed) {
    notes.push(upstreamCommitNote(upstream, shas(input.own), rangeFrom));
  }
  const named = [
    ...(foreign.length > 0 ? ["the other thread's commits"] : []),
    ...(parked.length > 0 ? ["the commits that arrived while this turn waited"] : []),
    ...(upstreamNamed ? ["the commits merged from the remote base"] : []),
  ];
  return {
    notes,
    scan: commitScan({
      scanSince,
      hasForeign: foreign.length > 0,
      hasUpstream: upstream.length > 0,
      hasParked: parked.length > 0,
      hasOwn: committedSince !== null,
      merge: input.merge,
    }),
    skipFiles:
      named.length === 0
        ? ""
        : ` Leave out the files of ${named.join(" and of ")} named above, unless your own commits touch them too (list them with \`git show --name-only --format= <sha>\`).`,
  };
}
