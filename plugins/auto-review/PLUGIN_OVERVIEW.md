# Auto review

Server-side plugin. When an agent changes files during a turn, auto-review runs a
code review, applies fixes, and commits only the paths that turn touched — and, on a
personal mainline (e.g. `master`), merges the feature branch into it locally, in a
worktree or the primary checkout alike. It replaces provider-specific Stop hooks with
one provider-neutral implementation driven by bb's `thread.idle` event.

## How it works

- Fires on `thread.idle` for top-level, git-branch, user coding threads only.
- At most one code review per user message: after one is sent, only a message you send earns
  another. Wake-ups, tasks other threads tell it and the review's own fix commits stand down as
  `already-reviewed`. Work from wake-ups after the review ends (including review fixes committed
  in one) is carried into the review your next message earns; fixes made inside the review turn
  or its continuation are covered by that review itself. `bb auto-review reset` or a stop by you
  drops the carried cursor.
- Fires only at the end of work: a turn that changed nothing since the last idle that kept the
  carried cursor (a question, a reply to a steer, a CI status check) stands down as
  `no-new-work`. A question after a stop starts a fresh window and stands down as `no-authorship`,
  since a stop drops the carried window (a reply that edits fires normally). The carried work
  waits for the next turn that changes something; nothing reviews it if none comes, and
  `bb auto-review reset` discards it. After a question has stood down, a later wake-up that
  commits fires the review, because your message is still unspent. A turn that ran a command that
  can write files (or anything whose writes can't be read) in a tree of more than 200 uncommitted
  files, or with a file whose content could not be read, reviews, since a same-size edit to such
  a file cannot be seen.
  Carried work that was pushed meanwhile drops out of scope (only dirty or ahead paths are
  reviewed).
- Claims only the thread's own changes (itself plus its bb children and owned threads). In
  exact mode, when everything the family ran was read-only or named every file it wrote, only
  the files it named count and the rest stands down as `unclaimed-changes`; when it ran
  something whose writes cannot be listed (a build, codegen, a script, an unknown command) the
  turn is a sweep, as described next. A sweep keeps every commit that is not a sibling's or
  upstream (pulled from the remote base or from the checkout branch's own remote-tracking
  ref); only exact mode drops one nothing of the family could have made. A thread's shell
  keeps its directory between rows, and a relative path whose directory is a guess claims
  every changed path that ends in it. See the README for the classes and the commit rule.
- Leaves out what changed while a parked turn waited: on release, an uncommitted path or a
  commit that appeared after the turn's latest park snapshot and that the turn had not touched
  before it is not the turn's. It is not reviewed (a commit is still scanned for secrets,
  never rewritten, and it rides along when the turn's work is merged); a file or commit the turn
  already touched stays, and untracked harness output is never counted. When only such changes
  are left the turn stands down as `changed-while-parked`, scanning nothing, and something you
  commit while a turn waits is not reviewed by that turn. Nothing is left out after any family
  activity since the park (checked again after the files are read) or work that may still be
  writing: a shell command mentioning a lone `&`, `nohup`, `setsid`, `disown`, `daemon`, `coproc`,
  `systemd-run`, `systemctl`, `service`, `launchctl`, `crontab`, `pm2`, `batch`, any `tmux` or
  `screen`, `brew services`, `at` followed by a time or an option, or `docker`/`podman`/`nerdctl`/`compose` with `-d`,
  `--detach`, `start`, `restart` or `up`; a background agent or harness background command; an
  unfinished workflow task; any extension (MCP) call or tool not known to be read-only (a tool
  can start a detached process the timeline cannot show). Nor after a HEAD that does not
  descend from the park head, a capped commit list, park-snapshot commit lists that do not reach
  back to the turn-start head, or a failed read; a row opened over 30 minutes before the turn
  started is not seen, and neither is one the host has not yet recorded when the timelines are
  read. A turn parked again takes a new snapshot.
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
  doubt keeps the commit with this thread. A commit that arrived with a pull is not this
  thread's work either: it is reachable from `origin/<mainline>` or from `origin/<the
  checkout's own branch>`, was authored outside every window of this thread's family, and
  touches none of the files that family edited with tools. Nothing is dropped as upstream,
  from either ref, when a family row since the turn start (or since the earliest such
  commit's author date, when that is earlier) may have pushed or moved a remote-tracking
  ref (`push`, `update-ref`, `git remote add` or `rename`, a `fetch` with a refspec, and the
  like), or a tool edited `refs/remotes/`, `packed-refs` or `.git/config`, so a backdated
  commit of its own that it pushed stays with the thread; once the family has pushed,
  pulled older work stays in review too. A push made through a script, an alias or a
  non-shell tool, or a push in an earlier turn of a commit whose author date is later than
  that push, is not detected. A commit someone made by hand in the same checkout and
  pushed to the branch counts as upstream too, as on the mainline. Only `origin/<branch>`
  is checked, not another configured upstream remote. A sibling's
  uncommitted shell edit, or a human's edit, made in the same checkout during the turn
  cannot be told apart and is claimed, and this thread's own shell edits (no tool row)
  swept into a sibling's `git add -A` commit are left to the sibling.
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
  when the blocking review ends, one deferred turn per provider released per review end. A
  question sent while the turn is parked does not fire it: the parked work becomes carried
  work for the next turn that changes something.
  In-flight reviews and parked turns are indexed in plugin storage, and parked turns are
  swept every 5 minutes, so a release whose event was missed still happens.
- Yields to the user: a turn ending with a user message queued (or its turn already
  started) is carried, not reviewed — its cursor is kept, and the review fires at the
  first idle of a turn that changes something with nothing of the user's waiting, covering
  every turn since. A queued question changes nothing, so it leaves the work carried.
  Scheduled, failed, agent and plugin rows do not count.
- Injects one review-and-commit turn into the same thread, guarded by a per-thread
  latch (persisted in plugin metadata) so it never reviews its own review turn. When that
  turn commits, it judges from the thread's plan whether work remains and continues any
  genuinely-unfinished planned work instead of halting mid-plan (never inventing work).
- Later reviews are delta-scoped: plan reviews, and no-commit code reviews (protected
  mainline, over-400-files), review only what changed since the last clean review. The plugin
  keeps those baselines itself (plugin KV, per thread: `baseline:plan:<thread>:<sha256(path)>`,
  `baseline:code:<thread>`), computes each delta with `diff` (jsdiff) and embeds it in the prompt
  as a ```diff block, so the agent runs no shell command for it. Arming a review stages what it
  reads as `pending`; a review that ran and left no open Blocker (plan) or Blocker/security
  Concern (code) promotes it, else it is dropped. A code copy is valid only while HEAD is still
  the sha it was taken at; a finding flagged `security` on a file ends that file's baseline;
  files over 256 KB, more than 200 files, and deltas over 40 KB (plan) / 80 KB (code, total) fall
  back to a full review; records untouched for 7 days are dropped. The reply states
  `delta vs baseline` or `full (no baseline)`; an auto-approval, a redo and a thread deletion
  clear a plan's baseline.
- Reviews plans too, on every provider, through two paths kept strictly separate by
  provider capability so one plan is never reviewed twice. On Claude Code (and its
  `claude-code-<slug>` profile providers), whose ExitPlanMode routes to a real
  `interaction.pending` with `subject.kind: "plan"` the native gate can hold, it fires on that event, holds the first presentation back (queues
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
  to auto-approve and the plan completed the review cycle). Claude Code and its profile
  providers never get `PresentPlan`, and no other provider gets the native gate's instructions, so the two
  paths never compete for the same plan.
- Per project and off by default (the Plan auto-approve section on the settings page, or
  `bb auto-review auto-approve on --project <id>`), a plan is approved automatically once it completed the review cycle (reason `plan-approved`);
  anything the gate cannot show was reviewed still goes to the user. The CLI validates the
  project and refuses `on` from inside a bb thread (an accident guard keyed off the
  thread context, not a security boundary); the agent mentions that the approval may have
  come from auto-review rather than from the user. A turn that ended since the review was
  delivered (a `turn/completed` event) voids the evidence. Within the same turn (no turn end
  and no delivered message since), a plan re-presented byte-identically after the gate left it
  with the user and it was approved is approved once more instead of being held for another
  review round (reason `plan-already-approved`).
- In `devkit` mode, and in `auto` mode while the devkit plugin runs, both plan paths also check
  that the agent itself loaded `review-code` after the review was sent (an anti-shortcut check,
  not proof a review ran; a turn ending does not void it, unlike the auto-approve proof). A plan
  whose review never loaded it is sent back once for a full re-review (reason `plan-review-redo`);
  a second miss is released without an auto-approve (`plan-review-incomplete`), and a check that
  cannot be made releases it without a redo or an auto-approve (`plan-review-unverified`). The
  same requirement (decided at dispatch and latched) covers code reviews: `ReportReview` reads
  the agent's own load from the cursor captured before the send (`lastCodeReviewSeq`), never the
  delivery cursor, and records the review `incomplete` — an incident, and no clean baseline —
  when it was not; `blocked` and the exact stand-down are exempt, and `"unknown"` never records
  `incomplete`.
- The review turn ends by calling the `ReportReview` agent tool (offered to every top-level,
  non-plugin thread on every provider, whatever the global switch says; inert outside a review)
  with an outcome (`committed`, `merged`, `uncommitted`, `blocked`, `no-changes`), a summary,
  structured findings and the parts of the review the agent skipped (`skipped`). Findings
  persist per thread as chains with stable keys (plugin KV, `findings:<thread id>`): the
  next review is told what is still open, a repeat is marked re-raised (severity keeps its
  maximum), and dismissing a finding as a false positive a second time needs a new reason. The
  last report of a review replaces earlier ones. Outcomes are agent-reported, not verified
  against git; a review that ran but never reported is recorded as `not-reported`, one the user
  stopped or cancelled as `stopped`, one that could not be sent as `unavailable`, and one that
  did not run as asked (its `skipped` steps, or the `review-code` check finding no load) as
  `incomplete` — none of these ever reads as a pass, and a passing re-report for the same
  review replaces an `incomplete` record and clears its incident. A session started before
  the plugin update does not have the tool until restarted, so its reviews show "Review not
  reported". Recording an outcome is best-effort and never blocks the latch reset; the orphan
  sweep deletes a thread's findings only on a deleted thread or a structured
  `thread_not_found` / 404.
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
  reports `planGate`: whether this thread is a top-level, enabled claude-code-family
  (`claude-code` or `claude-code-<slug>`) thread, so its plan review is owned here, by the native gate, rather than by another gate
  (e.g. agent-hooks). It does not reflect `PresentPlan`, which has no equivalent gate to hand
  off from on its own providers.

See `skills/auto-review/SKILL.md` for details.
