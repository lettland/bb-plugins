Queue threads so that at most N run per provider id. A thread joins the queue
only by explicit intent; a queued thread starts when its provider has a free
slot. Default limit 2 per provider, settable per provider; a limit of 0 holds
every queued thread on that provider.

## What you get

- `bb provider-queue spawn` to queue a new thread from a terminal or an agent.
- `bb provider-queue add <thread-id>` to queue a thread that already exists.
- `bb provider-queue list` to see what each queued thread waits on, `move` to
  reorder, `release` to stop holding one, and `limit` to show or set
  per-provider limits.

## How it works

Queuing is opt-in for each thread and covers its first message only. A thread
you do not queue is never held, and follow-up messages in an existing thread
are never held.

A queued thread shows a held card that names this plugin and how many threads
are running on its provider. Send now on that card starts the thread at once
and overrides the hold. `bb provider-queue release` only stops this plugin from
holding the thread: it still waits for other plugins, such as Concurrency
limit, and for core.

- **Opt-in queuing.** Only intent-flagged threads are held. Everything else
  starts immediately, is never held, and never waits — but it does count
  toward the provider's limit while it runs.
- **Approval windows.** A thread that runs but waits for the user (a pending
  interaction) does not hold a slot BY DESIGN, so answering an approval can
  leave the provider over the limit until a thread finishes — this is not a
  bug.
- **Ancestors never block.** A queued child can run beside its own parent and
  the parent's ancestors, so a parent waiting on its queued child cannot
  deadlock. The link is opt-in on the CLI: pass `--parent-self` or
  `--parent-thread`.
- **Order is exact within a provider.** Free slots go to queued rows in queue
  order: a row starts only when `free slots > its position among the rows
  queued for that provider`. `move` reorders a row (up/down swap with the
  neighbor, top/bottom move to the ends).
- **Rechecks.** The plugin rechecks when a thread starts, goes idle, fails, is
  archived or deleted, when an interaction turns pending, and at least every
  30 seconds while any thread is queued.
- **Provider switches.** A thread's provider can change between turns. The
  plugin refreshes its cache from thread events, and the dispatch decision
  itself always reads the dispatch's own requested execution, so a switch
  cannot wedge the queue.
- **Concurrency limit interplay.** Both plugins hold a dispatch
  independently. A queued thread starts only when both allow it, and the held
  card shows the first plugin's reason.
- **Fail-open caveat.** The plugin is a workflow aid, not a security control;
  on internal errors it lets threads start, and an interactions.list error can
  start a queued thread early.
- **Off switch.** Disabling the plugin releases every thread it holds.

## For agents and scripts

- `bb provider-queue spawn --prompt <text> [--project <id>] [--provider <id>]
  [--model <model>] [--reasoning-level <level>] [--permission-mode <mode>]
  [--environment <id>] [--title <title>] [--parent-thread <id> |
  --parent-self] [--json]` spawns a queued thread. `--project` defaults to the
  calling thread's project.
- `bb provider-queue add <thread-id> [--json]` queues an existing pending
  thread on its current provider.
- `bb provider-queue list [--provider <id>] [--json]` lists queued threads and
  what each waits on. Missing or no longer pending threads are shown as stale
  and removed.
- `bb provider-queue move <thread-id> <up|down|top|bottom> [--json]` moves a
  queued row.
- `bb provider-queue release <thread-id> [--json]` stops holding a queued
  thread.
- `bb provider-queue limit [provider] [limit] [--json]` shows or sets
  per-provider limits; 0 pauses a provider.

The SDK equivalent is `bb.sdk.threads.spawn({ …, pluginSubmission: {
pluginId: "provider-queue", data: { queue: true } } })`.
