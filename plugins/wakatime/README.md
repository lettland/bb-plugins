# bb-plugin-wakatime

Sends [WakaTime](https://wakatime.com) heartbeats for time spent in bb. It runs `wakatime-cli` on the bb server host for two kinds of time:

1. **Your activity in bb:** you interact with a focused bb window. Heartbeats are tagged with the bb project, thread, and branch of the view.
2. **Agent run time:** a thread's status is `active`, whether or not you are watching.

It also runs one debounced `wakatime-cli --sync-ai-activity` after agent turns, so the file-level AI sync no longer depends on an IDE with WakaTime being open.

## Requirements

- `wakatime-cli` installed on the bb server host (default path `~/.wakatime/wakatime-cli`). Tested with `wakatime-cli` v2.27.5: the plugin relies on its `--sync-ai-disabled` and `--sync-ai-activity` flags and on its category list.
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
  --plugin="bb/<bb version> bb-wakatime/<plugin version>" --sync-ai-disabled
```

The bb version is read once in the background after the plugin loads; heartbeats say `bb/unknown` until it answers, or for good if it fails. `--plugin` goes in the request's User-Agent header, not in the heartbeat. Every value uses the `--flag=value` form, so a title starting with `-` is never read as a flag. `--sync-ai-disabled` is on every heartbeat: the debounced sync is the only path that parses transcripts.

## Settings

| Setting | Default | |
|---|---|---|
| `cliPath` | `~/.wakatime/wakatime-cli` | Absolute path after `~` expansion, to a regular executable file. Anyone who can edit plugin settings can make the plugin run that binary on the server host. |
| `trackUserActivity` | on | Heartbeats while you interact with a focused bb window. |
| `userCategory` | `coding` | One of the categories below. |
| `trackAgentActivity` | on | Heartbeats about every 2 minutes while a thread is active. |
| `agentCategory` | `building` | One of the categories below. |
| `syncAiActivity` | on | One debounced `--sync-ai-activity` after agent turns. |
| `entity` | `title` | `title` or `threadId`. This changes the entity only; the project and branch are still sent. |
| `excludeProjects` | empty | bb project ids or names. Find project ids with `bb project list`. |

Settings are read fresh on every use.

`ai coding` is not offered for either category: `wakatime-cli` v2.27.5 silently drops every externally submitted heartbeat with that category (it logs "skipping ai coding heartbeat" and exits 0), so the heartbeat would never reach WakaTime. The choices are the CLI's other categories: `coding`, `building`, `indexing`, `debugging`, `learning`, `notes`, `meeting`, `planning`, `researching`, `communicating`, `supporting`, `advising`, `running tests`, `writing tests`, `manual testing`, `writing docs`, `code reviewing`, `browsing`, `translating`, `designing`.

## How it works

- **Your activity:** the plugin's frontend listens for keyboard, pointer, and wheel input while the bb window is focused and visible, and asks the server for a heartbeat when the route changes and otherwise at most every 2 minutes. The server allows one heartbeat per key and category every 120 seconds, and every bb window, tab, or remote client counts as the server owner's activity.
- **Agent time:** `thread.active` sends a heartbeat and starts a 2-minute timer for the thread. Each tick re-reads the thread and sends only if it is still `active`. `thread.idle` and `thread.failed` send a final heartbeat, stop the timer, and request an AI sync. Threads already running when the plugin loads are picked up at startup (running threads are listed, each confirmed active).
- **AI sync:** the first request runs at once; requests in the following 5 minutes schedule one more run at the end of that window.
- **CLI runner:** no shell; at most 4 `wakatime-cli` processes at once and one in flight per key (a newer heartbeat replaces a waiting one); 150 s timeout for heartbeats and 10 minutes for the sync.

## Excluding projects

A matching project sends no bb heartbeats: no user heartbeats, no agent timers, and its idles never trigger the AI sync. Use ids; they survive renames and names do not. Find project ids with `bb project list`. The status panel lists entries that match no project, and the server log warns about each by position (`entry #N`), never by name.

Exclusion covers bb heartbeats only. The host-wide `--sync-ai-activity` can still upload that project's transcripts; turn `syncAiActivity` off to stop that. `wakatime-cli` documents its own path filters (`exclude`, `--exclude-ai`), which this plugin has not tested.

## Counting agent time

Overlapping heartbeats share wall-clock time rather than adding up. Agent heartbeats can therefore relabel time another editor would have recorded as "coding" under the agent category (`building` by default) on bb thread rows, and they add time only while you are otherwise idle. This is the expected behaviour; it has not been measured with this plugin.

- Turning `trackAgentActivity` off removes the effect entirely.
- A different `agentCategory` only changes the label; the time still moves from the other editor's file and project rows to bb thread rows.

`~/.wakatime/wakatime-internal-ai-parsing.json` is the CLI's own state file; it shows which AI sessions the sync has parsed.

## Failures

The WakaTime status panel in Settings shows the CLI path in use, the last successful heartbeat and the last successful AI sync (kept separately), and the last error. An error is shown only while it is newer than the last success of the job that failed, so a bad API key is visible there until a later run succeeds. The exception is a path problem (the `cliPath` is not absolute, not found, not a regular file, or not executable): it is not compared with the last success and stays until a path check passes. Each time the panel reads the status, the plugin checks the current `cliPath`, so fixing the path clears the error without waiting for a heartbeat. It has a Refresh button, and a failed refresh is shown next to it.

`wakatime-cli` always leaves stderr empty and writes its details to `~/.wakatime/wakatime.log`, so the plugin classifies a failure from the exit code alone: 104 `auth`, 102 and 112 `network`, 103 `config` (invalid arguments or config, such as a rejected category), a missing or non-executable binary `missing-cli`, a killed process `timeout`, anything else `other`. The server log carries the exit code and the kind, at most one line per kind every 10 minutes, and points to `~/.wakatime/wakatime.log` for details. It never carries argv, titles, project names, or the CLI's output, and it shows the `cliPath` setting as typed rather than the expanded path.

## Hidden names in `~/.wakatime.cfg`

`hide_file_names`, `hide_project_names`, and `hide_branch_names` in `~/.wakatime.cfg` do apply to this plugin's `--entity-type=app` heartbeats (checked with `wakatime-cli` v2.27.5): `hide_file_names` sends the entity as `HIDDEN`, `hide_project_names` sends an empty project, and `hide_branch_names` drops the branch. Because `hide_project_names` blanks the project, the bb project grouping is lost on the dashboard.

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
