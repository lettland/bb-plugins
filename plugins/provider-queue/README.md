# bb-plugin-provider-queue

Starts a queued bb thread only when its provider has a free slot: at most N
threads (2 by default) run per provider id at once. Use it to cap how many
threads hit one provider — provider rate limits, parallel-session caps, and so
on.

- `bb provider-queue spawn` to queue a new thread from a terminal or an agent.
- `bb provider-queue add <thread-id>` to queue a thread that already exists.
- `bb provider-queue list` to see what each queued thread waits on, `bb
  provider-queue move` to reorder, `bb provider-queue release` to stop holding
  one, and `bb provider-queue limit` to show or set per-provider limits.

Queuing is opt-in for each thread and covers its first message only. Threads
that were never queued start immediately and are never held, but they do count
toward the limit. This is a workflow aid, not a security control: any caller
that can create a thread in a project can queue or skip the queue.

## Install

```sh
bb marketplace add git:https://github.com/lettland/bb-plugins.git@master
bb plugin install provider-queue@lettland-plugins
```

- Address the plugin as `provider-queue@lettland-plugins` in `bb plugin`
  commands.
- The marketplace install works only after the first release tag exists.
- Until then, install from a local path:

```sh
bb plugin install <local clone of this repo>/plugins/provider-queue
```

## Development

```sh
npm install --include=dev --legacy-peer-deps
npm run typecheck
npm run test:coverage
npm run build
```

## License

[MIT](LICENSE).
