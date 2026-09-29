# bb-plugin-aislop

Runs the [aislop](https://www.npmjs.com/package/aislop) quality scan from bb as
`bb aislop scan`, scoped by default to what the current branch changed against its
root branch.

## How it works

- The server resolves where to scan: inside a thread, the thread environment's
  machine and the caller's current directory, plus bb's root branch for that
  environment; from a plain terminal, the server's own machine.
- A `bb.host` entry runs on that machine. It resolves the diff base with git and runs
  `npx --yes aislop@latest scan`. aislop's own `--base` diffs against the ref's
  tip, so the branch scope passes it `git merge-base HEAD <root>` instead. Changes
  that landed on the root after the fork stay out of the report.
- Scopes: `branch` (default), `changes` (uncommitted vs `HEAD`), `staged`, `all`.
  See [the skill](skills/aislop/SKILL.md) for every flag.

## Install

```sh
bb plugin install npm:@lettland/bb-plugin-aislop
# or from this repo
bb plugin install git:https://github.com/lettland/bb-plugins.git --plugin aislop
```

Needs `git` and `npx` on the machine that runs the scan.
