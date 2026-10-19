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
- the category, the time, and the editor string (`bb/unknown bb-wakatime/<plugin version>`; `unknown` because the plugin SDK does not expose the host's version)
- whatever `wakatime-cli --sync-ai-activity` uploads from AI transcripts

The API key is read by `wakatime-cli` from `~/.wakatime.cfg`. The plugin never passes `--key`, never stores the key, and never logs argv, titles, project names, or the CLI's raw output.

## Requirements

`wakatime-cli` must be installed on the bb server host with a working `~/.wakatime.cfg`. A bb client on another machine, or a remote client, counts as the server owner's activity.

## Settings

- `cliPath`: absolute path to the executable (a leading `~` is expanded). A relative path, a directory, or a non-executable file is rejected without running anything. Anyone who can edit plugin settings can make the plugin run that binary on the server host.
- `trackUserActivity` (on) and `userCategory` (`coding`)
- `trackAgentActivity` (on) and `agentCategory` (`ai coding`)
- `syncAiActivity` (on)
- `entity`: `title` (default) or `threadId`
- `excludeProjects`: bb project ids or names, one per line or comma-separated

## Excluding projects

A matching project sends no bb heartbeats: no user heartbeats, no agent timers, and its idles never trigger the AI sync. Prefer ids; ids survive renames and names do not. The WakaTime status panel lists entries that match no project, and the server log warns about each by position (`entry #N`), never by name.

Exclusion covers bb heartbeats only. The host-wide `--sync-ai-activity` can still upload that project's transcripts. The sure way to stop that is to turn `syncAiActivity` off. `wakatime-cli` also documents its own path filters (`exclude`, `--exclude-ai`); this plugin has not tested them.

## AI sync

`wakatime-cli` decides which transcript roots `--sync-ai-activity` reads and may change them when it updates itself. `syncAiActivity` is the off-switch. The CLI keeps its state in `~/.wakatime/wakatime-internal-ai-parsing.json`, which shows which sessions the sync has parsed. Every heartbeat the plugin sends carries `--sync-ai-disabled`, so the debounced sync is the only path that parses transcripts: the first request runs at once, and requests in the following 5 minutes schedule one more run at the end of that window.

## Agent time and your other editors

Overlapping heartbeats share wall-clock time rather than adding up. Agent heartbeats can therefore relabel time that another editor (a JetBrains IDE, for example) would have recorded as "coding" as "ai coding" on bb thread rows, and they add time only while you are otherwise idle. This describes the expected behaviour; it has not been measured with this plugin.

- Turn `trackAgentActivity` off to remove the effect entirely.
- A different `agentCategory` only changes the label; the time still moves from the other editor's file and project rows to bb thread rows.

## Failures and where to see them

The WakaTime status panel (Settings) shows the resolved CLI path, the last successful heartbeat, and the last error until a later heartbeat succeeds. A missing CLI and a bad API key both show there. Log lines carry the exit code and one error kind: `missing-cli`, `auth`, `network`, `timeout`, or `other`, at most one per kind every 10 minutes. A missing CLI path logs one warning per path and heartbeats are skipped until it exists.

Hidden-name options in `~/.wakatime.cfg` (`hide_file_names`, `hide_project_names`, `hide_branch_names`): whether `wakatime-cli` applies them to this plugin's `--entity-type=app` heartbeats has not been verified.
