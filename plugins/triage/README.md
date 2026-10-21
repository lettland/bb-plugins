# Triage for BB

Keep agent tasks, progress, and work that needs your attention in one board.
Run tasks now or schedule them for later, organize them into configurable stages,
and turn existing BB sessions into cards. Open each card's linked conversation
to follow the work.

Based on [MayankBansal12/bb-plugin-triage](https://github.com/MayankBansal12/bb-plugin-triage);
this copy is maintained in the [lettland/bb-plugins](https://github.com/lettland/bb-plugins)
collection.

## Screenshots

Track tasks across stages, projects, and machines.

![Triage board with task cards grouped by workflow stage](https://github.com/user-attachments/assets/ccc76352-f56e-4e86-9bab-c9ac229e1c33)

Create a task with BB's agent controls and choose when it starts.

![New task dialog with agent configuration and start controls](https://github.com/user-attachments/assets/02fe89a8-c63c-4fa3-a91b-cefdd29df095)

Review recent updates and find work that needs your attention.

![Updates panel with recent task activity and attention filters](https://github.com/user-attachments/assets/ecc281cd-2627-4457-b986-9efcde96b989)

## Requirements

- BB 0.42+ with a compatible Plugin SDK 0.4.47 runtime.
- A configured agent provider. Provider accounts and usage charges still apply.
- BB and Triage must be running for scheduled work to start. Overdue tasks are
  picked up when the scheduler resumes.

Triage stores cards and update history in BB's plugin-owned SQLite database.
It does not require a separate Triage account or external task service.
Browser notifications require your permission.

## Install

Install from npm (tracks compatible releases):

```sh
bb plugin install npm:@lettland/bb-plugin-triage
```

Or from this collection over git:

```sh
bb plugin install git:https://github.com/lettland/bb-plugins.git --plugin triage
```

### Switching from upstream

If you previously installed the upstream build:

1. Back up `~/.bb/plugins/triage/` — the board lives in its `data.db`.
2. Run `bb plugin remove triage`. This deletes the plugin's settings and schedules.
3. Install this build (see above).
4. If the board comes back empty, stop bb, copy your backed-up `data.db` back into `~/.bb/plugins/triage/`, and start bb again.

## Development

This plugin lives in the
[lettland/bb-plugins](https://github.com/lettland/bb-plugins) monorepo (see the
root README's "Local development"). From `plugins/triage`, under the Node
version pinned in the repo's `.nvmrc`:

```sh
npm install --include=dev --legacy-peer-deps
npm test
bb plugin build
```

The plugin stores its board in BB's plugin-owned SQLite database. Worker
threads default to hidden sidebar visibility and remain directly
openable from their cards.

## Agent CLI

```sh
bb triage list
bb triage show 42
bb triage run 42
bb triage move 42 "Review" --summary "Implementation is ready"
bb triage stages
```

## Sessions and the sidebar

- Open a session and choose **Move to Triage** in its header. Triage creates a
  card for the existing conversation and hides it from the regular session list.
  Repeating the action reuses the same card; it never starts another agent.
- Linked cards and the session header's **Triage #…** menu show either
  **Show session in sidebar** or **Hide session from sidebar**, based on current visibility.
  Showing a session keeps its Triage card and history.
- In **Settings → Triage**, enable **Show Triage sessions in the sidebar** to show
  all existing linked sessions and future task sessions in the regular session
  list. It defaults to **off**. Changing it applies to all linked sessions;
  individual show/hide actions override it until the next setting change.
- **Triage settings → Show Triage in sidebar** controls the separate, default-off card section.
  When BB uses the **Triage above threads** sidebar layout, it also provides a
  **Move current session to Triage** control. With another sidebar plugin,
  use the session header action.

Imported sessions receive their assigned Triage agent tool and instructions on
subsequent agent configuration. Importing does not interrupt a running turn.

## Board controls

- **Triage settings** lets you rename stages and reorder them with drag handles
  (or focus a handle and use the up/down arrow keys).
- **Updates** opens on **Recent**, showing newest events first, grouped by day.
  Needs you, Running, and Pending show current task states. Opening a task marks
  its updates read; **Mark all read** clears the remaining unread updates.
- Search the project picker by name. Selecting a project selects its configured
  default machine when available; select **All machines** to widen the view.
  The personal project is labeled **Personal**.

## Compatibility and verification

Requires BB 0.42+ and Plugin SDK 0.4.47 or newer. This repository's GitHub
Actions workflow runs `npm test` (`tsc --noEmit` plus the test suite) on every
push and pull request.

New cards start in To Do. Agent execution moves them to In Progress; agents are
instructed to explicitly report completion or a need for attention. Ending a turn
alone does not mark work complete. Scheduled tasks require BB and Triage to be
running; overdue work is picked up when the scheduler resumes.

## License

[MIT](LICENSE) © 2026 Mayank Bansal.
