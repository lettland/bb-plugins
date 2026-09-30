# Auto review

Server-side plugin. When an agent changes files during a turn, auto-review runs a
code review, applies fixes, and commits only the paths that turn touched — and, on a
personal mainline (e.g. `master`), merges the feature branch into it locally, in a
worktree or the primary checkout alike. It replaces provider-specific Stop hooks with
one provider-neutral implementation driven by bb's `thread.idle` event.

## How it works

- Fires on `thread.idle` for top-level, git-branch, user coding threads only.
- Attributes work to the turn however it was made: the thread's own `file-change` rows
  after the turn's start cursor, plus whatever the working tree shows changed since the
  turn started (a fingerprint per uncommitted path and the commits ahead of the base,
  snapshotted on `thread.active`) — so shell redirects, `sed -i`, scripts and generators
  count too, as do commits the turn made — on a branch ahead of its base, or straight onto
  the mainline (read back from the turn-start head); the review then covers the committed
  range and records its fixes as new commits. A path another thread in the same
  checkout changed through its own tools during the turn is left to that thread; files
  already dirty and left untouched are never claimed; untracked files appearing under
  harness state dirs (`.claude/`, `.codex/`, `.bb/` — edit backups, logs) are harness
  output, not the turn's work. A sibling's shell edit, or a human's edit, made in the same
  checkout during the turn cannot be told apart and is claimed.
- Chooses commit / merge from a branch policy keyed on the mainline name: a feature
  branch (name contains a `/`; a top-level branch such as `develop` is never merged)
  merges into a personal mainline (e.g. `master`) whether the thread runs in a
  dedicated worktree or the primary checkout; a non-personal mainline (e.g. `main`) is
  never a merge target.
- Runs one review at a time per provider, across all projects, since reviews on one
  provider share its usage limits: a turn ending while another thread on the same provider
  has its review queued or running is deferred, not dropped — never because other threads
  are merely active, never behind a different provider, never behind the thread itself.
  The turn-start cursor is kept and the full review fires when the blocking review ends,
  one deferred turn per provider released per review end. In-flight reviews and parked
  turns are indexed in plugin storage, and parked turns are swept every 5 minutes, so a
  release whose event was missed still happens.
- Yields to the user: a turn ending with a user message queued (or its turn already
  started) is carried, not reviewed — its cursor is kept, and the review fires at the
  first idle with nothing of the user's waiting, covering every turn since. Scheduled,
  failed, agent and plugin rows do not count.
- Injects one review-and-commit turn into the same thread, guarded by a per-thread
  latch (persisted in plugin metadata) so it never reviews its own review turn. When that
  turn commits, it judges from the thread's plan whether work remains and continues any
  genuinely-unfinished planned work instead of halting mid-plan (never inventing work).
- Reviews plans too: fires on `interaction.pending` for a plan approval, holds the
  first presentation back (queues a review-plan turn, then denies the approval), and
  releases the revised plan to the user on its re-presentation. Via
  `bb.agents.configure` instructions it tells agents in top-level, user-started threads
  to present a plan before substantial work even outside plan mode, since the gate only
  sees a presented plan.
- Ships enabled (opt-out). Turn it off globally or per project, or skip a single
  thread, with `bb auto-review`.

## Surfaces

- Settings: global `enabled`, default `mergeEligibleMainlines`, default `reviewMode`.
- Per-project overrides and per-thread skip live in the plugin's own storage.
- CLI: `bb auto-review status|show|enable|disable|skip|unskip|reset` (all `--json`).

See `skills/auto-review/SKILL.md` for details.
