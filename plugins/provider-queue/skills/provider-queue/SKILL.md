---
name: provider-queue
description: "Queue a BB thread so it starts only when its provider has a free slot."
---

# Provider queue

Use it when a new thread must not run beside too many other threads on the
same provider. It applies to a thread's first message only; it never holds
follow-ups in an existing thread. Default limit 2 per provider.

```sh
bb provider-queue spawn --prompt <text> [--project <id>] [--provider <id>] [--model <model>] [--reasoning-level <level>] [--permission-mode <mode>] [--environment <id>] [--title <title>] [--parent-thread <id> | --parent-self] [--json]
bb provider-queue add <thread-id> [--json]
bb provider-queue list [--provider <id>] [--json]
bb provider-queue move <thread-id> <up|down|top|bottom> [--json]
bb provider-queue release <thread-id> [--json]
bb provider-queue limit [provider] [limit] [--json]
```

`spawn` takes a small subset of `bb thread spawn` flags. `--project` defaults
to the calling thread's project; pass it when there is none. For a long or
multi-line prompt, pass `--prompt "$(cat brief.md)"`; there is no
`--prompt-file`.

## Rules

- **Never wait on a queued thread you are not an ancestor of.** A parent and
  its ancestors never block their queued child, so `--parent-self` or
  `--parent-thread` lets the child run beside you. Without a parent link the
  calling thread counts toward the child's provider limit, and `bb thread
  wait` on it deadlocks.
- Send now on the held card overrides the hold. `release` only stops this
  plugin from holding the thread; it still respects other plugins such as
  concurrency-limit.
- A thread waiting on the user does not count toward the limit, so answering
  an approval can leave the provider over the limit until a thread finishes.
- `limit` with no arguments prints every configured limit and the default;
  `limit <provider> <n>` sets it — `<n>` must be a whole number of 0 or more
  (an empty value is rejected) and `<provider>` must be one bb knows — and
  `limit <provider> 0` pauses the provider. Free slots go to queued rows in
  queue order; `move` reorders a row within its own provider: up/down swap
  with the neighboring row of that provider, top/bottom move to its first or
  last row.
- Disabling the plugin releases every held thread. It is a workflow aid, not
  a security control.
- From the SDK, pass `pluginSubmission: { pluginId: "provider-queue", data: {
  queue: true } }` to `bb.sdk.threads.spawn`.

Run `bb provider-queue list` to see what each thread waits on. A thread that
"starts on the next recheck" starts within 30 seconds.
