export interface DecideInput {
  base: string | null;
  currentBranch: string | null;
  mergeEligibleMainlines: readonly string[];
}

export interface Decision {
  commit: boolean;
  merge: boolean;
}

export function isPersonalMainline(input: DecideInput): boolean {
  return input.base !== null && input.mergeEligibleMainlines.includes(input.base);
}

// A feature branch is one whose name contains a "/" — fix/oh-1/x, OH-2/y, and
// bb's own worktree branches (bb/<slug>). A name without one (develop, dev,
// sandbox) is a top-level branch and is never merged anywhere.
export function isFeatureBranch(branch: string | null): boolean {
  return branch !== null && branch.includes("/");
}

export function decide(input: DecideInput): Decision {
  const personal = isPersonalMainline(input);
  const onMainline =
    input.currentBranch !== null && input.currentBranch === input.base;
  // Merge a feature branch into a personal mainline (e.g. master) in a dedicated
  // worktree or the primary checkout alike — a worktree is not required. The merge
  // is local-only and its working-tree-safety guard lives in the injected prompt,
  // not in a worktree precondition. A non-personal mainline (e.g. main) is never a
  // merge target, and a top-level branch is never a merge source. The mainline
  // guard still matters: a configured mainline may itself contain a "/".
  const merge = personal && !onMainline && isFeatureBranch(input.currentBranch);
  // Commit on a personal mainline (e.g. master) anywhere. On a non-eligible
  // mainline (e.g. main, dev) commit only on a feature branch, in a dedicated
  // worktree or the primary checkout alike — never on the mainline itself
  // (even when its name contains a "/"), a top-level branch, or a detached HEAD.
  const commit = personal || (!onMainline && isFeatureBranch(input.currentBranch));
  return { commit, merge };
}
