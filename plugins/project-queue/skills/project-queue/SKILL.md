---
name: project-queue
description: "Queue a new BB thread so it starts only when no other thread in its project is running."
---

# Project queue

Use it when a new thread must not run beside other threads in the same project.
It applies to a thread's first message only; it never holds follow-ups in an
existing thread, and it never queues the personal project.

```sh
bb project-queue spawn --prompt <text> [--project <id>] [--provider <id>] [--model <model>] [--reasoning-level <level>] [--permission-mode <mode>] [--environment <id>] [--title <title>] [--parent-thread <id> | --parent-self] [--json]
bb project-queue list [--project <id>] [--json]
bb project-queue release <thread-id> [--json]
```

`spawn` takes a small subset of `bb thread spawn` flags. `--project` defaults to
the calling thread's project; pass it when there is none. For a long or
multi-line prompt, pass `--prompt "$(cat brief.md)"`; there is no
`--prompt-file`.

## Rules

- **Never wait on a queued thread you are not an ancestor of.** A parent and its
  ancestors never block their queued child, so `--parent-self` or
  `--parent-thread` lets the child run beside you. Without a parent link the
  calling thread blocks the child, and `bb thread wait` on it deadlocks.
- Send now on the held card overrides the hold. `release` only stops this
  plugin from holding the thread; it still respects other plugins such as
  concurrency-limit.
- This is not core's queued message (`bb thread queue`), which is a wait for a
  busy thread.
- Order is approximately first in, first out. Threads that are not queued can
  keep a queued thread waiting indefinitely. The held card's reason refreshes at
  least every 30 seconds.
- Disabling the plugin releases every held thread. It is a workflow aid, not a
  security control.
- From the SDK, pass `pluginSubmission: { pluginId: "project-queue", data: { queue: true } }`
  to `bb.sdk.threads.spawn`.

The id `bb--project-queue` from the former bb builtin is no longer read: a
submission that passes it starts without queuing, and threads the builtin holds
are not carried over. To switch from the builtin, follow the plugin README.

Run `bb project-queue list --json` to see what blocks each thread. A thread with
no blockers starts on the next recheck, within 30 seconds.
