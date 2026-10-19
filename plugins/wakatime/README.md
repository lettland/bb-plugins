# bb-plugin-wakatime

Sends [WakaTime](https://wakatime.com) heartbeats for time spent in bb. It runs `wakatime-cli` on the bb server host and reports only what bb itself knows, the same way for every provider (Claude Code, Codex, ACP, and any other):

1. **Your activity in bb:** you interact with a focused bb window. Heartbeats are tagged with the bb project, thread, and branch of the view.
2. **Agent run time:** a thread's status is `active`, whether or not you are watching. One heartbeat per thread about every 2 minutes, under the thread's bb project, branch and title.
3. **Agent file activity:** the files an agent edited or read inside the thread's environment folder, sent with the thread's heartbeats.

The data comes from three bb sources: the thread lifecycle events (`active`, `idle`, `failed`, `archived`, `deleted`), the thread event log (completed file changes and file reads), and your window activity. The plugin parses no provider transcripts and runs no `--sync-ai-activity`.

## Changed in this version

**File paths inside the project are now sent by default. Set `fileActivity` to `off` to stop.**

- The transcript sync is removed (`syncAiActivity` is gone). `claude-code` sessions no longer get `ai coding` time from it, because the plugin no longer asks `wakatime-cli` to parse `~/.claude` or `~/.codex`.
- File activity now arrives under `agentCategory` (`building` by default), for every provider alike.
- Excluding a project stops all of its bb uploads. Turning file activity off stops only its file entries; per-thread agent time (project, thread, branch, time) continues. Nothing from either period is sent later, even after you turn it back on: a thread that was untracked starts again at the current end of its event log.

## Requirements

- `wakatime-cli` installed on the bb server host (default path `~/.wakatime/wakatime-cli`). Tested with `wakatime-cli` v2.27.5: the plugin relies on its `--sync-ai-disabled` and `--extra-heartbeats` flags and on its category list.
- A working `~/.wakatime.cfg` with your API key. The plugin never passes `--key`, never stores the key as a setting, and never logs it.

## What leaves the machine

Everything the plugin sends goes to WakaTime's cloud through `wakatime-cli`.

Per thread (about every 2 minutes while it is active, and once more when it stops):

- the bb project name
- the entity: the thread title (default) or the thread id only (`entity` = `threadId`)
- the branch of the thread's environment
- the category and the time

Per file (when `fileActivity` is on and `entity` is `title`):

- the file path, only if it lies inside the thread's environment folder (after resolving symlinks; `node_modules` and `.git` are skipped)
- whether the agent wrote or only read it
- for edits, the number of lines changed (counted from the diff; the diff itself is not sent)
- the time of the event
- for files that exist on the bb server host, the line count and the dependencies `wakatime-cli` derives by reading the file

File **contents never leave the machine**, but file **names do**: a file such as `.env.production` is uploaded as a name. A view with no project (home, settings) sends entity `bb` and no project.

The editor string `bb/<bb version> bb-wakatime/<plugin version>` goes in the request's User-Agent header.

## What is sent

The per-thread heartbeat:

```
wakatime-cli --entity-type=app --entity=<entity> --project=<bb project name>
  --alternate-branch=<branch> --category=<category> --time=<epoch seconds>
  --plugin="bb/<bb version> bb-wakatime/<plugin version>" --sync-ai-disabled
```

When files are waiting, `--extra-heartbeats` is added and a JSON array goes to stdin, one object per file with exactly these keys: `entity` (the path), `type` (`file`), `category`, `time`, `project`, `alternate_branch`, `is_write`, `ai_line_changes` (edits with a countable diff) and `is_unsaved_entity` (only when the file is not a regular file on this host, such as a deleted file or one in a remote environment). No diff text, command, or key is ever included.

The bb version is read once in the background after the plugin loads; heartbeats say `bb/unknown` until it answers, or for good if it fails. Every value uses the `--flag=value` form, so a title starting with `-` is never read as a flag. `--sync-ai-disabled` is on every call.

## Settings

| Setting | Default | |
|---|---|---|
| `cliPath` | `~/.wakatime/wakatime-cli` | Absolute path after `~` expansion, to a regular executable file. Anyone who can edit plugin settings can make the plugin run that binary on the server host. |
| `trackUserActivity` | on | Heartbeats while you interact with a focused bb window. |
| `userCategory` | `coding` | One of the categories below. |
| `trackAgentActivity` | on | Per-thread heartbeats about every 2 minutes while a thread is active. Off sends nothing about agent threads, files included. |
| `agentCategory` | `building` | One of the categories below; used for threads and their files. |
| `fileActivity` | `edits-and-reads` | `edits-and-reads`, `edits`, or `off`. File entries reach the dashboard up to about 2 minutes late (they go with the thread's next heartbeat), and a change takes effect at the next send. |
| `entity` | `title` | `title` or `threadId`. This changes the entity only; the project and branch are still sent. With `threadId`, no file entries are sent at all, whatever `fileActivity` says. |
| `excludeProjects` | empty | bb project ids or names. Find project ids with `bb project list`. |

Settings are read fresh on every use.

`ai coding` is not offered for either category: `wakatime-cli` v2.27.5 silently drops every externally submitted heartbeat with that category (it logs "skipping ai coding heartbeat" and exits 0), so the heartbeat would never reach WakaTime. The choices are the CLI's other categories: `coding`, `building`, `indexing`, `debugging`, `learning`, `notes`, `meeting`, `planning`, `researching`, `communicating`, `supporting`, `advising`, `running tests`, `writing tests`, `manual testing`, `writing docs`, `code reviewing`, `browsing`, `translating`, `designing`.

## How it works

- **Your activity:** the plugin's frontend listens for keyboard, pointer, and wheel input while the bb window is focused and visible, and asks the server for a heartbeat when the route changes and otherwise at most every 2 minutes. The server allows one heartbeat per key and category every 120 seconds, and every bb window, tab, or remote client counts as the server owner's activity.
- **Agent time:** `thread.active` sends a heartbeat and starts a 2-minute timer for the thread. Each tick re-reads the thread and sends only if it is still `active`. `thread.idle` and `thread.failed` send a final heartbeat and stop the timer. Threads already running when the plugin loads are picked up at startup.
- **File activity:** a thread starts at the current end of its event log, so history is never replayed. While it runs, completed file changes and file reads are collected in memory (a pull makes no CLI call). Each tick and the final stop send them: up to 200 files per `wakatime-cli` call, in order. A read of the same path within 2 minutes of the previous one is sent once; writes are never thinned. Only one send per thread is in flight at a time.
- **In memory only:** pending file entries live only in the bb server's memory, until the thread's next tick or turn. They are discarded when the thread is archived or deleted and when the plugin reloads or the server restarts. At most 2000 are kept; past that the oldest are dropped.
- **CLI runner:** no shell; at most 4 `wakatime-cli` processes at once and one in flight per key; a 150 s timeout.

## Excluding projects

A matching project sends no bb heartbeats: no user heartbeats, no agent timers, no file entries. Use ids; they survive renames and names do not. Find project ids with `bb project list`. The status panel lists entries that match no project, and the server log warns about each by position (`entry #N`), never by name.

## Counting agent time

Overlapping heartbeats share wall-clock time rather than adding up. Agent heartbeats can therefore relabel time another editor would have recorded as "coding" under the agent category (`building` by default) on bb thread rows, and they add time only while you are otherwise idle. This is the expected behaviour; it has not been measured with this plugin.

- Turning `trackAgentActivity` off removes the effect entirely.
- A different `agentCategory` only changes the label; the time still moves from the other editor's file and project rows to bb thread rows.

## Failures and gaps

The WakaTime status panel in Settings shows the CLI path in use, the last successful heartbeat, the last error, and the file pipeline: the last time file entries were sent, how many wait in memory (they go with the thread's next tick or turn), and how many were dropped, by reason:

- **outside the environment folder**: the path was not inside the thread's environment folder
- **buffer full**: more than 2000 were waiting
- **dropped by your settings**: `fileActivity`, `entity`, agent tracking or an exclusion changed while they waited
- **wakatime-cli failed**: the call that carried them failed. Network failures may sit in the CLI's own offline queue; timeouts, kills, and config or auth errors are lost.

Gaps that are not counted: if reading a thread's event log fails at the start, the plugin retries on the next event or tick, and anything that landed in between is neither sent nor counted; entries still pending when the plugin is disposed are discarded.

An error is shown only while it is newer than the last successful heartbeat, so a bad API key is visible there until a later run succeeds. The exception is a path problem (the `cliPath` is not absolute, not found, not a regular file, or not executable): it is not compared with the last success and stays until a path check passes. Each time the panel reads the status, the plugin checks the current `cliPath`, so fixing the path clears the error without waiting for a heartbeat. It has a Refresh button, and a failed refresh is shown next to it.

`wakatime-cli` always leaves stderr empty and writes its details to `~/.wakatime/wakatime.log`, so the plugin classifies a failure from the exit code alone: 104 `auth`, 102 and 112 `network`, 103 `config` (invalid arguments or config, such as a rejected category), a missing or non-executable binary `missing-cli`, a killed process `timeout`, anything else `other`. The server log carries the exit code and the kind, at most one line per kind every 10 minutes, and points to `~/.wakatime/wakatime.log` for details. It never carries argv, titles, project names, file paths, or the CLI's output, and it shows the `cliPath` setting as typed rather than the expanded path.

## Hidden names in `~/.wakatime.cfg`

`~/.wakatime.cfg` applies to every editor on the machine, and it applies to this plugin's calls too (checked with `wakatime-cli` v2.27.5 against a local listener):

- `hide_file_names = true` sends the app heartbeat's entity as `HIDDEN` and every file entry's entity as `HIDDEN` plus its extension (`HIDDEN.ts`). The file entries still carry the project, the write flag and `ai_line_changes`. In that run the branch was also left out.
- `hide_project_names` sends an empty project, and `hide_branch_names` drops the branch. Because `hide_project_names` blanks the project, the bb project grouping is lost on the dashboard.

## Local and remote environments

A file counts as saved (and `wakatime-cli` reads it for line counts and dependencies) only when the thread's environment folder exists on the bb server host and the path is a regular file there. A deleted file, a file in a remote environment, or anything that is not a regular file is sent as unsaved. The one edge case left: a remote environment whose folder also exists locally under the same layout is treated as local.

## Development

```sh
npm install --include=dev --legacy-peer-deps
npm run typecheck
npm run test:coverage
npm run build
```

Tests never spawn a real `wakatime-cli`: the runner takes an injected `exec`, and the test setup makes the real `execFile` throw.

## License

BSD-2-Clause.
