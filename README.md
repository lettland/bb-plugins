# bb-plugins

[![Test](https://github.com/lettland/bb-plugins/actions/workflows/test.yml/badge.svg?branch=master)](https://github.com/lettland/bb-plugins/actions/workflows/test.yml)
[![Coverage Status](https://coveralls.io/repos/github/lettland/bb-plugins/badge.svg?branch=master)](https://coveralls.io/github/lettland/bb-plugins?branch=master)

A monorepo of [bb](https://getbb.app) plugins. Each plugin is a self-contained
package under `plugins/<name>/` with its own `package.json` and `bb` manifest.
The root [`.bb/plugins.json`](.bb/plugins.json) collection manifest indexes them.

## Plugins

| Plugin | ID |
|---|---|
| [Agent hooks](plugins/agent-hooks) | `agent-hooks` |
| [aislop](plugins/aislop) | `aislop` |
| [Auto review](plugins/auto-review) | `auto-review` |
| [devkit](plugins/devkit) | `devkit` |
| [Directory skills](plugins/dir-skills) | `dir-skills` |
| [GitHub (fork)](plugins/github-fork) | `github-fork` |
| [Model instructions](plugins/model-instructions) | `model-instructions` |
| [Project queue](plugins/project-queue) | `project-queue` |
| [Provider queue](plugins/provider-queue) | `provider-queue` |
| [Shared Runtime](plugins/shared-runtime) | `shared-runtime` |
| [Tasks (fork)](plugins/tasks-fork) | `tasks-fork` |
| [Thread list (fork)](plugins/thread-list-fork) | `thread-list-fork` |
| [Triage](plugins/triage) | `triage` |
| [TypeSafe decisions](plugins/typesafe) | `typesafe` |
| [WakaTime](plugins/wakatime) | `wakatime` |

## Install a plugin

From this repo's marketplace (tracks compatible releases):

```sh
bb marketplace add git:https://github.com/lettland/bb-plugins.git@master
bb plugin install auto-review@lettland-plugins
```

The `@lettland-plugins` qualifier is required: the reviewed bb-community
marketplace already lists different `triage` and `wakatime` plugins, so a bare
id can be ambiguous or resolve to someone else's plugin. Already installed
from git? Keep it; switching to the marketplace means `bb plugin remove <id>`
(which deletes that plugin's settings, secrets and schedules) and then the
marketplace install.

From this repo over git (select one plugin from the collection):

```sh
bb plugin install git:https://github.com/lettland/bb-plugins.git --plugin auto-review
# or the primitive, no collection manifest needed:
bb plugin install git:https://github.com/lettland/bb-plugins.git --subdirectory plugins/auto-review
```

## Switch from the built-in tasks, thread-list and github

`tasks-fork`, `thread-list-fork` and `github-fork` are copies of bb's built-in
`tasks`, `thread-list` and `github`. bb keys plugin state by plugin id, so a
copy starts empty. `scripts/migrate-builtin-copies.mjs` copies the id-keyed
state to the new ids:

| Old id | New id |
|---|---|
| `tasks` | `tasks-fork` |
| `thread-list` | `thread-list-fork` |
| `github` | `github-fork` |

What the script does, with bb stopped:

- Refuses to run (exit 1, nothing written) when `lsof` shows a process with
  `<data-dir>/bb.db` or `bb.db-wal` open, when `bb.db` is missing, when
  `plugin_kv` or `plugin_settings` already has rows for a new id, or when a
  new `data.db` already exists.
- Backs up `bb.db` with `sqlite3 ".backup"` to
  `bb.db.pre-fork-copies-<UTC timestamp>` (mode 600) and prints its path.
- Copies each `<data-dir>/plugins/<old id>/data.db` to
  `<data-dir>/plugins/<new id>/data.db` with `sqlite3 ".backup"` (mode 600), so
  content that is still in the WAL file is included. An old id without a
  `data.db` is skipped and reported. `tasks` normally has none.
- In one transaction, copies every `plugin_kv` and `plugin_settings` row of an
  old id to the new id. This includes the github `extraRepos` and
  `defaultProject` settings, the github `sync-cursor` and `link:*` keys, the
  thread-list `preference:*` keys and the thread-list
  `migration:ui-preferences:v1` flag.
- Rewrites the host action key `thread-list/move` to `thread-list-fork/move` in
  the copied `preference:rowActions` row. It parses the JSON array and changes
  only that entry.
- Sets the `sidebar.threadListProvider` UI preference to
  `thread-list-fork/thread-list` when it is exactly `thread-list/thread-list`.
  Any other value, including `__automatic__`, stays as it is.
- Refuses to run, copying nothing, when `<data-dir>/plugins/tasks/data.db` has
  no `archived_at` column in its `tasks` table: upstream's built-in tasks
  plugin created it, and its migration numbering differs from tasks-fork.
- Prints the row counts of every old and new id per table (and per table of
  each copied `data.db`), and exits 1 when a count differs.
- Leaves the old directories and rows in place, and prints the commands to
  delete them.

The script does not copy these tables, because the copy does not need them:
`plugins` and `plugin_artifacts` (the install creates them),
`plugin_state_snapshots` (rollback data for the old plugin's artifacts),
`plugin_schedules` (none of the three plugins registers a schedule),
`thread_tabs` (open-tab state per thread; a stored GitHub PR tab names the old
id and is dropped, so reopen it), `thread_plugin_metadata`, `app_theme` (no
plugin id) and the `origin_plugin_id` columns on threads (history).

Switch-over order:

1. Stop bb.
2. Run the script. `--data-dir` defaults to `~/.bb`; pass `~/.bb-dev` or the
   data directory of another instance.

   ```sh
   node scripts/migrate-builtin-copies.mjs --data-dir ~/.bb
   ```

3. Start bb.
4. Install the three copies:

   ```sh
   bb plugin install tasks-fork@lettland-plugins
   bb plugin install thread-list-fork@lettland-plugins
   bb plugin install github-fork@lettland-plugins
   ```

5. Disable the built-ins: `bb plugin disable tasks`, `bb plugin disable
   thread-list` and `bb plugin disable github`.
6. Select the copied thread list:
   `bb settings ui set sidebar.threadListProvider thread-list-fork/thread-list`.
   The script already did this when the old thread list was selected
   explicitly; run it when the value was `__automatic__`.
7. Verify: the thread-list sort and grouping, the github `extraRepos` setting
   and panel, archive and undo of a thread, and that `bb thread-list --help`
   and `bb tasks --help` each resolve to one plugin. Then delete the old directories and rows with the
   commands the script printed.

Browser `localStorage` values do not migrate:

- `bb.thread-list.preferences.v1` is the browser mirror of the thread-list
  preferences. The copy reads `bb.thread-list-fork.preferences.v1` and rebuilds
  it from the server on first load. The old key stays orphaned.
- `bb.plugin-surface-provider*` is a cache of the surface provider. It
  rewrites itself.

The tasks keys `bb-tasks:view-preferences`, `bb-tasks:project-focus` and
`bb-tasks:last-dispatch-preset` keep their names in the copy, so they carry
over in the same browser profile.

Test the script with `node --test scripts/migrate-builtin-copies.test.mjs`.

## Local development

Each plugin builds standalone with the `bb` CLI (shipped in the public `bb-app`
npm package). From a plugin directory:

```sh
npm install --include=dev --legacy-peer-deps
npm test
npm run test:coverage   # writes coverage/lcov.info (all plugins)
bb plugin build          # downloads the build toolchain on first use
```

`--legacy-peer-deps` sidesteps an npm arborist bug in vitest 4's optional peer
graph. The bb plugin SDK declares its server-side deps (`better-sqlite3`,
`cron-parser`, `hono`) as optional peers; a plugin whose tests use the SDK test
harness lists them as devDependencies.

## CI and coverage

[`.github/workflows/test.yml`](.github/workflows/test.yml) runs every plugin's
suite on pushes and pull requests to `master`. Every plugin runs
`npm run test:coverage` (vitest's v8 provider, or Node's built-in coverage for
`shared-runtime`). The vitest plugins enforce 100% coverage on all four
metrics within the include globs each `vitest.config.ts` defines; a new source
file outside those globs escapes the gate, so review the globs whenever a
plugin gains a top-level file. `shared-runtime` gates lines, branches, and
functions; Node's runner
has no statements threshold. Its floors are the measured lows, 99.71 / 99.03 /
98.88. The functions floor sits below the 99.16 that every idle single-process
run reported because one merged run under load measured 98.88. Coverage runs
single-process (`--test-concurrency=1`) for deterministic merges; plain
`npm test` stays parallel. Each plugin uploads `lcov.info` to Coveralls as one
flag per plugin of a parallel build; a final job closes it, carrying forward
flags a run did not report. Uploads never fail the run.

Coverage ignore comments are allowed only for code that cannot run, for example
an exhaustive-switch default arm; every ignore states its reason. The common
forms: vitest plugins use `// v8 ignore next -- @preserve <reason>` or
`v8 ignore start`/`stop`, and `shared-runtime` uses
`/* node:coverage ignore next */` or `node:coverage disable`/`enable`. The
tree also uses `v8 ignore if`, `v8 ignore else`, `v8 ignore next N`, and
block-comment forms of the same directives. The v8 form carries its reason
inline after `@preserve`; the node form states its reason in a comment
directly above the directive. Start and stop markers must sit on their own
lines.

## Releasing

Releases are automated by [`.github/workflows/release.yml`](.github/workflows/release.yml).
On push to `master` (or a manual run), CI discovers every plugin under `plugins/`,
releases only those whose sources changed since their last tag, bumps the
version, tags `<plugin>/vX.Y.Z`, publishes to npm, and creates a GitHub Release.

Publishing to npm requires the `NPM_TOKEN` secret. Without it, the version bump,
the `<plugin>/vX.Y.Z` tag, and the GitHub Release still happen — only the npm
publish is skipped, and that GitHub Release is annotated to say so. A skipped
version is **not** published retroactively: once the secret is restored, the next
push publishes the next bumped version, not the one skipped earlier (tag discovery
is git-based, so it never rewinds). Re-publish a skipped version by hand if you
need it on npm.

The bump is inferred from commit markers, scanning every commit that touched the
plugin since its last tag: a `[major]` or `[minor]` marker in a commit subject
opts into that bump (the highest marker across the range wins), and any normal
commit with no marker cuts a `patch`. `[patch]` is accepted for parity but is
the default. A manual run accepts an explicit `release_type` (`patch`, `minor`,
`major`, or `prerelease`) and an optional single `plugin` to restrict the
release; `prerelease` is reachable only through such a dispatch.

npm publishing is not set up yet, so install from the marketplace or over git;
every changed plugin still cuts its stable `<plugin>/vX.Y.Z` tag and GitHub
Release. Marketplace installs never receive prereleases — try a beta by its
exact tag over git, e.g. `bb plugin install
git:https://github.com/lettland/bb-plugins.git@<id>/vX.Y.Z-beta.N --subdirectory
plugins/<id>`.

A `[major]` release reaches new marketplace installs once `marketplace.json` is
regenerated — the bump lands in the release bot's commit, so pull, then run `node
scripts/marketplace.mjs`. Existing installs keep the range they were installed
with and stay on the old major; moving them means `bb plugin remove` plus
reinstalling, which costs settings.

To add a new plugin, create `plugins/<name>/` with a `package.json` (name
`@lettland/bb-plugin-<name>`, `publishConfig.access: public`) and a `bb`
manifest, add it to `.bb/plugins.json`, and add its ID to the `plugin` matrix in
[`.github/workflows/test.yml`](.github/workflows/test.yml) (plus its Coveralls
`carryforward` list when it reports coverage). The release workflow picks it up
with no edits. After adding the entry to `.bb/plugins.json`, run `node
scripts/marketplace.mjs` to regenerate `marketplace.json`, and run it again
whenever a plugin's `bb.name`, `bb.description` or `bb.branding.icon` changes —
CI's `marketplace` job fails with that hint when the file is stale. A new entry
becomes installable only after its first `<id>/vX.Y.Z` release tag exists
(`--check` does not look at tags).

## License

BSD-2-Clause ([`LICENSE`](LICENSE)). devkit includes third-party content
under Apache-2.0 and MIT
([`plugins/devkit/THIRD_PARTY_NOTICES.md`](plugins/devkit/THIRD_PARTY_NOTICES.md)),
and triage, project-queue, provider-queue, tasks-fork, thread-list-fork and
github-fork are MIT
([`plugins/triage/LICENSE`](plugins/triage/LICENSE),
[`plugins/project-queue/LICENSE`](plugins/project-queue/LICENSE),
[`plugins/provider-queue/LICENSE`](plugins/provider-queue/LICENSE),
[`plugins/tasks-fork/LICENSE`](plugins/tasks-fork/LICENSE),
[`plugins/thread-list-fork/LICENSE`](plugins/thread-list-fork/LICENSE),
[`plugins/github-fork/LICENSE`](plugins/github-fork/LICENSE)).
tasks-fork, thread-list-fork and github-fork are copies of bb's built-in
plugins and keep bb's MIT license and copyright notice; each has a
`THIRD_PARTY_NOTICES.md` recording the upstream, the copy base and the vendored
registry files
([`plugins/tasks-fork/THIRD_PARTY_NOTICES.md`](plugins/tasks-fork/THIRD_PARTY_NOTICES.md),
[`plugins/thread-list-fork/THIRD_PARTY_NOTICES.md`](plugins/thread-list-fork/THIRD_PARTY_NOTICES.md),
[`plugins/github-fork/THIRD_PARTY_NOTICES.md`](plugins/github-fork/THIRD_PARTY_NOTICES.md)).
