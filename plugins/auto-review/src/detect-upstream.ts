import type { BbPluginApi } from "@get-bb/plugin-sdk";

import type { TreeSnapshot, TurnStart } from "./state.js";

import { remoteReachableShas, remoteRef } from "./detect-commits.js";

import {
  authoredPathsFromRows,
  kinEvidence,
  mayHaveMovedRemoteRef,
  ownWindows,
  rowsSince,
  withinWindow,
} from "./detect-timeline.js";
import type { KinEvidence, turnTimeline } from "./detect-timeline.js";

import { headShaOf, mainlineBase } from "./detect-workspace.js";
import type { AvailableWorkspace, ThreadListEntry } from "./detect-workspace.js";

/** A commit made during the turn, with the paths it touched; null when they could not be read. */
export interface CommitChange {
  sha: string;
  paths: string[] | null;
  authoredAt: number | null;
}

export interface TreeChanges {
  /** Every changed path, committed ones included. */
  paths: string[];
  /** Commits made during the turn. */
  commits: string[];
  /** Paths those commits touched. */
  committedPaths: string[];
  /** Each of those commits with its own paths and time. */
  commitChanges: CommitChange[];
  /** The changed paths the working tree shows, committed ones left out. */
  uncommittedPaths: string[];
  /** Set when the list of commits made during the turn may be missing some. */
  capped?: true;
}

/** The snapshot taken when a turn was last parked behind another thread's review. */
export interface ParkBaseline {
  startedAt: number;
  tree: TreeSnapshot;
}

export interface TurnChangeInput {
  threadId: string;
  environmentId: string;
  turnStart: TurnStart;
  workspace: AvailableWorkspace;
  threadEntries: readonly ThreadListEntry[];
  /** Set only for a turn released from a provider park whose snapshot can serve as a baseline; see `withoutParked`. */
  park?: ParkBaseline;
}

export interface UpstreamInput {
  bb: BbPluginApi;
  input: TurnChangeInput;
  startedAt: number;
  now: number;
  ownRows: Awaited<ReturnType<typeof turnTimeline>>;
  /** Paths the thread's own rows changed through its tools this turn. */
  ownPaths: ReadonlySet<string>;
  commits: readonly CommitChange[];
}

/**
 * The remote-tracking refs a pulled commit may have arrived with: the mainline
 * base's first, then the checkout's own branch's when that is another branch.
 */
function upstreamRefs(workspace: AvailableWorkspace): string[] {
  const base = remoteRef(mainlineBase(workspace));
  const { currentBranch } = workspace.branch;
  const own = currentBranch ? remoteRef(currentBranch) : base;
  return own === base ? [base] : [base, own];
}

/**
 * The commits the remote base, or the checkout's own branch, brought in that
 * someone else merged, each with the first ref that holds it: reachable from
 * `origin/<base>` or from `origin/<branch>` (a `git pull` of it), and authored
 * outside every window this thread's family was running, the windows
 * `foreignCommitsOf` treats as ours, and touching none of the family's
 * tool-edited files. A commit the thread makes is authored while one of its
 * rows runs, whatever tool made it. A rewrite keeps the author date, though
 * (`git commit --amend`, `rebase`, `cherry-pick`): one of the thread's earlier
 * turns may have authored a commit that this turn only amended. So the windows
 * reach back to the earliest candidate's author date. What stays accepted is a
 * rewrite of a commit the thread never authored, such as a cherry-pick of
 * someone else's old commit: it still counts as upstream.
 *
 * Nothing is dropped when a row of the family since the turn start, or since
 * that date when it is earlier, may have moved a remote-tracking ref
 * (`mayMoveRemoteRef`), or when a tool edited a file that holds one (under
 * `refs/remotes/`, `packed-refs`, `.git/config`): a commit of the thread's own,
 * even backdated, would then be reachable from the remote and look pulled. A
 * push made through a script, an alias or a tool that is not a shell row goes
 * unseen, and so does a push in an earlier turn of a commit whose author date
 * is later than that push. Any doubt keeps a commit with the turn.
 */
async function upstreamCommitsOf(
  upstream: UpstreamInput,
): Promise<{ dropped: Array<{ sha: string; ref: string }>; kin: KinEvidence | undefined }> {
  const { bb, input, startedAt, now, ownRows, ownPaths, commits } = upstream;
  const refs = upstreamRefs(input.workspace);
  const none = { dropped: [], kin: undefined };
  const skip = (reason: string, kin?: KinEvidence) => {
    bb.log.info(`auto-review: not checking whether the turn's commits came from ${refs.join(" or ")}: ${reason}`);
    return { dropped: [], kin };
  };
  const dated = commits.flatMap(({ sha, authoredAt, paths }) =>
    authoredAt === null ? [] : [{ sha, authoredAt, paths }],
  );
  if (dated.length === 0) {
    return none;
  }
  if (ownRows.truncated) {
    return skip("the thread's timeline is truncated");
  }
  const own = ownWindows(ownRows.rows, startedAt, now);
  const outside = dated.filter(({ authoredAt }) => !own.some((window) => withinWindow(window, authoredAt)));
  if (outside.length === 0) {
    return none;
  }
  const reachable = await Promise.all(
    refs.map((ref) =>
      remoteReachableShas(
        bb,
        input.environmentId,
        ref,
        outside.map(({ sha }) => sha),
        headShaOf(input.workspace),
      ),
    ),
  );
  // The first ref that holds a commit.
  const holder = (sha: string) => refs.find((_ref, at) => reachable[at]?.has(sha));
  const candidates = outside.filter(({ sha }) => holder(sha) !== undefined);
  if (candidates.length === 0) {
    return none;
  }
  const since = Math.min(startedAt, ...candidates.map(({ authoredAt }) => authoredAt));
  const rows = since < startedAt ? await rowsSince(bb, input.threadId, since) : ownRows.rows;
  if (typeof rows === "string") {
    return skip(rows);
  }
  const kin = await kinEvidence(bb, input.threadEntries, input.threadId, since, now);
  // Evidence read from an earlier `since` holds windows `foreignCommitsOf` must not count as ours.
  const reusable = since === startedAt ? kin : undefined;
  if (!kin.complete) {
    return skip("a related thread could not be read in full", reusable);
  }
  const windows = [...ownWindows(rows, since, now), ...kin.windows];
  // Every row of the lookback counts; of this turn's own rows only the turn's, as for `ownPaths`.
  const lookbackPaths = authoredPathsFromRows(
    rows,
    since < startedAt ? Number.NEGATIVE_INFINITY : input.turnStart.sinceSeq,
  );
  const familyPaths = new Set([...ownPaths, ...lookbackPaths, ...kin.paths]);
  const moved = [
    { id: input.threadId, rows },
    ...kin.threads.map((threadRows, at) => ({ id: kin.threadIds[at] ?? "", rows: threadRows })),
  ].filter((thread) => mayHaveMovedRemoteRef(thread.rows, since, now));
  if (moved.length > 0) {
    const ids = moved.map(({ id }) => id).join(", ");
    return skip(
      `the thread's family may have pushed or moved a remote-tracking ref since ${new Date(since).toISOString()} (${moved.length > 1 ? "threads" : "thread"} ${ids})`,
      reusable,
    );
  }
  const holdsRemotes = (path: string) =>
    path.includes("refs/remotes/") || path.endsWith("packed-refs") || path.endsWith(".git/config");
  const edited = new Set(
    [
      { id: input.threadId, paths: [...ownPaths, ...lookbackPaths] },
      ...kin.threads.map((threadRows, at) => ({
        id: kin.threadIds[at] ?? "",
        paths: authoredPathsFromRows(threadRows, Number.NEGATIVE_INFINITY),
      })),
    ].flatMap(({ id, paths }) => paths.filter(holdsRemotes).map((path) => `${path} (thread ${id})`)),
  );
  if (edited.size > 0) {
    return skip(
      `the thread's family edited a file that holds remote-tracking refs or remotes: ${[...edited].join(", ")}`,
      reusable,
    );
  }
  const dropped = candidates.flatMap(({ sha, authoredAt, paths }) => {
    const ref = holder(sha);
    return ref !== undefined &&
      paths !== null &&
      !windows.some((window) => withinWindow(window, authoredAt)) &&
      !paths.some((path) => familyPaths.has(path))
      ? [{ sha, ref }]
      : [];
  });
  return { dropped, kin: reusable };
}

/** `tree` without the commits `dropped`, and the paths only they touched. */
export function withoutCommits(tree: TreeChanges, dropped: ReadonlySet<string>): TreeChanges {
  const commitChanges = tree.commitChanges.filter(({ sha }) => !dropped.has(sha));
  const committedPaths = [...new Set(commitChanges.flatMap(({ paths }) => paths ?? []))];
  return {
    ...tree,
    paths: [...new Set([...tree.uncommittedPaths, ...committedPaths])],
    commits: commitChanges.map(({ sha }) => sha),
    committedPaths,
    commitChanges,
  };
}

/** `fetched` without the commits that arrived with the remote base or the checkout branch's own remote-tracking ref, which are logged; none are dropped when the turn start time is unknown. */
export async function withoutUpstream(
  context: Omit<UpstreamInput, "startedAt" | "commits">,
  fetched: TreeChanges,
): Promise<{ tree: TreeChanges; shas: string[]; kin: KinEvidence | undefined }> {
  const { bb, input } = context;
  const { startedAt } = input.turnStart;
  const { dropped, kin } =
    startedAt === undefined || fetched.commitChanges.length === 0
      ? { dropped: [], kin: undefined }
      : await upstreamCommitsOf({ ...context, startedAt, commits: fetched.commitChanges });
  for (const { sha, ref } of dropped) {
    bb.log.info(`auto-review: commit ${sha} came from ${ref}; not this turn's`);
  }
  const shas = dropped.map(({ sha }) => sha);
  return { tree: withoutCommits(fetched, new Set(shas)), shas, kin };
}
