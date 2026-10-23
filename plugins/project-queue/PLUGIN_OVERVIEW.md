Start a new thread only when no other thread in its project is running. Use it when threads cannot safely run side by side in one project: no worktree or branch isolation, provider rate limits, and so on.

## What you get

- **Start when project is idle** in the new-thread composer's send menu. The thread waits until no other thread in its project is running, then starts. It starts right away if none are.
- `bb project-queue spawn` to queue a thread from a terminal or an agent.
- `bb project-queue list` to see what each queued thread waits on, and `bb project-queue release` to stop holding one.

## How it works

Queuing is opt-in for each thread and covers its first message only. A thread you do not queue is never held, and follow-up messages in an existing thread are never held. The personal project is never queued.

A queued thread shows a held card that names this plugin and how many other threads are running in the project. Send now on that card starts the thread at once and overrides the hold. `bb project-queue release` only stops this plugin from holding the thread: it still waits for other plugins, such as Concurrency limit, and for core. This is different from a queued message, which is core's wait for a thread that is busy and is managed with `bb thread queue`.

- **Ancestors never block.** A queued child can run beside its own parent and the parent's ancestors. Otherwise a parent waiting on its queued child would deadlock. The link is opt-in on the CLI: pass `--parent-self` or `--parent-thread`. Without a parent link the calling thread does block the child, so do not `bb thread wait` on a queued thread you are not an ancestor of.
- **Order is approximate.** Queued threads start one at a time in roughly the order they were created. A thread that was re-queued less than a second ago is skipped by that pass, so the order can differ slightly. Threads that are not queued can keep a queued thread waiting indefinitely.
- **Rechecks.** The plugin rechecks when a thread goes idle, fails, is archived or is deleted, when the server starts, and at least every 30 seconds while any thread is queued. The reason text refreshes on each recheck.
- **Concurrency limit.** Both plugins hold a dispatch independently. A queued thread starts only when both allow it, and the held card shows the first plugin's reason.
- **Off switch.** Disabling the plugin releases every thread it holds.

This is a workflow aid, not a security control: any caller that can create a thread in a project can queue or skip the queue.

## For agents and scripts

- `bb project-queue spawn --prompt <text> [--project <id>] [--provider <id>] [--model <model>] [--reasoning-level <level>] [--permission-mode <mode>] [--environment <id>] [--title <title>] [--parent-thread <id> | --parent-self] [--json]` spawns a queued thread. `--project` defaults to the calling thread's project.
- `bb project-queue list [--project <id>] [--json]` lists queued threads and their blockers. Missing or no longer pending threads are shown as stale and removed.
- `bb project-queue release <thread-id> [--json]` stops holding a queued thread.

The SDK equivalent is `bb.sdk.threads.spawn({ …, pluginSubmission: { pluginId: "project-queue", data: { queue: true } } })`.
