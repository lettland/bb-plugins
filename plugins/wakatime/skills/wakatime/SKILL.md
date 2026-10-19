---
name: wakatime
description: Understand and configure bb's WakaTime plugin — what it sends to WakaTime, its settings, project exclusion, and how to read its status and failures.
---

# WakaTime

The wakatime plugin runs `wakatime-cli` on the bb server host and sends heartbeats for two kinds of time:

1. **Your activity in bb:** you interact with a focused bb window. Heartbeats carry the bb project, thread, and branch of the view you are in.
2. **Agent run time:** a thread's status is `active`, whether or not you are watching.

It also runs one debounced `wakatime-cli --sync-ai-activity` after agent turns.

## What leaves the machine

Everything below goes to WakaTime's cloud through `wakatime-cli`:

- the bb project name
- the entity: the thread title (default), or the thread id only when the `entity` setting is `threadId`
- the branch of the thread's environment
- the category, the time, and the editor string (`bb/<bb version> bb-wakatime/<plugin version>`, sent in the User-Agent header; the bb version is read once in the background after load; it is `unknown` until that answers, or for good if it fails)
- whatever `wakatime-cli --sync-ai-activity` uploads from AI transcripts

The API key is read by `wakatime-cli` from `~/.wakatime.cfg`. The plugin never passes `--key`, never stores the key, and never logs argv, titles, project names, or the CLI's raw output.

## Requirements

`wakatime-cli` must be installed on the bb server host with a working `~/.wakatime.cfg`. Tested with `wakatime-cli` v2.27.5: the plugin relies on its `--sync-ai-disabled` and `--sync-ai-activity` flags and on its category list. A bb client on another machine, or a remote client, counts as the server owner's activity.

## Settings

- `cliPath`: absolute path to the executable (a leading `~` is expanded). A relative path, a directory, or a non-executable file is rejected without running anything. Anyone who can edit plugin settings can make the plugin run that binary on the server host.
- `trackUserActivity` (on) and `userCategory` (`coding`): one of the categories below
- `trackAgentActivity` (on) and `agentCategory` (`building`): one of the categories below
- `syncAiActivity` (on)
- `entity`: `title` (default) or `threadId`. This changes the entity only; the project and branch are still sent.
- `excludeProjects`: bb project ids or names, one per line or comma-separated. Find project ids with `bb project list`.

`ai coding` is not offered for either category: `wakatime-cli` v2.27.5 silently drops every externally submitted heartbeat with that category (it logs "skipping ai coding heartbeat" and exits 0), so the heartbeat would never reach WakaTime. The choices are the CLI's other categories: `coding`, `building`, `indexing`, `debugging`, `learning`, `notes`, `meeting`, `planning`, `researching`, `communicating`, `supporting`, `advising`, `running tests`, `writing tests`, `manual testing`, `writing docs`, `code reviewing`, `browsing`, `translating`, `designing`.

## Excluding projects

A matching project sends no bb heartbeats: no user heartbeats, no agent timers, and its idles never trigger the AI sync. Prefer ids; ids survive renames and names do not. Find project ids with `bb project list`. The WakaTime status panel lists entries that match no project, and the server log warns about each by position (`entry #N`), never by name.

Exclusion covers bb heartbeats only. The host-wide `--sync-ai-activity` can still upload that project's transcripts. The sure way to stop that is to turn `syncAiActivity` off. `wakatime-cli` also documents its own path filters (`exclude`, `--exclude-ai`); this plugin has not tested them.

## AI sync

`wakatime-cli` decides which transcript roots `--sync-ai-activity` reads and may change them when it updates itself. `syncAiActivity` is the off-switch. The CLI keeps its state in `~/.wakatime/wakatime-internal-ai-parsing.json`, which shows which sessions the sync has parsed. Every heartbeat the plugin sends carries `--sync-ai-disabled`, so the debounced sync is the only path that parses transcripts: the first request runs at once, and requests in the following 5 minutes schedule one more run at the end of that window.

## Agent time and your other editors

Overlapping heartbeats share wall-clock time rather than adding up. Agent heartbeats can therefore relabel time that another editor (a JetBrains IDE, for example) would have recorded as "coding" under the agent category (`building` by default) on bb thread rows, and they add time only while you are otherwise idle. This describes the expected behaviour; it has not been measured with this plugin.

- Turn `trackAgentActivity` off to remove the effect entirely.
- A different `agentCategory` only changes the label; the time still moves from the other editor's file and project rows to bb thread rows.

## Failures and where to see them

The WakaTime status panel (Settings) shows the CLI path in use, the last successful heartbeat and the last successful AI sync (kept separately), and the last error, with a Refresh button. An error shows only while it is newer than the last success of the job that failed, so a bad API key stays until a later run succeeds. A path problem (not absolute, not found, not a file, not executable) is the exception: it is not compared with a success and stays until a path check passes. The panel re-checks the current `cliPath` whenever it reads the status, so fixing the path clears the error. A failed refresh is shown next to the button.

`wakatime-cli` always leaves stderr empty and writes its details to `~/.wakatime/wakatime.log`, so failures are classified from the exit code alone: 104 `auth`, 102 and 112 `network`, 103 `config` (invalid arguments or config, such as a rejected category), a missing or non-executable binary `missing-cli`, a killed process `timeout`, anything else `other`. Log lines carry the exit code and the kind, at most one per kind every 10 minutes, and point to `~/.wakatime/wakatime.log`. A missing CLI path logs one warning per path (as typed in the setting, never expanded) and heartbeats are skipped until it exists.

## Hidden names in `~/.wakatime.cfg`

`hide_file_names`, `hide_project_names`, and `hide_branch_names` in `~/.wakatime.cfg` do apply to this plugin's `--entity-type=app` heartbeats (checked with `wakatime-cli` v2.27.5): `hide_file_names` sends the entity as `HIDDEN`, `hide_project_names` sends an empty project, and `hide_branch_names` drops the branch. Because `hide_project_names` blanks the project, the bb project grouping is lost on the dashboard.
