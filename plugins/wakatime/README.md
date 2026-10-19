# bb-plugin-wakatime

Sends [WakaTime](https://wakatime.com) heartbeats for time spent in bb. It runs `wakatime-cli` on the bb server host for two kinds of time:

1. **Your activity in bb:** you interact with a focused bb window. Heartbeats are tagged with the bb project, thread, and branch of the view.
2. **Agent run time:** a thread's status is `active`, whether or not you are watching.

It also runs one debounced `wakatime-cli --sync-ai-activity` after agent turns, so the file-level AI sync no longer depends on an IDE with WakaTime being open.

## Requirements

- `wakatime-cli` installed on the bb server host (default path `~/.wakatime/wakatime-cli`).
- A working `~/.wakatime.cfg` with your API key. The plugin never passes `--key`, never stores the key as a setting, and never logs it.

## What leaves the machine

Everything the plugin sends goes to WakaTime's cloud through `wakatime-cli`:

- the bb project name
- the entity: the thread title (default) or the thread id only (`entity` = `threadId`)
- the branch of the thread's environment
- the category, the time, and the editor string
- whatever `--sync-ai-activity` uploads from AI transcripts. `wakatime-cli` decides which transcript roots it reads and may change them when it updates itself; `syncAiActivity` is the off-switch.

A view with no project (home, settings) sends entity `bb` and no project.

## What is sent

```
wakatime-cli --entity-type=app --entity=<entity> --project=<bb project name>
  --alternate-branch=<branch> --category=<category> --time=<epoch seconds>
  --plugin="bb/unknown bb-wakatime/<plugin version>" --sync-ai-disabled
```

The editor string says `bb/unknown` because the plugin SDK does not expose the host's version. Every value uses the `--flag=value` form, so a title starting with `-` is never read as a flag. `--sync-ai-disabled` is on every heartbeat: the debounced sync is the only path that parses transcripts.

## Settings

| Setting | Default | |
|---|---|---|
| `cliPath` | `~/.wakatime/wakatime-cli` | Absolute path after `~` expansion, to a regular executable file. Anyone who can edit plugin settings can make the plugin run that binary on the server host. |
| `trackUserActivity` | on | Heartbeats while you interact with a focused bb window. |
| `userCategory` | `coding` | |
| `trackAgentActivity` | on | Heartbeats about every 2 minutes while a thread is active. |
| `agentCategory` | `ai coding` | |
| `syncAiActivity` | on | One debounced `--sync-ai-activity` after agent turns. |
| `entity` | `title` | `title` or `threadId`. |
| `excludeProjects` | empty | bb project ids or names. |

Settings are read fresh on every use.

## How it works

- **Your activity:** the plugin's frontend listens for keyboard, pointer, and wheel input while the bb window is focused and visible, and asks the server for a heartbeat when the route changes and otherwise at most every 2 minutes. The server allows one heartbeat per key and category every 120 seconds, and every bb window, tab, or remote client counts as the server owner's activity.
- **Agent time:** `thread.active` sends a heartbeat and starts a 2-minute timer for the thread. Each tick re-reads the thread and sends only if it is still `active`. `thread.idle` and `thread.failed` send a final heartbeat, stop the timer, and request an AI sync. Threads already running when the plugin loads are picked up at startup.
- **AI sync:** the first request runs at once; requests in the following 5 minutes schedule one more run at the end of that window.
- **CLI runner:** no shell; at most 4 `wakatime-cli` processes at once and one in flight per key (a newer heartbeat replaces a waiting one); 150 s timeout for heartbeats and 10 minutes for the sync.

## Excluding projects

A matching project sends no bb heartbeats: no user heartbeats, no agent timers, and its idles never trigger the AI sync. Use ids; they survive renames and names do not. The status panel lists entries that match no project, and the server log warns about each by position (`entry #N`), never by name.

Exclusion covers bb heartbeats only. The host-wide `--sync-ai-activity` can still upload that project's transcripts; turn `syncAiActivity` off to stop that. `wakatime-cli` documents its own path filters (`exclude`, `--exclude-ai`), which this plugin has not tested.

## Counting agent time

Overlapping heartbeats share wall-clock time rather than adding up. Agent heartbeats can therefore relabel time another editor would have recorded as "coding" as "ai coding" on bb thread rows, and they add time only while you are otherwise idle. This is the expected behaviour; it has not been measured with this plugin.

- Turning `trackAgentActivity` off removes the effect entirely.
- A different `agentCategory` only changes the label; the time still moves from the other editor's file and project rows to bb thread rows.

`~/.wakatime/wakatime-internal-ai-parsing.json` is the CLI's own state file; it shows which AI sessions the sync has parsed.

## Failures

The WakaTime status panel in Settings shows the resolved CLI path, the last successful heartbeat, and the last error until a later heartbeat succeeds, so a missing CLI or a bad API key is visible there. The server log carries the exit code and one error kind (`missing-cli`, `auth`, `network`, `timeout`, `other`), at most one line per kind every 10 minutes. It never carries argv, titles, project names, or the CLI's raw output.

Whether `hide_file_names`, `hide_project_names`, and `hide_branch_names` from `~/.wakatime.cfg` apply to `--entity-type=app` heartbeats has not been verified.

## Development

```sh
npm install --include=dev --legacy-peer-deps
npm run typecheck
npm run test:coverage
bb plugin build
```

Tests never spawn a real `wakatime-cli`: the runner takes an injected `exec`, and the test setup makes the real `execFile` throw.

## License

BSD-2-Clause.
