# bb-plugin-auto-review

Provider-neutral post-turn code review for bb. When an agent changes files during a turn,
auto-review injects one review-and-commit turn into the same thread: it reviews the
changes, applies fixes, commits only the paths that turn touched, and on a personal
mainline (e.g. `master`) merges the feature branch into it locally. It never pushes.

It also reviews plans: the first presentation of a plan for approval is held back,
reviewed, and revised before the user sees it.

It ships enabled (opt-out).

## How it works

- Fires on `thread.idle` for top-level, git-branch, user coding threads.
- Attributes work to the turn from the thread's own file-change rows plus a working-tree
  snapshot taken at turn start, so shell edits, generators and commits made during the
  turn all count. Files another thread changed, files already dirty and left untouched,
  and harness state under `.claude/`, `.codex/` and `.bb/` are not claimed.
  Commits replayed by a rebase with the same patches as the turn started with do not
  count as new work; changed replayed patches still count.
- Chooses commit and merge from a branch policy keyed on the mainline name. A feature
  branch (name contains a `/`, e.g. `fix/x`, `bb/<slug>`) merges into an eligible mainline;
  a top-level branch such as `develop` is never merged; a non-eligible (protected) mainline such as
  `main` is never a merge target, and the primary checkout is never committed to there.
- Runs one review at a time per provider across all projects, since those reviews share
  the provider's usage limits. A turn ending behind another review is deferred, not
  dropped, and fires when the blocking review ends.
- Never fires alongside a message you queued. If a user message is waiting when the turn
  ends (or its turn has already started), the review is carried into that turn and fires
  once the thread goes idle with nothing of yours queued, covering every turn since.
- Commits only a complete, working change. The review turn gets the full list of files the
  turn authored, checks that nothing the staged change depends on is left out, and runs the
  project's typecheck/build and tests. If the work is unfinished, broken, or could only be
  committed in part, it leaves it uncommitted and reports what is missing. A turn that
  changed more than 400 files is reviewed but left for the user to commit.
- After committing, the review turn checks the thread's plan and continues genuinely
  unfinished planned work. It never invents work.

The full behavior, including the branch policy table and every `status` reason, is in
[`skills/auto-review/SKILL.md`](skills/auto-review/SKILL.md). The skill ships with the
plugin, so agents can read it too.

## Settings

| Setting | Default | Meaning |
|---|---|---|
| Enabled | on | Global kill switch |
| Merge-eligible mainlines | `master` | Comma-separated branch names a feature branch may be merged into locally |
| Review mode | `auto` | `auto` uses devkit's calibrated review when `devkit_load_skill` is available, else self-review; `devkit` requires it; `self` always self-reviews |

Per-project overrides and per-thread skips are stored in the plugin's own storage.

## CLI

All commands accept `--json`.

| Command | What it does |
|---|---|
| `bb auto-review status` | Effective state and last-fire outcome for the current thread |
| `bb auto-review show` | Global defaults, project override and resolved settings for the current project |
| `bb auto-review enable [--global \| --project <id>]` | Turn it on; bare `enable` is global |
| `bb auto-review disable [--global \| --project <id>]` | Turn it off, same scoping |
| `bb auto-review skip <thread-id>` / `unskip <thread-id>` | Skip one thread, or clear that skip |
| `bb auto-review reset <thread-id>` | Clear a wedged loop-guard latch. On a `deferred` thread this cancels the pending review |

## Install

```sh
bb plugin install npm:@lettland/bb-plugin-auto-review
```

Install [devkit](../devkit) alongside it to get the calibrated review in `auto` mode.

## Development

```sh
npm install --include=dev --legacy-peer-deps
npm test
npm run test:coverage
npm run typecheck
bb plugin build
```
