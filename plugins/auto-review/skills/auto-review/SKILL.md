---
name: auto-review
description: Control bb's automatic post-turn review, commit, and local merge — enable/disable globally or per project, skip a thread, and read why it did or did not fire.
---

# Auto review

Auto-review reviews, commits, and — on a personal mainline (e.g. `master`) — locally merges
the feature branch's changes an agent made during a turn, in a worktree or the primary
checkout alike. It fires on turn end for top-level, git-branch, user coding threads, and
attributes work only to that thread's own edits.

It commits only a complete, working change. The review turn is given the full list of
files the turn authored, checks that everything the change depends on is staged with it
(or already in this turn's own commits), and runs the project's typecheck/build and tests.
If the work is unfinished, the checks fail, or the change could only be committed in part,
it does not commit: the changes stay uncommitted and the reply says what is missing. A turn
that changed more than 400 files is reviewed but never auto-committed or merged, because
that list is too long to hand over as a reliable commit boundary.

When it commits, the injected turn then judges — from the thread's own plan — whether the
work is actually finished, and continues any genuinely-remaining planned work (reviewing and
committing each further step) rather than halting mid-plan. It never invents work: if the
plan is complete or unclear, it stops and reports done. In the protected-mainline no-commit
case it does not auto-continue.

It ships **enabled** (opt-out).

## Plan review

A plan gets reviewed before the user sees it. When an agent presents a plan for approval
(Claude Code's ExitPlanMode, Codex's plan action), auto-review holds back the **first**
presentation. It queues a review turn and then denies that approval, so the
agent gets the reason along with the deny rather than reading it as a rejection. The agent
reviews the plan file (devkit's calibrated review in `plan` scope, or a self-review, per the
review mode), applies every valid finding to the plan, and presents it again. The review turn
carries the thread's permission mode and can take the agent out of plan mode, where Claude
Code's ExitPlanMode would approve itself, so the agent re-enters plan mode (EnterPlanMode)
before presenting and then stops until the user approves. That second
presentation goes straight to the user and resets the gate for the thread's next plan. A
re-presentation that arrives before the review turn has been delivered is denied again,
so the user never gets an unreviewed plan — but only while that review is actually still in
the queue. If it has already left the queue (its dispatch event was missed), the
re-presentation is the reviewed plan and goes to the user. If it is still queued after 30
minutes, auto-review withdraws it and releases the plan (reason `plan-hold-expired`), so a
stuck review can never turn into a permanent deny. Once
the plan is approved and implemented, the normal post-turn code review runs on turn end.

A plan carrying the `<!-- devkit:commit-plan -->` sentinel on a line of its own (devkit's
commit workflow) is bookkeeping, not code, and passes through unreviewed. `skip` and
`disable` turn plan review off along with code review; `reset` also clears a gate left
armed by a review that never re-presented its plan.

## CLI

All commands accept `--json`.

- `bb auto-review status` — effective state and last-fire outcome for the current thread
  (enabled, skipped, reviewMode, loop-guard phase, last-fire reason and time).
- `bb auto-review show` — full effective settings for the current project (global
  defaults, project override, resolved values).
- `bb auto-review enable [--global | --project <id>]` — turn it on. **Bare `enable`
  defaults to `--global`** (the kill switch). `--project <id>` (or `--project` inside a
  thread) sets a per-project override.
- `bb auto-review disable [--global | --project <id>]` — turn it off, same scoping rules.
- `bb auto-review skip <thread-id>` — skip auto-review for one thread.
- `bb auto-review unskip <thread-id>` — clear that thread's skip.
- `bb auto-review reset <thread-id>` — clear a wedged loop-guard latch (and skip) for a
  thread whose review never completed. Use this if `status` shows a non-`idle` phase that
  never clears. **On a `deferred` thread this is not an unstick — it cancels.** That phase
  is a normal wait that resolves on its own (see *One review per provider*); resetting it throws
  away that turn's pending review and commit.

## Settings

- **Enabled** — global kill switch (default on).
- **Merge-eligible mainlines** — comma-separated branch names treated as personal
  mainlines a feature branch may be merged into locally, in a worktree or the primary
  checkout (default `master`).
- **Review mode** — `auto` (devkit's calibrated review via `devkit_load_skill` when that
  tool is available, else self-review), `devkit` (require devkit's review), or `self`
  (always self-review). Applies to both plan and code review.

Every code review also runs `bb aislop scan` while the aislop plugin is installed and
running; with it missing or disabled, the review prompt leaves the step out. Its findings are advice: only real problems in the turn's own changed lines
are fixed; false positives and findings that go against the project's own rules are
left alone and listed with a one-line reason.

Per-project overrides and per-thread skip are stored by the plugin, not in settings.

## Branch policy

| Where the thread runs | eligible mainline (e.g. `master`) | non-eligible mainline (e.g. `main`) |
|---|---|---|
| Worktree, feature branch | review + fixes + commit + local merge | review + fixes + commit |
| Worktree, on the mainline | review + fixes + commit | review + fixes + commit |
| Primary checkout, feature branch | review + fixes + commit + local merge | review + fixes, no commit |
| Primary checkout, on the mainline | review + fixes + commit | review + fixes, no commit |
| Either, on a top-level branch (e.g. `develop`) | review + fixes + commit, no merge | worktree: review + fixes + commit; primary: review + fixes, no commit |

A feature branch is one whose name contains a `/` (`fix/oh-1/x`, `OH-2/y`, bb's own `bb/<slug>` worktree branches). A top-level branch — no `/`, such as `develop`, `dev`, `sandbox` — is never merged into the mainline, in a worktree or not. A feature branch merges into an eligible mainline (e.g. `master`) whether it runs in a dedicated worktree or the primary checkout. When the root mainline is non-eligible (protected, e.g. `main`), auto-review never commits in the primary checkout — on any branch checked out there — so protected-mainline work stays in a dedicated worktree. Merge is local only — auto-review never pushes.

## One review per provider

Other threads running — in the same checkout or anywhere else, including this thread's own
advisor and subagents — never hold a review back, and never change what it does. Each review
stages, commits and merges only the files its own turn authored (explicit pathspec), skips
any file carrying edits it did not make, and the merge step itself refuses to run while the
tree holds changes this turn did not make.

What auto-review limits is how many reviews run at once **per provider**, because reviews on
one provider share that provider's usage limits: a Claude Code review here and a Claude Code
review in another project compete, a Claude Code review and a Codex review do not. When a
turn ends while another thread on the same provider — in any project — has its auto-review
queued or running, auto-review **defers** that turn rather than skipping it: the turn-start
cursor is kept, and the review fires — in full — as soon as the blocking review ends. If the
thread takes another turn while deferred, the earlier cursor is carried forward, so one
review covers both turns. A thread is never deferred behind itself.

Deferred turns are released one at a time per provider: when a review ends (its thread goes
idle, fails, is archived or deleted, or its queued review is cancelled), one parked turn on
that provider starts its review, and that review's end releases the next. If that event is
missed, a background sweep every 5 minutes retries any parked turn whose provider no longer
has a review in flight. A review latch older than 30 minutes on a thread that is no longer
running counts as a lost idle, not a review, so it never blocks.

`bb auto-review status` shows a parked turn as phase `deferred`, with how long it has waited
and what will release it. `bb auto-review reset <thread-id>` drops the turn instead — its
review and commit then never run.

## `reason` values in `status`

- `fired` — a review was injected.
- `sibling-active` — another thread on the same provider (in any project) has its
  auto-review running. Paired with outcome `deferred`, this turn is parked and will be
  reviewed as soon as that review ends. Not a skip — nothing is lost.
- `no-authorship` — the turn changed no files: no tool edit, and nothing in the working
  tree (a new, rewritten or deleted path, or one in a commit the turn made — on a branch or
  straight onto the mainline) changed since the turn started. Edits made through shell commands count. Untracked
  files appearing under `.claude/`, `.codex/` or `.bb/` do not (harness backups and logs).
  A rebase that replays existing commits with unchanged patches does not count as
  new work; a changed replayed patch does.
  A turn without a turn-start tree snapshot (e.g. one that started before the plugin was
  updated) is judged by tool edits alone.
- `empty-scope` — the files it changed are no longer uncommitted, ahead, or in a commit the
  turn made (e.g. reverted).
- `no-turn-start` — no turn-start cursor was recorded (a missed start event); stood down, fail-safe.
- `user-stopped` — the user stopped the thread during the turn; stood down, so a manual stop
  never triggers a review, commit or merge. A turn of this thread that was parked
  (`deferred`) is dropped as well. A stop bb made on its own (daemon restart,
  provider-turn watchdog) does not count.
- `user-queued` — the turn ended with a message of the user's already queued (or its turn
  already started). Paired with outcome `deferred`: no review fires next to their message;
  the turn-start cursor is carried into that next turn, and the review fires at the first
  idle with nothing of the user's queued, covering every turn since. A scheduled or failed
  row, or one an agent or plugin queued, does not count.
- `disabled` — disabled globally or for this project.
- `skipped` — this thread has a skip flag set.
Outcomes are `fired`, `deferred` (parked, will still run) and `stood-down` (will not run).
- `send-failed` — injecting the review turn failed; the latch was cleared.
- `not-a-branch` — the checkout is not on a git branch (detached/unborn/unknown).
- `status-unavailable` — the environment's git status could not be read.

(A thread that is not a top-level user coding thread is filtered out before evaluation and
records no last-fire entry.)

## Undoing an auto-review commit or merge

Auto-review only ever commits and merges **locally** (it never pushes). To undo:

- Undo the last commit but keep the changes staged: `git reset --soft HEAD~1`.
- Undo a local merge that produced a merge commit and was not yet integrated:
  `git reset --hard ORIG_HEAD` (this discards the merge; make sure ORIG_HEAD is the
  pre-merge state you want).
- Inspect what it did first: `bb auto-review status` reports the last-fire decision and
  the paths it scoped; `git log` and `git show HEAD` show the commit itself.
