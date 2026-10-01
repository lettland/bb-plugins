---
name: model-instructions
description: "Change the custom instructions bb adds to threads by provider, model, project, and top-level vs child thread (the model-instructions plugin's rules setting)."
---

# Model instructions

The `model-instructions` plugin adds instructions to a thread when its provider,
model, project, and thread position match a rule. Rules live in one plugin setting,
`rules`, a JSON array. Every matching rule applies, in array order.

```json
[
  {
    "provider": "claude-code",
    "model": "claude-opus-5-5*",
    "threads": "top-level",
    "instructions": ["line one", "line two"]
  }
]
```

| Field | Required | Meaning |
|---|---|---|
| `provider` | no | Provider id glob (`claude-code`, `codex`). Omit to match every provider. |
| `model` | no | Model id glob. `*` matches any run of characters; nothing else is special. End with `*` to also match suffixed ids such as `claude-opus-5-5[1m]`. Omit to match every model. |
| `project` | no | bb project name glob (`bb-plugins`, `opshub-*`), case-sensitive, with `*` as the only special character. Renaming a project stops its rules matching. Omit to match every project. |
| `threads` | no | `any` (default), `top-level` (no parent thread), or `child` (spawned with a parent thread). |
| `instructions` | yes | A string, or an array of lines joined with newlines. |

## Read and change the rules

```sh
bb plugin config model-instructions                      # show the current value
bb plugin config model-instructions set rules "$(cat rules.json)"
bb plugin config model-instructions unset rules          # back to [] (no instructions)
```

A value that is not valid JSON or does not match the shape above is rejected on
write. Changes need no plugin reload; new threads get them, while a running
thread may keep its old instructions until its provider session restarts.
List model ids with `bb provider models <provider>` and project names with
`bb project list --include-personal`.

## Constraints

- The combined instructions for one thread are truncated to 4096 characters.
- Side chats never receive plugin instructions.
- Instructions only guide the model; they do not enforce anything. To stop Claude
  Code delegating through its own Task tool instead of bb threads, turn on the
  Claude Code provider's "Disable provider subagents" setting.
