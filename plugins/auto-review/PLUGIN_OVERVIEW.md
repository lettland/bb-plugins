# Auto review

Server-side plugin. When an agent changes files during a turn, auto-review runs a
code review, applies fixes, and commits only the paths that turn touched — and, on a
personal mainline (e.g. `master`), merges the feature branch into it locally, in a
worktree or the primary checkout alike. It replaces provider-specific Stop hooks with
one provider-neutral implementation driven by bb's `thread.idle` event.

## How it works

- Fires on `thread.idle` for top-level, git-branch, user coding threads only.
- Claims only the thread's own changes (itself plus its bb children and owned threads). In
  exact mode, when everything the family ran was read-only or named every file it wrote, only
  the files it named count and the rest stands down as `unclaimed-changes`; when it ran
  something whose writes cannot be listed (a build, codegen, a script, an unknown command) the
  turn is a sweep, as described next. See the README for the classes and the commit rule.
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
  output, not the turn's work. A commit a sibling thread made with git from its shell
  during the turn (`commit`, `merge`, `revert` or `pull`) is left to that thread, and its
  own auto-review covers it: the commit's time must fall in that command's run, nothing of
  this thread's family (itself, its bb children and owned threads) may have been running
  then, and the commit may touch none of the files that family edited with tools; any
  doubt keeps the commit with this thread. A sibling's uncommitted shell edit, or a
  human's edit, made in the same checkout during the turn cannot be told apart and is
  claimed, and this thread's own shell edits (no tool row) swept into a sibling's
  `git add -A` commit are left to the sibling.
- Chooses commit / merge from a branch policy keyed on the mainline name: a feature
  branch (name contains a `/`; a top-level branch such as `develop` is never merged)
  merges into a personal mainline (e.g. `master`) whether the thread runs in a
  dedicated worktree or the primary checkout; a non-personal mainline (e.g. `main`) is
  never a merge target.
- Holds the turn while any child the thread spawned (`bb thread spawn --parent-self`), in
  any turn, directly or transitively, is still running: bb wakes the parent with a new turn
  each time one ends, but a wake-up with another child still running just re-parks. Only
  the turn after the last one ends reviews its work, instead of a tree snapshot a running
  child is about to overwrite. Released only by its own wake-up idle or the 5-minute sweep,
  never by an unrelated same-provider release.
- Runs one review at a time per provider, across all projects, since reviews on one
  provider share its usage limits: a turn ending while another thread on the same provider
  has its review queued or running is deferred, not dropped — never because another thread
  is merely active (other than a spawned child, above), never behind a different provider,
  never behind the thread itself. The turn-start cursor is kept and the full review fires
  when the blocking review ends, one deferred turn per provider released per review end.
  In-flight reviews and parked turns are indexed in plugin storage, and parked turns are
  swept every 5 minutes, so a release whose event was missed still happens.
- Yields to the user: a turn ending with a user message queued (or its turn already
  started) is carried, not reviewed — its cursor is kept, and the review fires at the
  first idle with nothing of the user's waiting, covering every turn since. Scheduled,
  failed, agent and plugin rows do not count.
- Injects one review-and-commit turn into the same thread, guarded by a per-thread
  latch (persisted in plugin metadata) so it never reviews its own review turn. When that
  turn commits, it judges from the thread's plan whether work remains and continues any
  genuinely-unfinished planned work instead of halting mid-plan (never inventing work).
- Later reviews are delta-scoped: plan reviews, and no-commit code reviews (protected
  mainline, over-400-files), snapshot what they read under `$BB_THREAD_STORAGE/auto-review/`
  and review only what changed since (prompt text only; devkit's `review-delta-scope`). The reply
  states `delta vs baseline` or `full (no baseline)`; approval clears a plan's copy.
- Reviews plans too, on every provider, through two paths kept strictly separate by
  provider capability so one plan is never reviewed twice. On Claude Code, whose
  ExitPlanMode routes to a real `interaction.pending` with `subject.kind: "plan"` the
  native gate can hold, it fires on that event, holds the first presentation back (queues
  a review-plan turn, then denies the approval), and releases the revised plan on its
  re-presentation. If the agent reacts to the bare deny by asking the user what to
  change, auto-review auto-answers that one question itself (reason
  `plan-hold-answered`) so the user is never asked to explain a rejection they never made.
  Every other provider's plan approvals never reach that gate, so instead those threads
  get the `PresentPlan` agent tool via `bb.agents.configure`: the agent writes its plan to
  a file and calls `PresentPlan(planFilePath)`; the first call arms a review and returns
  the review instructions, and the second call (after the agent applies the findings)
  releases it — the agent then ends its turn and waits for the user's own, explicit
  approval, since a tool result is never the user's approval (except when a project opts in
  to auto-approve and the plan completed the review cycle). Claude Code never gets
  `PresentPlan`, and no other provider gets the native gate's instructions, so the two
  paths never compete for the same plan.
- Per project and off by default (the Plan auto-approve section on the settings page, or
  `bb auto-review auto-approve on --project <id>`), a plan is approved automatically once it completed the review cycle (reason `plan-approved`);
  anything the gate cannot show was reviewed still goes to the user. The CLI validates the
  project and refuses `on` from inside a bb thread (an accident guard keyed off the
  thread context, not a security boundary); the agent mentions that the approval may have
  come from auto-review rather than from the user. A turn that ended since the review was
  delivered (a `turn/completed` event) voids the evidence.
- In `devkit` mode, and in `auto` mode while the devkit plugin runs, both plan paths also check
  that the agent itself loaded `review-code` after the review was sent (an anti-shortcut check,
  not proof a review ran; a turn ending does not void it, unlike the auto-approve proof). A plan
  whose review never loaded it is sent back once for a full re-review (reason `plan-review-redo`);
  a second miss is released without an auto-approve (`plan-review-incomplete`), and a check that
  cannot be made releases it without a redo or an auto-approve (`plan-review-unverified`).
- The review turn ends by calling the `ReportReview` agent tool (offered to every top-level,
  non-plugin thread on every provider, whatever the global switch says; inert outside a review)
  with an outcome (`committed`, `merged`, `uncommitted`, `blocked`, `no-changes`), a summary and
  structured findings. Findings persist per thread as chains with stable keys (plugin KV,
  `findings:<thread id>`): the next review is told what is still open, a repeat is marked
  re-raised (severity keeps its maximum), and dismissing a finding as a false positive a second
  time needs a new reason. The last report of a review replaces earlier ones. Outcomes are
  agent-reported, not verified against git; a review that ran but never reported is recorded as
  `not-reported`, one the user stopped or cancelled as `stopped`, one that could not be sent as
  `unavailable` — none of these ever reads as a pass. A session started before the plugin
  update does not have the tool until restarted, so its reviews show "Review not reported".
  Recording an outcome is best-effort and never blocks the latch reset; the orphan sweep deletes
  a thread's findings only on a deleted thread or a structured `thread_not_found` / 404.
- Ships enabled (opt-out). Turn it off globally or per project with `bb auto-review`;
  there is no per-thread skip.

## Surfaces

- Settings: global `enabled`, default `mergeEligibleMainlines`, default `reviewMode`, plus a
  Plan auto-approve section listing each project with its own switch (Tools → Auto review).
- Per-project overrides live in the plugin's own storage.
- CLI: `bb auto-review status|show|enable|disable|auto-approve|findings|reset` (all `--json`). `status`
  adds the last review's outcome and open-finding counts, including how many the next prompt
  cannot list (`reviewResult`, `omittedFromPrompt`); `findings [thread-id]
  [--clear]` lists a thread's finding chains and incidents (`--clear` is terminal-only and needs
  an explicit thread id). The `threadReview` RPC and the realtime channel `auto-review:thread:<id>`
  serve the same state to the UI. `status`
  reports `planGate`: whether this thread is a top-level, enabled `claude-code`
  thread, so its plan review is owned here, by the native gate, rather than by another gate
  (e.g. agent-hooks). It does not reflect `PresentPlan`, which has no equivalent gate to hand
  off from on its own providers.

See `skills/auto-review/SKILL.md` for details.
