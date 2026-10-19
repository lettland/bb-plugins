---
name: wakatime
description: Understand and configure bb's WakaTime plugin — what it sends to WakaTime (thread time and the files agents touch), its settings, project exclusion, and how to read its status and failures.
---

# WakaTime

The wakatime plugin runs `wakatime-cli` on the bb server host and reports only what bb itself knows, the same way for every provider (Claude Code, Codex, ACP, any other). It sends:

1. **Your activity in bb:** you interact with a focused bb window. Heartbeats carry the bb project, thread, and branch of the view you are in.
2. **Agent run time:** a thread's status is `active`, whether or not you are watching. One heartbeat per thread about every 2 minutes.
3. **Agent file activity:** the files an agent edited or read inside the thread's environment folder, sent with the thread's heartbeats.

The data comes from the thread lifecycle events, the thread event log (completed file changes and file reads), and your window activity. The plugin parses no provider transcripts and runs no `--sync-ai-activity`.

## Changed in this version

**File paths inside the project are now sent by default. Set `fileActivity` to `off` to stop.**

- The transcript sync is removed (`syncAiActivity` is gone), so `claude-code` sessions no longer get `ai coding` time from it.
- File activity arrives under `agentCategory` (`building` by default), for every provider alike.
- Excluding a project stops all of its bb uploads. Turning file activity off stops only its file entries; per-thread agent time continues. Nothing from either period is sent later, even after you turn it back on.

## What leaves the machine

Everything below goes to WakaTime's cloud through `wakatime-cli`.

Per thread: the bb project name, the entity (the thread title, or the thread id only when `entity` is `threadId`), the branch of the thread's environment, the category and the time.

Per file (when `fileActivity` is on and `entity` is `title`): the absolute file path on the bb server host (only inside the environment folder, symlinks resolved, `node_modules` and `.git` skipped), whether it was written or only read, the number of changed lines for edits (counted from the diff; the diff itself is not sent), and the time. For files that exist on the bb server host, `wakatime-cli` also derives and uploads the line count and the dependencies by reading the file.

File **contents never leave the machine**; file **names do** (a file such as `.env.production` is uploaded as a name). The editor string `bb/<bb version> bb-wakatime/<plugin version>` goes in the User-Agent header; the bb version is read once in the background after load, so it is `bb/unknown` until that answers, or for good if it fails.

The API key is read by `wakatime-cli` from `~/.wakatime.cfg`. The plugin never passes `--key`, never stores the key, and never logs argv, titles, project names, file paths, or the CLI's raw output.

## Requirements

`wakatime-cli` must be installed on the bb server host with a working `~/.wakatime.cfg`. Tested with `wakatime-cli` v2.27.5: the plugin relies on its `--sync-ai-disabled` and `--extra-heartbeats` flags and on its category list. A bb client on another machine, or a remote client, counts as the server owner's activity.

## Settings

- `cliPath`: absolute path to the executable (a leading `~` is expanded). A relative path, a directory, or a non-executable file is rejected without running anything. Anyone who can edit plugin settings can make the plugin run that binary on the server host.
- `trackUserActivity` (on) and `userCategory` (`coding`): one of the categories below
- `trackAgentActivity` (on) and `agentCategory` (`building`): one of the categories below. Off sends nothing about agent threads, files included.
- `fileActivity` (`edits-and-reads`): `edits-and-reads`, `edits`, or `off`. File entries reach the dashboard up to about 2 minutes late (they go with the thread's next heartbeat), and a change takes effect at the next send.
- `entity`: `title` (default) or `threadId`. Besides dropping file entries (with `threadId` none are sent at all, whatever `fileActivity` says), this changes only the entity: the project and branch are still sent.
- `excludeProjects`: bb project ids or names, one per line or comma-separated. Find project ids with `bb project list`.

`ai coding` is not offered for either category: `wakatime-cli` v2.27.5 silently drops every externally submitted heartbeat with that category (it logs "skipping ai coding heartbeat" and exits 0), so the heartbeat would never reach WakaTime. The choices are the CLI's other categories: `coding`, `building`, `indexing`, `debugging`, `learning`, `notes`, `meeting`, `planning`, `researching`, `communicating`, `supporting`, `advising`, `running tests`, `writing tests`, `manual testing`, `writing docs`, `code reviewing`, `browsing`, `translating`, `designing`.

## Excluding projects

A matching project sends no bb heartbeats: no user heartbeats, no agent timers, no file entries. Prefer ids; ids survive renames and names do not. Find project ids with `bb project list`. The WakaTime status panel lists entries that match no project, and the server log warns about each by position (`entry #N`), never by name.

## How file activity is delivered

A thread starts at the current end of its event log, so history is never replayed. Completed file changes and reads are collected in memory; each 2-minute tick and the final stop send them, up to 200 files per `wakatime-cli` call, in order, with at most one send per thread in flight. A read of the same path within 2 minutes of the previous one is sent once; writes are never thinned. A send that waits for a free `wakatime-cli` slot re-reads the settings just before it starts. If what it carries is no longer allowed, or a file in it has turned into a non-regular entry (a symlink, say), the call is skipped and its entries go back to the buffer; the next send drops whatever the current settings no longer allow (counted as dropped by your settings) and sends the rest, and with file activity off everything is dropped. A deleted file does not stop a send, but if it is deleted while its send waits for a slot, that entry may go out without `is_unsaved_entity`, and `wakatime-cli` may then drop that one entry. If the skipped call was the final stop's, that last heartbeat is not re-sent.

Pending entries live only in the bb server's memory until the thread's next tick or turn, and are discarded when the thread is archived or deleted and when the plugin reloads. At most 2000 are kept; past that the oldest are dropped.

When `fileActivity` is turned off, `entity` becomes `threadId`, agent tracking is turned off, or the project is excluded, what is buffered is dropped and the thread starts again at the current end of its log when tracking resumes: nothing from the untracked period is ever uploaded later.

A file counts as saved (and `wakatime-cli` reads it) only when the environment folder exists on the bb server host and the path is a regular file there. A deleted file, a remote environment, or anything else is sent as unsaved. Edge case: a remote environment whose folder also exists locally under the same layout is treated as local.

## Agent time and your other editors

Overlapping heartbeats share wall-clock time rather than adding up. Agent heartbeats can therefore relabel time that another editor (a JetBrains IDE, for example) would have recorded as "coding" under the agent category (`building` by default) on bb thread rows, and they add time only while you are otherwise idle. This describes the expected behaviour; it has not been measured with this plugin.

- Turn `trackAgentActivity` off to remove the effect entirely.
- A different `agentCategory` only changes the label; the time still moves from the other editor's file and project rows to bb thread rows.

## Failures and where to see them

The WakaTime status panel (Settings) shows the CLI path in use, the last successful heartbeat, the last error, and the file pipeline: when file entries were last sent, how many wait in memory (they go with the thread's next tick or turn), and how many were dropped since the plugin loaded, by reason (outside the environment folder, or the thread has no environment folder; buffer full; dropped by your `fileActivity`, `entity`, agent-tracking or exclusion settings; `wakatime-cli` failed). It has a Refresh button, and a failed refresh is shown next to it.

An error shows only while it is newer than the last successful heartbeat, so a bad API key stays until a later run succeeds. A path problem (not absolute, not found, not a file, not executable) is the exception: it is not compared with a success and stays until a path check passes. The panel re-checks the current `cliPath` whenever it reads the status, so fixing the path clears the error.

`wakatime-cli` always leaves stderr empty and writes its details to `~/.wakatime/wakatime.log`, so failures are classified from the exit code alone: 104 `auth`, 102 and 112 `network`, 103 `config` (invalid arguments or config, such as a rejected category), a missing or non-executable binary `missing-cli`, a killed process `timeout`, anything else `other`. Log lines carry the exit code and the kind, at most one per kind every 10 minutes, and point to `~/.wakatime/wakatime.log`. A missing CLI path logs one warning per path (as typed in the setting, never expanded) and heartbeats are skipped until it exists.

A batch of file entries whose `wakatime-cli` call failed is counted as dropped: network failures may sit in the CLI's own offline queue, but timeouts, kills, and config or auth errors are lost. If a thread's environment cannot be read, its file pipeline holds at the same read position and retries on the next event or tick, so nothing is skipped or dropped; the panel shows "Waiting on environment lookup: N thread(s)" and the server log says so once. The indicator clears when a read succeeds or when file activity stops for the thread.

Gaps that are not counted: if reading a thread's event log fails at the start, the plugin retries on the next event or tick, and anything that landed in between is neither sent nor counted; events between a thread becoming active and the first read of its event log after the plugin loads are not sent; entries still pending when the plugin is disposed, or when the thread is archived or deleted, are discarded.

## Hidden names in `~/.wakatime.cfg`

`~/.wakatime.cfg` applies to every editor on the machine and to this plugin's calls too (checked with `wakatime-cli` v2.27.5 against a local listener):

- `hide_file_names = true` sends the app heartbeat's entity as `HIDDEN` and every file entry's entity as `HIDDEN` plus its extension (`HIDDEN.ts`). File entries still carry the project, the write flag and `ai_line_changes`. In that run the branch was also left out.
- `hide_project_names` sends an empty project, and `hide_branch_names` drops the branch. Because `hide_project_names` blanks the project, the bb project grouping is lost on the dashboard.
