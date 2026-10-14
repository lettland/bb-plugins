import type { ReviewMode } from "./prompt.js";

/**
 * Review-prompt text about delta-scoped baselines: private per-thread copies of what
 * earlier reviews read, so a later review covers only what changed since.
 */

/** Where plan reviews keep their snapshots, in bb's private per-thread storage (the agent's shell expands the variable). */
export const PLAN_BASELINE_DIR = "$BB_THREAD_STORAGE/auto-review/plan";

/** Where no-commit code reviews keep their snapshots. */
const CODE_BASELINE_DIR = "$BB_THREAD_STORAGE/auto-review/code";

/** The check comes first: nothing is created or written until the storage is known to be the agent's own. */
const NO_BASELINE_RULE =
  "First, if `$BB_THREAD_STORAGE` is unset, or `$BB_THREAD_STORAGE/auto-review` or its `plan`/`code` subdirectory is a symlink or not owned by you, there is no baseline: review everything and write no copies.";

const DELTA_SCOPE_REFERENCE = 'devkit_load_skill({ reference: "review-delta-scope" })';

const hashCommand = (path: string): string =>
  `\`printf '%s' "${path}" | { shasum -a 256 2>/dev/null || sha256sum; } | cut -c1-64\` (if the result is not 64 hex characters, there is no baseline: review everything and write no copies)`;

/** The one phrase for a finding that blocks promotion, presenting and committing. */
export const BLOCKER = "Blocker or security Concern";

const makeDirs = (kind: "plan" | "code"): string =>
  `\`mkdir -p -m 700 "$BB_THREAD_STORAGE/auto-review" "$BB_THREAD_STORAGE/auto-review/${kind}"\``;

const SAFE_WRITE = "(`rm -f` the destination first; never write through a symlink)";

/** The delta is every changed line, so a deletion or a revert of an earlier fix is reviewed, not skipped. */
const DELTA_LINES = (copy: string, file: string): string =>
  `every line changed in \`git diff --no-index -- ${copy} ${file}\` (exit 1 means it differs), deletions and reverts included — a change you did not make (another party's discard) is reported, never restored`;

/**
 * The delta rule for a plan, stated in full so it works without the devkit
 * reference; `withReference` adds the pointer where devkit may be in use.
 */
export function planDeltaRule(withReference: boolean): string {
  const reference = withReference ? ` — details: \`${DELTA_SCOPE_REFERENCE}\`` : "";
  return `Baseline: ${PLAN_BASELINE_DIR} is a flat directory with one \`<hash>.copy\` per plan and a \`manifest.tsv\` of path, content sha256, HEAD sha and HEAD blob rows${reference}. If a copy of this plan exists there, review only the plan's delta against it: ${DELTA_LINES("<copy>", "<plan file>")}. Report issues the delta causes or exposes anywhere in the plan, and treat unchanged parts it does not affect as context only. If the delta is empty, skip the review and the fixes, promote the pending copy as step 2 describes, and continue at step 3 to present again. With no copy, review the whole plan. State the scope used in your reply: \`delta vs baseline\` or \`full (no baseline)\`.`;
}

/**
 * The review reads the old `.copy` for its delta, and devkit's review applies its
 * own fixes inside step 1, so the content it reads is parked as `.pending` first.
 */
export const PLAN_PENDING = `${NO_BASELINE_RULE} Otherwise, before the review starts, run ${makeDirs("plan")} and copy the plan file as it stands now to \`<hash>.pending\` in ${PLAN_BASELINE_DIR}, where \`<hash>\` is ${hashCommand("<the plan's absolute path>")} ${SAFE_WRITE}; the review reads the older \`.copy\` for its delta, so leave that in place.`;

/** The end of step 2: the pending copy becomes the baseline only when the review ended clean. */
const PLAN_PROMOTE = `After the review and its fixes are done, promote the baseline only if the review completed and no ${BLOCKER} is still open: move the plan's \`.pending\` copy over its \`.copy\` in ${PLAN_BASELINE_DIR} and update its \`manifest.tsv\` row, so the next cycle reviews only what changed since (this cycle's fixes included). Otherwise delete the \`.pending\` copy, so the next cycle reviews the whole plan. If the review found a secret in the plan, delete the plan's copies.`;

/** Approval ends the plan's baseline, so a reused plan file gets a full review next time. */
export const PLAN_BASELINE_CLEAR = `delete that plan's copy from ${PLAN_BASELINE_DIR} (and its \`manifest.tsv\` row)`;

/**
 * Step 2 of both plan-review prompts: apply the review's findings to the plan
 * document itself, nothing else.
 */
export const APPLY_PLAN_FINDINGS =
  `Apply every valid finding directly to the plan document, whatever its severity; skip a false positive with a one-line reason. Editing the plan document is allowed in plan mode — do not edit any other project file. The review itself is also allowed in plan mode: writing its brief files outside the checkout and spawning, waiting on, stopping, archiving and deleting its bb child threads do not change the project, so try them rather than skipping them; fall back only after a real failure or a denied call. Writing the review baseline directory (${PLAN_BASELINE_DIR}) is allowed too: it is outside the checkout and does not change the project. ${PLAN_PROMOTE}`;

/** What stops a plan from being presented: a decision for the user, or a finding the review could not close. */
export const PLAN_OPEN_IF = `If the review leaves a decision only the user can make (scope, a product trade-off), or a ${BLOCKER} is still open after the review (and its closure rounds, if any),`;

export const PLAN_OPEN_GATE = `${PLAN_OPEN_IF} do not present: end your turn with the plan and those findings for the user.`;

/**
 * A no-commit review leaves HEAD where it was, so unlike the commit path it
 * cannot tell a later pass what an earlier one already read. The baseline is a
 * private per-thread copy of those files, and later passes review only the
 * delta against it. Secret checks are never narrowed by it.
 */
export function codeBaselineParagraph(mode: ReviewMode): string {
  const reference =
    mode === "self"
      ? ""
      : ` (devkit: pass \`baseline ${CODE_BASELINE_DIR}\` in the scope; details: \`${DELTA_SCOPE_REFERENCE}\`)`;
  return `Review baseline: ${CODE_BASELINE_DIR} holds copies of the files earlier reviews of this thread read — one \`<hash>.copy\` per file, where \`<hash>\` is ${hashCommand("<repo-relative path>")}, and a \`manifest.tsv\` of path, content sha256, HEAD sha and HEAD blob rows. ${NO_BASELINE_RULE} Otherwise, before the review starts, run ${makeDirs("code")} and copy each file in scope — listed, or noted as left off the list — as it stands now to \`<hash>.pending\` there ${SAFE_WRITE}; a listed file that no longer exists gets no \`.pending\`, and its old copy is deleted at promotion. The review reads the older \`.copy\` for its delta, so leave that in place until step 2. A file in scope (listed or noted) with a valid copy (its HEAD blob unchanged since the copy was taken; delete a stale copy when you find it) is reviewed only as its delta: ${DELTA_LINES("<copy>", "<file>")}; for a file deleted since the copy, the delta is the removal. Report issues the delta causes or exposes anywhere in the file; treat unchanged parts it does not affect as context only${reference}. A file with no copy, or a stale one, gets the full review, and so does one whose name is outside the safe set (the odd names the scope notes as unlistable): it gets no copy, and its name never goes into these commands or a manifest row. The pre-existing-issue rule in step 1 applies only to files with no copy (their first review). Earlier open findings listed above are re-checked wherever they sit, and secret checks are never narrowed by the baseline. State the scope in your final reply: \`delta vs baseline\` or \`full (no baseline)\`, per file when mixed.`;
}

/** Appended to step 2 of a no-commit review, so step numbers stay put. */
export const CODE_PROMOTE = ` After the review and its fixes are done, promote the baseline only if the review completed and no ${BLOCKER} is open: move each \`.pending\` copy over its \`.copy\` in ${CODE_BASELINE_DIR} and update its \`manifest.tsv\` row, and delete the old copy of a listed file that no longer exists; otherwise delete the \`.pending\` copies. Delete the copies (pending and promoted) of any file in which a secret was found or removed in step 1 or 2.`;

/** Appended to step 5 of a no-commit review: a secret found there ends the file's baseline too. */
export const CODE_SECRET_CLEAR = ` If you find one, also delete the copies (pending and promoted) of the flagged files from ${CODE_BASELINE_DIR}.`;
