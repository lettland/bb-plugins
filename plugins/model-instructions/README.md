# bb-plugin-model-instructions

Custom instructions per provider, model, and project for bb. bb's built-in
"Custom instructions" setting applies to every thread; this plugin adds
instructions only to threads whose provider, model, project, and position
(top-level or child thread) match a rule.

## Rules

One plugin setting, `rules`, holds a JSON array. Every matching rule applies, in
array order.

| Field | Required | Meaning |
|---|---|---|
| `provider` | no | Provider id glob (`claude-code`, `codex`). Omit to match every provider. |
| `model` | no | Model id glob. `*` matches any run of characters; nothing else is special. End with `*` to also match suffixed ids such as `claude-opus-5-5[1m]`. Omit to match every model. |
| `project` | no | bb project name glob (`bb-plugins`, `opshub-*`), case-sensitive, with `*` as the only special character. Renaming a project stops its rules matching. Omit to match every project. |
| `threads` | no | `any` (default), `top-level` (no parent thread), or `child` (spawned with a parent thread). |
| `instructions` | yes | A string, or an array of lines joined with newlines. |

Set it in the plugin's settings, or from the CLI:

```sh
bb plugin config model-instructions set rules "$(cat rules.json)"
```

An invalid value is rejected on write. `bb provider models <provider>` lists
model ids; `bb project list --include-personal` lists project names.

## Example: Opus supervises, Sonnet implements

```json
[
  {
    "provider": "claude-code",
    "model": "claude-opus-5-5*",
    "threads": "top-level",
    "instructions": [
      "You are the planner and supervisor for this thread. Plan, review, and talk to the user here; do not write implementation code yourself.",
      "Hand each implementation step to a Sonnet worker thread in this thread's environment:",
      "1. Write a self-contained brief (goal, files, constraints, how to verify) to a file.",
      "2. Spawn the worker: `bb thread spawn --parent-self --environment <this thread's environment id from bb status> --provider claude-code --model claude-sonnet-5-5 --prompt-file <brief>`.",
      "3. `bb thread wait <id>`, then read `bb thread output <id>` and review the diff yourself.",
      "4. Send corrections with `bb thread tell <id> <message>` until the step is right."
    ]
  },
  {
    "provider": "claude-code",
    "model": "claude-sonnet-5-5*",
    "threads": "child",
    "instructions": "You are an implementation worker. Do exactly what the brief asks, run its verification, and end with a short report of what changed and what you checked."
  }
]
```

## Constraints

- The combined instructions for one thread are truncated to 4096 characters.
- Side chats never receive plugin instructions.
- A `threads: child` rule also reaches devkit `review-code`'s lens and closure-review threads,
  since those are ordinary bb child threads. That skill's review-only brief asks the reviewer to
  ignore whatever this plugin injects into them — a prompt-level ask, not an enforced one (see
  the next bullet).
- Instructions guide the model; they do not enforce anything. Claude Code can
  still delegate through its own Task tool instead of bb threads; the Claude
  Code provider's "Disable provider subagents" setting hides that tool.
