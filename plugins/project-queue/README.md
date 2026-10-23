# bb-plugin-project-queue

Starts a new bb thread only when no other thread in its project is running. Use it when threads cannot safely run side by side in one project: no worktree or branch isolation, provider rate limits, and so on.

- **Start when project is idle** in the new-thread composer's send menu. The thread waits until no other thread in its project is running, then starts. It starts right away if none are.
- `bb project-queue spawn` to queue a thread from a terminal or an agent.
- `bb project-queue list` to see what each queued thread waits on, and `bb project-queue release` to stop holding one.

Queuing is opt-in for each thread and covers its first message only. This is a workflow aid, not a security control: any caller that can create a thread in a project can queue or skip the queue.

## Install

```sh
bb marketplace add git:https://github.com/lettland/bb-plugins.git@master
bb plugin install project-queue@lettland-plugins
```

- Address the plugin as `project-queue@lettland-plugins` in `bb plugin` commands.
- The marketplace install works only after the first release tag exists.
- Until then, install from a local path:

```sh
bb plugin install <local clone of this repo>/plugins/project-queue
```

This plugin replaces the fork's builtin `bb--project-queue`. SDK callers must now pass `pluginId: "project-queue"`.

On a bb build that still bundles the builtin Project queue, switch before you install this plugin. While only the builtin is enabled, run `bb project-queue list` and wait until it is empty, or release one thread with `bb project-queue release <id>` and wait for it to finish before releasing the next. Then run `bb plugin disable bb--project-queue`. Disabling releases every thread the builtin still holds at once, and with both enabled bb has two `project-queue` commands and two "Start when project is idle" menu items.

## Development

```sh
npm install --include=dev --legacy-peer-deps
npm run typecheck
npm run test:coverage
npm run build
```

## License

[MIT](LICENSE).
