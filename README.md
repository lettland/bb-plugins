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
| [Model instructions](plugins/model-instructions) | `model-instructions` |
| [Project queue](plugins/project-queue) | `project-queue` |
| [Shared Runtime](plugins/shared-runtime) | `shared-runtime` |
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
metrics. `shared-runtime` gates lines, branches, and functions; Node's runner
has no statements threshold. Its floors are the measured lows, 99.71 / 99.03 /
98.88: `node --test` merges coverage from child processes, and one merged run
under load measured functions at 98.88, so the functions floor sits below the
99.16 every idle single-process run reported. `shared-runtime` runs coverage
single-process (`--test-concurrency=1`) for deterministic merges; plain
`npm test` stays parallel. Each plugin uploads `lcov.info` to Coveralls as one
flag per plugin of a parallel build; a final job closes it, carrying forward
flags a run did not report. Uploads never fail the run.

Coverage ignore comments are allowed only for code that cannot run, for example
an exhaustive-switch default arm; every ignore states its reason. Vitest plugins
use `// v8 ignore next -- @preserve <reason>` or `v8 ignore start`/`stop`, and
`shared-runtime` uses `/* node:coverage ignore next */` or
`node:coverage disable`/`enable`. Start and stop markers must sit on their own
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
and triage and project-queue are MIT
([`plugins/triage/LICENSE`](plugins/triage/LICENSE),
[`plugins/project-queue/LICENSE`](plugins/project-queue/LICENSE)).
