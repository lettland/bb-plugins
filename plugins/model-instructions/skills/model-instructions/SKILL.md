---
name: model-instructions
description: "Change the custom instructions and skills bb adds to threads by provider, model, project (including skipping projects), directory scope, and top-level vs child thread (the model-instructions plugin's rules, edited in its settings form)."
---

# Model instructions

The `model-instructions` plugin adds instructions and skills to a thread when its
provider, model, project, directory, and thread position match a rule. Rules live
in the model-instructions plugin's saved config, an object of `vars`, `scopes` and `rules`, edited in Settings → Plugins → Model instructions. Every matching rule applies, in array order.

```json
{
  "vars": {},
  "scopes": [],
  "rules": [
    {
      "provider": "claude-code",
      "model": "claude-opus-5-5*",
      "threads": "top-level",
      "instructions": ["line one", "line two"]
    }
  ]
}
```

| Field | Required | Meaning |
|---|---|---|
| `provider` | no | Provider id glob (`claude-code`, `codex`). Omit to match every provider. |
| `model` | no | Model id glob. `*` matches any run of characters; nothing else is special. End with `*` to also match suffixed ids such as `claude-opus-5-5[1m]`. Omit to match every model. |
| `project` | no | bb project name glob (`bb-plugins`, `opshub-*`) or an array of globs; any match counts. Case-sensitive, with `*` as the only special character. Renaming a project stops its rules matching. Omit to match every project. |
| `skipProjects` | no | A project name glob or an array of globs; any match excludes the project, and wins over `project`. Case-sensitive, so renaming a skipped project (or getting its case wrong) makes the rule apply to it again. Omit to skip nothing. |
| `skipTitles` | no | A thread title glob or an array of globs; any match excludes the thread, and a thread with no title is never skipped. The title is read at each turn, so renaming a thread changes whether the rule applies. Case-sensitive, with `*` as the only special character. Omit to skip nothing. |
| `threads` | no | `any` (default), `top-level` (no parent thread), or `child` (spawned with a parent thread). |
| `name` | no | 1–128 characters, unique among the rules. Names the rule in `status`, `check`, logs and overflow events; otherwise it is `rules[<index>]`. |
| `scope` | no | A scope name glob or an array of globs. The rule matches only while a scope with a matching name is active (see Scopes). |
| `skills` | no | A bundled skill name glob or an array of globs; matching skills are injected into every thread the rule matches (see Skills). |
| `instructions` | no | A string, or an array of lines joined with newlines. A rule needs `instructions`, `skills`, or both. |

Example: everything except a few projects:

```json
{
  "vars": {},
  "scopes": [],
  "rules": [
    {
      "skipProjects": ["opshub-legacy", "sandbox-*"],
      "instructions": "Run the project's tests before reporting done."
    }
  ]
}
```

Combine with `project` to narrow to a set first, e.g. `"project": ["opshub-*", "bb-*"], "skipProjects": "opshub-legacy"`; skip wins.

Example: child rule that skips helpdesk threads by title:

```json
{
  "vars": {},
  "scopes": [],
  "rules": [
    {
      "threads": "child",
      "skipTitles": ["Helpdesk: *", "Helpdesk catch-up *"],
      "instructions": "You are an implementation worker. Do exactly what the brief asks."
    }
  ]
}
```

The match uses the thread title at each turn. A thread with no title is never skipped.

## Variables

The config can also name reusable values (`vars`), so the same
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
  (after an array of lines is joined). `{{name}}` is replaced by the var value.
- In the object form `rules` is required; `vars` (default `{}`) and `scopes` are
  optional. No other top-level keys are allowed.
- Var names are letters, digits, `_`, `-`, starting with a letter. Any other
  name, including `__proto__`, is rejected on save.
- Values are inserted exactly as written (no trimming) and must not be blank.
  `{{...}}` inside a value is not expanded again.
- A `{{name}}` with no matching var is rejected on save; the error names the
  rule index and the var.
- To keep a literal `{{name}}` in object-form text, define the var as itself,
  for example `"name": "{{name}}"`.
- The 4096-character limit (see Budget) applies to the expanded text.
- Var values become part of the instructions sent to the model provider. Do
  not put secrets or personal data in them.
- Text that does not match `{{name}}` exactly (for example `{{ x }}` with
  spaces, or a single `{`) stays as written.
- The plain array form keeps working unchanged: its text is never substituted,
  so an existing `{{name}}` there stays as written.

## Scopes

A scope names a set of directories. In the object form, `"scopes": [{ "name": "work", "paths": ["~/workspace/work"] }]`
(1–16 absolute or `~/` paths each, at most 32 scopes, names unique, 1–128 characters).
A rule with `"scope": "work"` (a glob or an array of globs over scope names) matches
only while a matching scope is active: the thread's environment path, or any checkout
path of its project, is inside one of the scope's paths (symlinks resolved).
A rule without `scope` matches in every directory.

## Skills

A rule's `skills` globs claim bundled skills by name. A thread gets `model-instructions`
(always) plus every skill claimed by a rule that matches it, once each. A bundled skill that
no rule claims is injected nowhere; `*` never lists `model-instructions` twice. Skills are
never dropped for the character limit.

## Claude profiles

`~/.bb/model-instructions/profiles.json` is `{ "scopes": [ { "name", "paths", "claudeConfigDir" } ] }`
(strict, same name and path rules as scopes). A profile scope is a full scope, so rules can name it
in `scope`, and Claude Code threads whose project has a checkout under it start with
`CLAUDE_CONFIG_DIR` set to its directory. A saved scope with the same name is ignored (shown in
`status` and `check`): the file decides, never the saved config. A thread's profile is pinned at its first
turn; an existing pin is always served, even if the file is absent or malformed, and a new pin is
written only while the file is valid. `bb model-instructions setup [--dry-run] [--json]` creates the
file when absent, `unpin [<thread-id>]` forgets a pin, and `import-dir-skills [--dry-run] [--json]`
moves dir-skills scopes, skill claims and pins over (run `bb dir-skills export` first). See the README.

## Budget

bb cuts a plugin's instructions at 4096 characters per thread, without a warning.

- A save is rejected when: two rules have the same `name`; a `scope` glob matches no defined scope; a `skills` glob
  matches no bundled skill; one rule's expanded `instructions` exceed 4096 characters; or any
  known thread type (every provider × model, top-level and child, every project with its
  checkout paths, and no project) would get more than 4096 characters, `\n\n` separators
  included. The error groups thread types by the rules they match: 5 longest per group,
  then `and <n> more`.
- If the provider/model list or project list has not loaded, a save with instruction text is rejected with
  `budget not checkable yet: <provider list|project list> not loaded; retry after the next refresh (every minute), or see bb model-instructions status`;
  if its last refresh failed, with `... <provider list|project list> refresh failed; retry ...` (same ending).
  A provider whose models cannot be listed does not fail the list: it is left out and shown as
  unchecked by `status` and `check --all`. If every available provider is unchecked, the save is rejected with
  `budget not checkable yet: no provider's models could be listed (<id> (<reason>), ...); see bb model-instructions status`.
- The save check covers threads whose scope match comes from a project's checkouts. A thread whose environment directory (for example a worktree) is inside a scope while its project's checkouts are not, a provider listed as unchecked, and a model that appears only in a workspace-scoped model catalog are not covered; for those, the runtime fallback applies (whole rules dropped from the end, with the notice).
- When the matched text is over the limit, the budget for kept rules is 4096 minus the notice; a very long first rule (close to 4096) can then be dropped too, leaving only the notice. Keep guard rules short and first.
- A stored value is never rejected for these reasons on load: an unknown `scope` or `skills`
  glob matches nothing and logs one warning per rule.
- At runtime a thread type that was not known on save loses whole rules, never part of one:
  rules are added in array order, and the first one that does not fit and every later one are
  dropped, with `[model-instructions: <n> rule(s) omitted: over the 4096-character limit; tell the user to run bb model-instructions status]`
  appended. Put role and guard rules first.

## Inspect

```sh
bb model-instructions status [--json]
bb model-instructions check [--provider P] [--model M] [--child | --top-level] [--project <id>] [--path <dir>] [--title T] [--json]
bb model-instructions check --all [--json]
```

`status` lists scopes, rules, bundled skills and the rules that claim them (and the unclaimed
ones), the cache state, unchecked providers with their reason, thread types over budget, and
recent overflow events; a `scope` or `skills` glob that matches nothing is marked under its rule.
`check` shows the matched rules, length out of 4096, dropped rules and skills for one thread;
inside a bb thread it defaults provider, model, role, title, project and path from that thread and
prints what it defaulted. `--child` and `--top-level` force the role (both together is a usage
error). `check --all` prints the save-time budget table and the unchecked providers. `status` also shows
the state of profiles.json, the profile scopes, ignored saved scopes and the pin count; `check`
adds the Claude profile decision and the calling thread's pin.

## Read and change the rules

```sh
bb model-instructions export > rules.json   # read the saved config
bb model-instructions import rules.json     # replace it after editing (same checks as the form)
```

Prefer asking the user to make the change in the settings form; use export → edit → import only when asked to change rules yourself.

`import` takes the object form or an array of rules (the form of versions up to 0.1.11). A config that is not valid JSON or does not match the shape above is rejected on
import. Changes need no plugin reload; new threads get them, while a running
thread may keep its old instructions until its provider session restarts.
List model ids with `bb provider models <provider>` and project names with
`bb project list --include-personal`.

## Constraints

- The combined instructions for one thread are limited to 4096 characters: the save check rejects a config that exceeds it for a known thread type, and at runtime whole rules are dropped (see Budget).
- Side chats never receive plugin instructions.
- An older plugin version (0.1.11 or earlier) reads the old `rules` setting, not the saved config; see the README's "Upgrading from 0.1.11" section before downgrading.
- Instructions only guide the model; they do not enforce anything. To stop Claude
  Code delegating through its own Task tool instead of bb threads, turn on the
  Claude Code provider's "Disable provider subagents" setting.
