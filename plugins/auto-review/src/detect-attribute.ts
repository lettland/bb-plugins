/**
 * Decides whether a turn's unattributed changes are claimed exactly or swept
 * (see `detect-claim.ts`), and which of the turn's commits are the family's.
 */

import type { BbPluginApi } from "@get-bb/plugin-sdk";

import { familyClaims, resolveClaims, strayCommitReason } from "./detect-claim.js";
import type { CommitFacts } from "./detect-claim.js";
import { pathsLeftToSiblings } from "./detect-sibling-credit.js";
import type { KinEvidence, SiblingEvidence, turnTimeline } from "./detect-timeline.js";
import type { ForeignCommit, TreeChanges, TurnChangeInput, TurnChanges } from "./detect-turn.js";
import type { ThreadListEntry } from "./detect-workspace.js";

/** The most example paths a log line names. */
const LOG_EXAMPLES = 5;

interface ClaimContext {
  bb: BbPluginApi;
  threadId: string;
  environmentId: string;
  threadEntries: readonly ThreadListEntry[];
  startedAt: number | undefined;
  now: number;
  ownRowsTruncated: boolean;
  /** The kin evidence already read, when there was one. */
  kin: KinEvidence | undefined;
  /** Uncommitted changed paths no tool edit of this thread, sibling credit or harness state accounts for. */
  loose: readonly string[];
  /** The commits made during the turn that are not another thread's. */
  commits: readonly CommitFacts[];
  /** Paths this thread's own `file-change` rows changed. */
  ownPaths: ReadonlySet<string>;
}

interface ClaimOutcome {
  mode: "exact" | "sweep";
  /** The commits that are the family's. */
  commits: CommitFacts[];
  /** In exact mode, the loose paths the family claims. */
  claimed: Set<string>;
  /** In exact mode, the loose paths nothing of the family claims. */
  unclaimed: string[];
  kin: KinEvidence | undefined;
}

function examples(paths: readonly string[]): string {
  const shown = paths.slice(0, LOG_EXAMPLES).join(", ");
  return paths.length > LOG_EXAMPLES ? `${shown} and ${paths.length - LOG_EXAMPLES} more` : shown;
}

/**
 * Claims the turn's own changes. It is exact when everything the family ran
 * was read-only or named what it wrote, and a sweep otherwise or when the
 * evidence could not be read in full, the reason logged without any command's
 * arguments. A commit is dropped, and logged with its sha, only when nothing
 * the family did could have made it (see `strayCommitReason`).
 */
export async function claimOwnChanges(context: ClaimContext): Promise<ClaimOutcome> {
  const { bb, startedAt, loose } = context;
  const sweep = (reason: string, kin = context.kin): ClaimOutcome => {
    bb.log.info(`auto-review: attributing the turn's changes by sweep: ${reason}`);
    return { mode: "sweep", commits: [...context.commits], claimed: new Set(), unclaimed: [], kin };
  };
  if (loose.length === 0 && context.commits.length === 0) {
    return { mode: "exact", commits: [], claimed: new Set(), unclaimed: [], kin: context.kin };
  }
  if (startedAt === undefined) {
    return sweep("the turn's start time is unknown");
  }
  const read = await familyClaims({ ...context, startedAt });
  if ("reason" in read) {
    return sweep(read.reason);
  }
  const { claims: family, kin } = read;
  if (family.stale.length > 0) {
    bb.log.info(`auto-review: an open command from before the turn claims nothing: ${[...new Set(family.stale)].join(", ")}`);
  }
  const commitPaths = new Set(context.commits.flatMap(({ paths }) => paths ?? []));
  const resolution =
    family.opaque === undefined
      ? await resolveClaims(bb, context.environmentId, family, [...new Set([...loose, ...commitPaths])])
      : undefined;
  const familyPaths = new Set([...context.ownPaths, ...kin.paths, ...(resolution?.claimed ?? [])]);
  const commits = context.commits.filter((commit) => {
    const reason = strayCommitReason(commit, family, familyPaths);
    if (reason !== null) {
      bb.log.info(`auto-review: commit ${commit.sha} left out of the review: ${reason}`);
    }
    return reason === null;
  });
  const reason =
    family.opaque === undefined
      ? resolution?.sweep
      : `${family.opaque} ran, and the files it writes cannot be listed`;
  if (reason !== undefined || resolution === undefined) {
    return { ...sweep(reason ?? "the writes could not be resolved", kin), commits };
  }
  const claimed = new Set([...resolution.claimed, ...loose.filter((path) => kin.paths.has(path))]);
  const kept = new Set(commits.flatMap(({ paths }) => paths ?? []));
  const unclaimed = loose.filter((path) => !claimed.has(path) && !kept.has(path));
  if (unclaimed.length > 0) {
    bb.log.info(`auto-review: attributing the turn's changes exactly; ${unclaimed.length} change(s) the thread did not make are left out of the review: ${examples(unclaimed)}`);
  }
  return { mode: "exact", commits, claimed, unclaimed, kin };
}

/** What `turnChangedPaths` has read of a turn once the sibling and upstream filtering is done. */
export interface TurnReading {
  bb: BbPluginApi;
  input: TurnChangeInput;
  now: number;
  ownRows: Awaited<ReturnType<typeof turnTimeline>>;
  /** Paths this thread's own `file-change` rows changed this turn. */
  own: string[];
  tree: TreeChanges;
  sibling: SiblingEvidence | undefined;
  foreignCommits: ForeignCommit[];
  upstreamCommits: string[];
  kin: KinEvidence | undefined;
  /** Changed paths this thread's own rows and harness state do not account for. */
  unattributed: (paths: readonly string[]) => string[];
}

/** The turn's paths once the family's claims are read: exact (only what it claimed) or swept (every unattributed change a sibling does not own). */
export async function claimedChanges(turn: TurnReading): Promise<TurnChanges> {
  const { bb, input, now, ownRows, own, tree, sibling, unattributed } = turn;
  const { threadId, environmentId } = input;
  const { startedAt } = input.turnStart;
  const ownSet = new Set(own);
  const foreignShas = new Set(turn.foreignCommits.map(({ sha }) => sha));
  const ours = (path: string) => ownSet.has(path) || !sibling?.paths.has(path);
  const outcome = await claimOwnChanges({
    bb,
    threadId,
    environmentId,
    threadEntries: input.threadEntries,
    startedAt,
    now,
    ownRowsTruncated: ownRows.truncated,
    kin: turn.kin,
    loose: unattributed(tree.uncommittedPaths),
    commits: tree.commitChanges.filter(({ sha }) => !foreignShas.has(sha)),
    ownPaths: ownSet,
  });
  const keptPaths = [...new Set(outcome.commits.flatMap(({ paths }) => paths ?? []))];
  const result = {
    commits: outcome.commits.map(({ sha }) => sha),
    committedPaths: keptPaths.filter(ours),
    foreignCommits: turn.foreignCommits,
    upstreamCommits: turn.upstreamCommits,
    mode: outcome.mode,
    unclaimed: outcome.unclaimed,
  };
  if (outcome.mode === "exact") {
    const claimed = tree.uncommittedPaths.filter((path) => outcome.claimed.has(path));
    return { ...result, paths: [...own, ...unattributed([...new Set([...result.committedPaths, ...claimed])])] };
  }
  const committed = new Set(keptPaths);
  const credited =
    startedAt === undefined || sibling === undefined
      ? new Map<string, string>()
      : await pathsLeftToSiblings({
          bb,
          threadId,
          environmentId,
          threadEntries: input.threadEntries,
          startedAt,
          now,
          ownRowsTruncated: ownRows.truncated,
          sibling,
          kin: outcome.kin,
          candidates: unattributed(tree.uncommittedPaths).filter((path) => ours(path) && !committed.has(path)),
        });
  const swept = unattributed([...new Set([...tree.uncommittedPaths, ...keptPaths])]);
  return { ...result, paths: [...own, ...swept.filter((path) => ours(path) && !credited.has(path))] };
}
