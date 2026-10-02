# bb-plugin-agent-hooks

Tool-call safety hooks for Claude Code and Codex, owned by bb. The scripts live under
`~/.bb/agent-hooks/`; each provider's config gains only pointer entries into that
directory. Providers execute the hooks, bb installs, updates, audits and removes them.

bb's Plugin SDK has no tool-call veto, so a hook runs only if the provider's own config
references it. Nothing is installed into a provider's plugin manager and no file is
copied into a provider directory. See [PLUGIN_OVERVIEW.md](PLUGIN_OVERVIEW.md) for the
full rationale.

## The hooks

| Script | Event | Job |
|---|---|---|
| `guard-bash.sh` | PreToolUse(Bash) | Blocks catastrophic `rm` (system paths, a home directory or its direct children), force push, secret exfiltration, environment dumps |
| `secret-scan.sh` | PreToolUse(Write\|Edit) | Refuses to write a credential into a file that could be committed |
| `review-plan-before-exit.sh` | PreToolUse(ExitPlanMode) | Denies a plan's first presentation until it has been reviewed — in plan mode, defers to auto-review's own plan gate where it already owns the review (`bb auto-review status --json` reports `planGate: true`) |
| `verify-before-stop.sh` | Stop, SubagentStop | Blocks one stop when this turn's tool output shows an unresolved failure |
| `session-reset.sh` | SessionStart | Prunes stale plan-review gates so a crashed session cannot deadlock the next |

The home `rm` rule reads depth from the literal target. A home directory, its
direct children, any `.`/`..` segment, a glob (`*`, `?`, `[`, `{`) in the first
two segments (`~/*/*`, `~/workspace/*`), and anything under `~/.ssh`, `~/.gnupg`
or `~/.aws` are hard-blocked. Deeper files are allowed; deeper `rm -r` gets the
recursive soft block. Heredoc bodies and `-m` messages are scanned like argv, so
prose that says rm next to a home path is blocked too: use `git commit -F <file>`.

`codex-shim.sh` bridges Codex's hook environment (which lacks `CLAUDE_PROJECT_DIR`) to these scripts.

Deferring to auto-review is not a guarantee a review happens: auto-review's own plan gate
can itself release a plan unreviewed on its own failure (its review could not be queued,
its deny failed, its hold went stale — each recorded as a reason in
`bb auto-review status`'s `lastFire`). The hook's deny+arm only falls back when reading
`planGate` itself fails (`bb` missing, a non-zero exit, bad output, a timeout); it does not
re-check whether auto-review's review actually ran.

## Commands

| Command | What it does |
|---|---|
| `bb agent-hooks install [--provider <id>] [--dry-run]` | Sync scripts to `~/.bb/agent-hooks`, then wire each provider config. `--dry-run` prints the diff and writes nothing. |
| `bb agent-hooks status [--provider <id>] [--probe]` | Per-provider entry counts plus script drift. `--probe` also proves each hook responds. |
| `bb agent-hooks uninstall [--provider <id>]` | Remove only this plugin's entries. Scripts stay in the install dir. |
| `bb agent-hooks log [--limit <n>]` | Recent firings from the current project's `.claude/logs/incident-log.md`. |

Providers: `claude-code` (`~/.claude/settings.json`), `claude-work`
(`~/.claude-work/settings.json`), `codex` (`~/.codex/hooks.json`, wired through
`codex-shim.sh`).

Codex runs a `hooks.json` hook only when `~/.codex/config.toml` trusts it, and that
trust is keyed by the hook's position. After every `hooks.json` write, install and
uninstall ask Codex (`codex app-server`, `hooks/list`) for the new keys and hashes.
Then they re-key `[hooks.state]`. Our exact commands are trusted, and so is any
neighbour whose hash was already trusted; nothing else is. `status` reports what
Codex actually trusts. If no Codex binary answers, this step is skipped
(`CODEX_BIN` picks one).

## How updates reach the hooks

Every plugin load verifies `hooks/CHECKSUMS` and re-syncs changed scripts into
`~/.bb/agent-hooks/`, so an auto-update takes effect without re-running `install`. A
tampered or truncated script fails the checksum and the installed copies are left
untouched. A locally modified installed script is overwritten and named in a warning
(`bb plugin logs agent-hooks`).

Provider configs are never touched on load. Wiring them is always an explicit
`bb agent-hooks install`.

## Install

```sh
bb plugin install npm:@lettland/bb-plugin-agent-hooks
bb agent-hooks install --dry-run   # review the config changes
bb agent-hooks install
bb agent-hooks status --probe
```

## Development

```sh
npm install --include=dev --legacy-peer-deps
npm test            # hook corpora + directional regression check + unit tests
npm run test:corpus # the two hook corpora only
npm run baseline    # re-record the pre-change baseline
npm run checksums   # regenerate hooks/CHECKSUMS after editing a script
```

To change a hook, edit it in `hooks/`, run `npm run checksums`, then `npm test`.
`tests/verify-no-regression.mjs` requires every case that changed verdict to have moved
from wrong to right; a fix that loosens a catastrophic block fails it even when its own
new corpus line passes.
