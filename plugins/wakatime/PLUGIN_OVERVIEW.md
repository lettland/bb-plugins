# WakaTime

Server and frontend plugin. It runs `wakatime-cli` on the bb server host and sends WakaTime heartbeats for the user's activity in a focused bb window and for agent run time (a thread whose status is `active`), tagged with the bb project, thread, and branch. It also runs one debounced `wakatime-cli --sync-ai-activity` after agent turns.

## How it works

- `server.ts` registers the settings, the `heartbeat` and `status` RPC methods, and the thread lifecycle listeners (`thread.active`, `thread.idle`, `thread.failed`, `thread.archived`, `thread.deleted`, `experimental_thread.events`). Everything is registered first; the host version (for the `--plugin` editor string, `bb/unknown` until it answers) is read once in the background with a 5 s abort. At startup it checks `excludeProjects`, and starts timers for running threads (`threads.listRunning`, each confirmed active with `threads.get`). Disposing the plugin also disposes the runner.
- `src/cli.ts` is the runner. `exec` is injected (default `execFile`, no shell). It checks the CLI path (absolute, regular, executable; re-checked after a spawn error), allows 4 processes at once and one per key, replaces a waiting job for a key in place, and applies timeouts of 150 s (heartbeats) and 10 min (sync). wakatime-cli leaves stderr empty, so failures are classified from the exit code alone (104 `auth`, 102/112 `network`, 103 `config`, spawn error `missing-cli`, kill `timeout`, else `other`) and logged at most once per kind every 10 minutes, never with argv, and with the cli path only as typed. Heartbeat and sync health are tracked separately, and `verify()` re-runs the path check so the status reflects the current `cliPath`.
- `src/heartbeat.ts` holds the pure parts: the argv builder, entity and exclusion rules, the 120 s throttle, a TTL cache for the branch, and context resolution through `bb.sdk`.
- `src/tracker.ts` holds the agent timers. A tick re-reads the thread and sends only if it is still `active` and its own timer is still the registered one. `experimental_thread.events` only starts a missing timer, after the same live check. A thread skipped because tracking is off or its project is excluded is remembered until it is activated, stops, or settings change, so a stream of payloads does not re-read it.
- `src/ai-sync.ts` is the trailing-edge debounce for the sync (5-minute window, one trailing run, one queued follow-up).
- `src/activity.ts` turns keyboard, pointer, and wheel input into heartbeat requests while the window is focused and visible. `app.tsx` mounts it as an app overlay (`experimental_appOverlay`) and adds a status section to Settings. Activity just before a route change is credited to the new view.

## What leaves the machine

Project name, entity (thread title or id), branch, category, time, editor string, and whatever `--sync-ai-activity` uploads from transcripts. The API key stays in `~/.wakatime.cfg`; the plugin never passes `--key`.

## Notes

- Settings are read fresh on every use; nothing is captured in the factory.
- The agent and user categories are selects over the CLI's categories minus `ai coding`, which wakatime-cli v2.27.5 silently drops from external submitters.
- An excluded project sends no bb heartbeats and never triggers the sync; the host-wide sync can still upload its transcripts.
- Per-thread state is deleted on idle, failure, archive, delete, and dispose.
