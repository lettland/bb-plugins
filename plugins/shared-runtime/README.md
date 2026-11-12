# bb-plugin-shared-runtime

One shared, write-confined container runtime per repository for every BB managed worktree.
Install the plugin once per host, then enable it in any repository by committing a
`.bb-runtime.json` manifest and running one install command from the primary checkout.

The plugin gives agent threads a small set of typed tools:

| Tool | Purpose |
|---|---|
| `runtime_container` | Run one operation declared by the project manifest inside the project's shared Docker stack, write-confined to the selected worktree by Landlock and seccomp. |
| `runtime_git` | Typed Git: status, diff, log, add, commit (with declared commit-preparation generators), rebase onto the primary branch, fast-forward the primary checkout. |
| `runtime_ops` | Lifecycle: status, diagnose, logs, ensure, recreate, stop, sync. |
| `runtime_search` | Workspace-confined literal search with ripgrep. |
| `runtime_thread` | Read bounded output from one same-project thread. |
| `runtime_skill_resource` | Read one file from an installed agent skill. |

Agents never receive Docker, a shell, or a host toolchain. Every command is an argument array
compiled from the manifest; targets are validated against a declared pattern or variant list.

## How it works

- **One Docker stack per primary checkout.** The repository's own Compose stack, started by the
  lifecycle script the manifest names, serves every BB worktree of that repository.
- **Worktrees are mounted into the stack** at `worktrees.containerRoot` (default `/bb-worktrees`).
  Containers that run Git also mount the worktree root and the primary checkout at their
  identical host paths so linked-worktree metadata stays valid.
- **Write confinement.** Quality operations run under `landlock-run`, a static launcher that
  limits writes to the selected worktree and per-worktree scratch paths with Landlock and
  seccomp. The plugin ships it prebuilt and reproducible: `native/prebuilt/linux-amd64/landlock-run`
  and `native/prebuilt/linux-arm64/landlock-run`, built from `native/landlock-run.go` by one
  pinned Go toolchain. No project container needs Go or any other toolchain. Before each
  operation the plugin asks the Docker daemon for its architecture, picks the matching binary,
  and installs it to `<primary>/.bb-runtime/landlock-run`. That binary is the host-architecture
  one, so it also runs natively in a container whose image is another architecture. The install
  is verified on every use: it must be a regular file with mode `0555` and the SHA-256 recorded
  in `native/prebuilt/SHA256SUMS`, or the plugin reinstalls it.
  The seccomp filter makes metadata-changing syscalls (`chmod`, `chown`, `utimes`, xattr writes)
  fail with `EPERM`. It first checks the syscall ABI: a foreign-ABI syscall (i386, x32, AArch32)
  is killed with `SIGSYS` (exit 159), so 32-bit tools cannot run under the launcher. Exit 159
  under `landlock-run` means a 32-bit (foreign-ABI) binary was killed. The metadata guard is
  best-effort, not complete: for example, `io_uring` xattr operations are not covered. Landlock
  is what confines writes.
- **Trust anchors.** The manifest describes *what* a project can do. The host registry under
  `~/.bb/shared-runtime/projects/<projectId>.json` records *which* BB project, on *which* host,
  at *which* primary checkout is allowed to do it, and pins the manifest's SHA-256. A manifest
  edited after installation is refused until `bb-shared-runtime sync` re-pins it from the primary
  checkout, so a branch cannot grant itself new operations.
- **Launcher trust.** `native/prebuilt/SHA256SUMS` is the one record of build provenance: the
  pinned `toolchain` image (tag plus multi-platform index digest), the digest of
  `native/landlock-run.go`, and the digest of each binary. The check at run time catches
  corruption of the bundled or installed binary. It does not catch tampering by someone who
  can edit both a binary and `SHA256SUMS`. That is the job of the build-and-verify gate:
  `npm test`, which CI and the release run, first rebuilds both binaries with the pinned
  toolchain in Docker and fails if they differ from `SHA256SUMS` or from the committed
  files, so a swapped binary cannot be published.

## Requirements

- A Docker engine whose `docker version -f '{{.Server.Arch}}'` reports `amd64` or `arm64`.
  Any other architecture is denied.
- Git in the container you use for `isolation_self_test` (see `isolation.probe` below). No other
  operation needs Git, and no container needs a language toolchain for the launcher.

## Installing in a repository

1. Commit `.bb-runtime.json` at the repository root (schema below).
2. Make sure the repository's Compose stack mounts the BB worktree root into each container the
   manifest declares. `bb-shared-runtime compose-overlay` prints an overlay file you can commit
   and pass as a second `-f` to `docker compose`; `bb-shared-runtime env` prints the exports it
   needs.
3. From the primary checkout run:

   ```sh
   node /path/to/bb-plugin-shared-runtime/bin/bb-shared-runtime.mjs install
   ```

   This resolves the BB project and host from `bb project list`, derives container names from
   the Compose project, writes the registry entry, and installs or reloads the plugin.
   Pass `--manifest /absolute/path/to/manifest.json` when a trusted updater owns the manifest
   outside the repository.
4. Run `bb-shared-runtime doctor` to verify the registration, manifest hash, containers, and
   mounts. Run `bb-shared-runtime validate` on any checkout to check a manifest without touching
   the registry.

Repeat step 3 on each host. Nothing else is per project. `bb-shared-runtime list` shows every
registered project; `bb-shared-runtime uninstall` removes one.

## Manifest reference (`.bb-runtime.json`, version 1)

```json
{
  "version": 1,
  "name": "Example",
  "compose": { "envFile": "docker/dev/.env", "projectVariable": "PROJECT" },
  "lifecycle": {
    "ensure": ["bash", "scripts/up.sh"],
    "recreate": ["bash", "scripts/up.sh", "--override"],
    "stop": ["bash", "scripts/down.sh"]
  },
  "worktrees": { "containerRoot": "/bb-worktrees" },
  "search": { "defaultPath": "src" },
  "containers": {
    "api": {
      "service": "api",
      "root": "src/api",
      "mounts": [
        { "host": ".", "container": "${primaryRoot}" },
        { "host": "src/api", "container": "/srv/api" }
      ]
    }
  },
  "scratch": { "go-cache": { "env": ["GOCACHE"] } },
  "dependencies": [
    { "path": "src/api/vendor", "link": "/srv/api/vendor" },
    { "path": "src/web/apps/*/node_modules", "mirror": "/app/apps/*/node_modules", "local": [".vite"] }
  ],
  "operations": {
    "api_static": { "container": "api", "argv": ["bin/stan"] },
    "api_unit": {
      "container": "api",
      "argv": ["bin/unit", "${target}"],
      "target": { "required": true, "pattern": "^[a-z][a-z0-9/_-]*$" }
    },
    "api_full": { "steps": ["api_static", "api_unit_all"] }
  },
  "git": {
    "prepareCommit": {
      "generators": [
        {
          "container": "api",
          "cwd": ".",
          "argv": ["php", "scripts/generate-manifest.php", "--modified"],
          "requires": "scripts/generate-manifest.php",
          "stages": ["build/manifest.json"],
          "tolerateMissingExecutable": true
        }
      ],
      "hardlinks": [{ "source": "docs/source.md", "target": "docs/copy.md" }]
    }
  }
}
```

Field notes:

- `containers.<role>.service` is the Compose service; the container name is
  `<composeProject>_<service>` unless `containerName` is given. `mounts` map repository-relative
  host paths to container paths; `"${primaryRoot}"` means the primary checkout is mounted at its
  own absolute host path. `root` is the default working directory for operations, relative to
  the repository.
- `isolation` is optional. Its `probe` names the container used for the built-in
  `isolation_self_test` operation, which needs Git in that container; without Git the self-test
  denies with `isolation_self_test needs git in container "<name>"`. Without `isolation.probe`
  the probe is resolved in this order: `isolation.builder`; the first container that an
  operation uses (operations in declaration order, then a `steps` list's container steps in
  order, then a variant target's variants in declaration order); the container of the first
  `git.prepareCommit` generator. The first declared container is never used, because it could
  be a database. If nothing resolves (for example, a manifest with only host steps), the
  self-test denies with `isolation_self_test needs a probe container; set isolation.probe to a
  container with git`. `isolation.builder` is deprecated: it no longer builds anything, and its
  only remaining effect is to serve as the probe fallback. A name in either field must be a
  declared container.
- `scratch` declares extra per-worktree scratch directories under `/var/tmp`, exported under the
  listed environment variable names and available as `${scratch.<name>}`.
- `dependencies` prepare a fresh worktree before every operation: `link` symlinks a path to a
  shared in-container directory; `mirror` creates a directory of symlinks to the shared source
  with `local` entries kept as writable per-worktree directories. One `*` segment per path is
  expanded against the primary checkout.
- Operations are either a single step or a `steps` list referencing other single-step operations
  or inline steps. A step is a container step (`container`, `cwd`, `argv`, `env`,
  `failOnStdout`) or a host step (`kind: "host"`, an interpreter plus a primary-checkout script,
  `containers` it touches, `env`). `target` declares either an anchored `pattern` (used through
  `${target}`) or `variants` keyed by target value.
- Placeholders in `argv` and `env`: `${root}` (repository root inside the step's container),
  `${cwd}`, `${env}` (environment id), `${envSlug}` (environment id with underscores replaced
  by hyphens), `${tmp}`, `${runtime}` (the plugin's `assets/` copy
  inside the container, for preloads), `${launcher.<role>}`, `${root.<role>}`,
  `${runtime.<role>}`, `${scratch.<name>}`, `${primaryRoot}`, `${hostRoot}`, `${docker}`,
  and `${target}`. Unknown placeholders fail validation.
- `argv[0]` may not be a shell with `-c`, or a script interpreter with `-e`. Host steps must
  start with `bash` or `sh` followed by a repository-relative script that is read from the
  primary checkout, never from the worktree.

### Node copy compatibility preload

The isolation launcher rejects `chmod`, `utimes`, and xattr syscalls with `EPERM`, so Node's
`fs.copyFile`/`fs.cp` fail under confinement because they chmod the destination. An operation
that copies files into scratch from Node can load `${runtime}/node-copy-compat-preload.cjs`. For
destinations under `TMPDIR`/`TMP`/`TEMP` or `BB_NODE_COPY_ROOTS` (a `path.delimiter`-separated
list), it copies by read-and-write with the source mode and skips `chmod`. It does nothing unless
enabled:

```json
"env": {
  "NODE_OPTIONS": "--require=${runtime}/node-copy-compat-preload.cjs",
  "BB_NODE_COPY_COMPAT_COMMANDS": "tsc,tsc.js"
}
```

`BB_NODE_COPY_COMPAT_COMMANDS` patches only the Node processes whose script basename is in the
comma-separated list. `NODE_OPTIONS` is inherited by every child process, so this keeps other
tools untouched. `BB_NODE_COPY_COMPAT=1` patches every Node process.

## Registry reference (`~/.bb/shared-runtime/projects/<projectId>.json`)

Written only by `bb-shared-runtime install` and `sync`, mode 0600 inside 0700 directories. The
plugin refuses entries with other permissions, symlinks, or hard links.

```json
{
  "projectId": "proj_example",
  "trustedHostId": "host_example",
  "primaryRoot": "/Users/me/workspace/example",
  "worktreeRoot": "/Users/me/.bb/worktrees",
  "worktreeDirectoryName": "example",
  "gitCommonDir": "/Users/me/workspace/example/.git",
  "dockerPath": "/opt/homebrew/bin/docker",
  "dockerSocket": "/Users/me/.colima/default/docker.sock",
  "composeProject": "example_dev",
  "containers": { "worker": "example_dev_worker", "web": "example_dev_web", "api": "example_dev_api" },
  "manifestSha256": "…",
  "bbCli": "/Applications/bb.app/…/bb"
}
```

## Development

```sh
npm test            # builds and verifies the prebuilt launcher, then runs the suite (needs Docker)
npm run test:coverage
```

The suite covers workspace mapping, plan compilation from the example fixture manifest,
target validation, isolation probes, dependency preparation, the reader-writer project locks
(including the shell reload helper), agent configuration, registry loading, thread reads, and
the CLI's registry-free commands.

### Rebuilding the launcher

After editing `native/landlock-run.go`, or to change the Go toolchain on the `toolchain` line of
`native/prebuilt/SHA256SUMS`, run:

```sh
sh build/launcher.sh build
```

It runs the pinned `golang` image in Docker (no network, source mounted read-only) with
`CGO_ENABLED=0`, `GOTOOLCHAIN=local`, `-trimpath`, `-buildvcs=false`, and a stripped, buildid-free
link, for both architectures. It then rewrites the `source` and binary lines of
`native/prebuilt/SHA256SUMS`. Commit the binaries and `SHA256SUMS` together with the source.
`sh build/launcher.sh verify` first runs the Go tests in `native/landlock-run_test.go` in the same
pinned image (no network, read-only mounts), then rebuilds into a temporary directory and compares
the result with `SHA256SUMS` and with the committed binaries; `npm test` runs it first. When you change the
toolchain, update the version named in `THIRD_PARTY_NOTICES.md` and its Go license text from
the new image. Both files are maintainer tools and notices, not shipped code:
`build/` is not in the npm tarball, and `THIRD_PARTY_NOTICES.md` is.
