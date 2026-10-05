# bb-plugins

[![Test](https://github.com/lettland/bb-plugins/actions/workflows/test.yml/badge.svg?branch=master)](https://github.com/lettland/bb-plugins/actions/workflows/test.yml)
[![Coverage Status](https://coveralls.io/repos/github/lettland/bb-plugins/badge.svg?branch=master)](https://coveralls.io/github/lettland/bb-plugins?branch=master)

A monorepo of [bb](https://getbb.app) plugins. Each plugin is a self-contained
package under `plugins/<name>/` with its own `package.json` and `bb` manifest.
The root [`.bb/plugins.json`](.bb/plugins.json) collection manifest indexes them.

## Plugins

| Plugin | ID | npm |
|---|---|---|
| [Agent hooks](plugins/agent-hooks) | `agent-hooks` | `@lettland/bb-plugin-agent-hooks` |
| [aislop](plugins/aislop) | `aislop` | `@lettland/bb-plugin-aislop` |
| [Auto review](plugins/auto-review) | `auto-review` | `@lettland/bb-plugin-auto-review` |
| [devkit](plugins/devkit) | `devkit` | `@lettland/bb-plugin-devkit` |
| [Directory skills](plugins/dir-skills) | `dir-skills` | `@lettland/bb-plugin-dir-skills` |
| [Model instructions](plugins/model-instructions) | `model-instructions` | `@lettland/bb-plugin-model-instructions` |
| [Shared Runtime](plugins/shared-runtime) | `shared-runtime` | `@lettland/bb-plugin-shared-runtime` |
| [Taskboard](plugins/taskboard) | `taskboard` | `@lettland/bb-plugin-taskboard` |

## Install a plugin

From npm (per-plugin, tracks compatible releases):

```sh
bb plugin install npm:@lettland/bb-plugin-auto-review
```

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
npm run test:coverage   # writes coverage/lcov.info (plugins with runtime tests)
bb plugin build          # downloads the build toolchain on first use
```

`--legacy-peer-deps` sidesteps an npm arborist bug in vitest 4's optional peer
graph. The bb plugin SDK declares its server-side deps (`better-sqlite3`,
`cron-parser`, `hono`) as optional peers; a plugin whose tests use the SDK test
harness lists them as devDependencies.

## CI and coverage

[`.github/workflows/test.yml`](.github/workflows/test.yml) runs every plugin's
suite on pushes and pull requests to `master`. Plugins with runtime tests run
`npm run test:coverage` (vitest's v8 provider, or Node's built-in coverage for
`shared-runtime`) and upload `lcov.info` to Coveralls as one flag per plugin of a
parallel build; a final job closes it, carrying forward flags a run did not
report. Uploads never fail the run.

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

Because every changed plugin cuts at least a stable `patch`, its npm `latest`
resolves after the first release that actually publishes — `npm install
@lettland/bb-plugin-<name>` works once a run with `NPM_TOKEN` has published it (see
the note above). A `prerelease` dispatch publishes to the `next` dist-tag instead;
install those with `@next` or an exact version.

Adding a new plugin needs no workflow edits: create `plugins/<name>/` with a
`package.json` (name `@lettland/bb-plugin-<name>`, `publishConfig.access: public`)
and a `bb` manifest, add it to `.bb/plugins.json`, and CI picks it up.

## License

BSD-2-Clause (LICENSE). taskboard is MIT (plugins/taskboard/LICENSE); devkit includes third-party content under Apache-2.0 and MIT (plugins/devkit/THIRD_PARTY_NOTICES.md).
