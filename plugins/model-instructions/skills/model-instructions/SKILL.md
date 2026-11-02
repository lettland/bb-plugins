---
name: model-instructions
description: "Change the custom instructions bb adds to threads by provider, model, project (including skipping projects), and top-level vs child thread (the model-instructions plugin's rules setting)."
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
| `project` | no | bb project name glob (`bb-plugins`, `opshub-*`) or an array of globs; any match counts. Case-sensitive, with `*` as the only special character. Renaming a project stops its rules matching. Omit to match every project. |
| `skipProjects` | no | A project name glob or an array of globs; any match excludes the project, and wins over `project`. Case-sensitive, so renaming a skipped project (or getting its case wrong) makes the rule apply to it again. Omit to skip nothing. |
| `threads` | no | `any` (default), `top-level` (no parent thread), or `child` (spawned with a parent thread). |
| `instructions` | yes | A string, or an array of lines joined with newlines. |

Example: everything except a few projects:

```json
[
  {
    "skipProjects": ["opshub-legacy", "sandbox-*"],
    "instructions": "Run the project's tests before reporting done."
  }
]
```

Combine with `project` to narrow to a set first, e.g. `"project": ["opshub-*", "bb-*"], "skipProjects": "opshub-legacy"`; skip wins.

## Variables

The setting can also be a JSON object that names reusable values, so the same
flags need not repeat in every rule:

```json
{
  "vars": {
    "implSmall": "--provider claude-code-glm --model 'glm-5.3-flash[1m]' --reasoning-level medium",
    "implHeavy": "--provider claude-code-glm --model 'glm-5.3[1m]' --reasoning-level high"
  },
  "rules": [
    {
      "threads": "top-level",
      "instructions": "Small change: spawn `bb thread spawn --parent-self {{implSmall}} --prompt-file <brief>`. Heavy change: use {{implHeavy}}."
    }
  ]
}
```

- Substitution happens only in the object form, and only inside `instructions`
  (after an array of lines is joined). `{{name}}` is replaced by the var value;
  var names are letters, digits, `_`, `-`, starting with a letter.
- A `{{name}}` with no matching var is rejected on save, naming the var. Var
  names must match that shape and values must be non-empty strings.
- Values are literal: `{{...}}` inside a value is not expanded again.
- Text that does not match `{{name}}` exactly (for example `{{ x }}` with
  spaces, or a single `{`) stays as written.
- The plain array form keeps working unchanged: its text is never substituted,
  so an existing `{{name}}` there stays as written.

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
- After saving rules that use `skipProjects` (in any form) or an array `project`, an older plugin version rejects the whole setting and applies no rules.
- After saving the object form (`vars` + `rules`), an older plugin version rejects the whole setting and applies no rules.
- Instructions only guide the model; they do not enforce anything. To stop Claude
  Code delegating through its own Task tool instead of bb threads, turn on the
  Claude Code provider's "Disable provider subagents" setting.
