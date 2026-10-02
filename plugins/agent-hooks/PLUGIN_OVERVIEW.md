# Agent hooks

bb owns the tool-call safety hooks. Providers only execute them.

## Why the split is shaped this way

bb cannot run these itself. Its only veto checkpoint is
`experimental_hooks.on("message.dispatch")` — *message* admission — and `bb.events`
handlers are documented as fire-and-forget that "can never block or veto". There is
no tool-call hook in the Plugin SDK, and `contributeEnv` only sets environment
variables. Redirecting `CLAUDE_CONFIG_DIR` would move an entire provider profile
including its auth, which is not on the table.

So a hook runs only if the provider's own config references it. **That pointer is
irreducible.** Everything else stays on bb's side:

- no plugin is installed into any provider's plugin manager
- no marketplace entry
- no file is copied into a provider directory
- every script lives under `~/.bb/agent-hooks/`, owned by bb
- provider configs gain only *pointer entries* into that directory
- `bb agent-hooks uninstall` removes them and leaves nothing behind

`bb agent-hooks status` reports config drift and hook liveness. It does not observe
hook execution, because bb never sees it.

## Commands

| Command | What it does |
|---|---|
| `bb agent-hooks install [--provider <id>] [--dry-run]` | Sync scripts to `~/.bb/agent-hooks`, then wire each provider config. `--dry-run` prints the diff and writes nothing. |
| `bb agent-hooks status [--provider <id>] [--probe]` | Per-provider entry counts plus script drift. `--probe` additionally proves each hook responds. |
| `bb agent-hooks uninstall [--provider <id>]` | Remove only our entries. Scripts stay in the install dir. |
| `bb agent-hooks log [--limit <n>]` | Recent firings from the current project's `.claude/logs/incident-log.md`. |

Providers: `claude-code` (`~/.claude`), `claude-work` (`~/.claude-work`), `codex`
(`~/.codex`, wired through `codex-shim.sh`).

## The hooks

| Script | Event | Job |
|---|---|---|
| `guard-bash.sh` | PreToolUse(Bash) | Catastrophic `rm`, force push, secret exfiltration, environment dumps |
| `secret-scan.sh` | PreToolUse(Write\|Edit) | Refuses to write a credential into a file that could be committed |
| `review-plan-before-exit.sh` | PreToolUse(ExitPlanMode) | Denies a plan's first presentation until it has been reviewed — in plan mode, defers to auto-review's own plan gate where it already owns the review (`bb auto-review status --json` reports `planGate: true`) |
| `verify-before-stop.sh` | Stop, SubagentStop | Blocks one stop when this turn's tool output shows an unresolved failure |
| `session-reset.sh` | SessionStart | Prunes stale plan-review gates so a crashed session cannot deadlock the next |

Deferring to auto-review is not a guarantee a review happens: auto-review's own plan gate
can itself release a plan unreviewed on its own failure (queue failed, deny failed, hold
went stale — each recorded as a reason in `bb auto-review status`'s `lastFire`). The hook's
deny+arm only falls back when reading `planGate` itself fails; it does not re-check whether
auto-review's review actually ran.

## Two design rules worth not re-litigating

**Gitignore status decides where secrets may be written**, not the file's name. Both
`guard-bash.sh` and `secret-scan.sh` run `git check-ignore` on the destination. This
is better than the old `*.env*` name match in both directions: a secret written to a
tracked `config.yml` used to be caught only by pattern, and one written to a `.env`
that nobody had gitignored was waved through on the name alone. Every failure mode —
no git, no repo, an error, a path outside the tree — falls back to the name-based
rule, so it **fails closed**.

**`rm` detection asks "is any token an rm?", never "what is the command?"** Resolving
a command word regresses `sudo -u root rm` (the `-u` value gets eaten), `/bin/rm`,
`command rm`, `busybox rm` and `find -exec rm`. The token test is strictly narrower
than a substring scan, so it cannot widen the gate; the only thing it newly exempts
is a flag like docker's `--rm`.

## Tests

```sh
npm test            # corpora + directional check + unit tests
npm run test:corpus # the two hook corpora only
npm run baseline    # re-record the pre-change baseline
npm run checksums   # regenerate hooks/CHECKSUMS after editing a script
```

`tests/verify-no-regression.mjs` is the one that matters. "All cases pass" is not the
property being protected — the property is that every case which moved, moved from
wrong to right, and nothing that was already correct became wrong. A fix that
loosened a catastrophic block while satisfying its own new corpus line would pass a
plain run and fail this one.

Secret strings in `tests/secret-scan/` are assembled at runtime from fragments. A
secret scanner's corpus necessarily contains secret-shaped text, so literal fixtures
trip the very gate under test.

## Editing a hook

Edit it in `hooks/`, run `npm run checksums`, run `npm test`. The install dir is
re-synced on the next plugin load. Hand-editing `~/.bb/agent-hooks/` is not
supported — sync will overwrite it, and will log a warning naming the file when it
does.

`hooks/CHECKSUMS` is verified before anything is overwritten. These scripts decide
whether arbitrary Bash runs and the plugin installs from a git ref, so a tampered or
truncated script must not be able to become the live guard silently.
