# bb-plugin-model-instructions

Custom instructions per provider, model, and project for bb. bb's built-in
"Custom instructions" setting applies to every thread; this plugin adds
instructions only to threads whose provider, model, project, and position
(top-level or child thread) match a rule.

## Rules

One plugin setting, `rules`, holds a JSON array of rules, or an object
`{ "vars"?: {...}, "scopes"?: [...], "rules": [...] }` (see Variables and Scopes).
Every matching rule applies, in array order.

| Field | Required | Meaning |
|---|---|---|
| `provider` | no | Provider id glob (`claude-code`, `codex`). Omit to match every provider. |
| `model` | no | Model id glob. `*` matches any run of characters; nothing else is special. End with `*` to also match suffixed ids such as `claude-opus-5-5[1m]`. Omit to match every model. |
| `project` | no | bb project name glob (`bb-plugins`, `opshub-*`) or an array of globs; any match counts. Case-sensitive, with `*` as the only special character. Renaming a project stops its rules matching. Omit to match every project. |
| `skipProjects` | no | A project name glob or an array of globs; any match excludes the project, and wins over `project`. Case-sensitive, so renaming a skipped project (or getting its case wrong) makes the rule apply to it again. Omit to skip nothing. |
| `skipTitles` | no | A thread title glob or an array of globs; any match excludes the thread, and a thread with no title is never skipped. The title is read at each turn, so renaming a thread changes whether the rule applies. Case-sensitive, with `*` as the only special character. Omit to skip nothing. |
| `threads` | no | `any` (default), `top-level` (no parent thread), or `child` (spawned with a parent thread). |
| `name` | no | 1–128 characters. Names the rule in `status`, `check`, logs and overflow events; a rule without a name is `rules[<index>]`. |
| `scope` | no | A scope name glob or an array of globs (see Scopes). The rule matches only while a scope with a matching name is active for the thread. Omit to match every directory. |
| `skills` | no | A bundled skill name glob or an array of globs (see Skills). Matching skills are injected into every thread the rule matches. |
| `instructions` | no | A string, or an array of lines joined with newlines. A rule needs `instructions`, `skills`, or both. |

Set it in the plugin's settings, or from the CLI:

```sh
bb plugin config model-instructions set rules "$(cat rules.json)"
```

An invalid value is rejected on write. `bb provider models <provider>` lists
model ids; `bb project list --include-personal` lists project names.

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
  (after an array of lines is joined). `{{name}}` is replaced by the var value.
- In the object form `rules` is required; `vars` (default `{}`) and `scopes`
  (default none) are optional. No other top-level keys are allowed.
- Var names are letters, digits, `_`, `-`, starting with a letter. Any other
  name, including `__proto__`, is rejected on save.
- Values are inserted exactly as written (no trimming) and must not be blank.
  `{{...}}` inside a value is not expanded again.
- A `{{name}}` with no matching var is rejected on save; the error names the
  rule index and the var.
- To keep a literal `{{name}}` in object-form text, define the var as itself,
  for example `"name": "{{name}}"`.
- The 4096-character limit (see Instruction budget) applies to the expanded text.
- Var values become part of the instructions sent to the model provider. Do
  not put secrets or personal data in them.
- Text that does not match `{{name}}` exactly (for example `{{ x }}` with
  spaces, or a single `{`) stays as written.
- The plain array form keeps working unchanged: its text is never substituted,
  so an existing `{{name}}` there stays as written.

## Scopes

A scope is a name for a set of directories. A rule with `scope` matches only
when a scope whose name matches one of its globs is active. Scopes are defined
in the object form:

```json
{
  "scopes": [{ "name": "work", "paths": ["~/workspace/work", "/srv/work"] }],
  "rules": [
    { "name": "gchat", "provider": "claude-code", "scope": "work", "instructions": "Use the work chat tools." }
  ]
}
```

- `name`: 1–128 characters, unique, no control characters. `paths`: 1–16 entries,
  each absolute or starting with `~/`, at most 1024 characters. At most 32 scopes.
  No other keys.
- A scope is active for a thread when the thread's environment path, or any
  checkout path of its project, is inside one of the scope's paths. Symlinks are
  resolved on both sides, so a link into the tree counts. A path that does not
  exist yet is used as written.
- The array form has no `scopes`; a `scope` rule there matches a scope only if
  another source defines it.
- A rule with no `scope` matches in every directory. All other matchers
  (`provider`, `model`, `project`, `skipProjects`, `skipTitles`, `threads`) work
  as before and must match too.

## Skills

The plugin ships the `skills/` directory. A rule's `skills` globs claim bundled
skills by name, and a thread gets every skill claimed by a rule that matches it:

```json
{ "name": "work-skills", "scope": "work", "skills": ["work-*"] }
```

- `model-instructions` is always injected and is never matched by a `skills`
  glob, so `*` is valid and cannot list it twice.
- A bundled skill that no rule claims is injected nowhere. With the default
  setting `[]` a thread gets only `model-instructions`. `bb model-instructions
  status` lists the unclaimed skills.
- Skills are never dropped for the character limit. Only instruction text is.
- A skill claimed by several rules is listed once.

## Instruction budget

bb cuts a plugin's instructions at 4096 characters per thread, in the middle of
a word and without a warning. The plugin makes sure that does not happen.

**On save** (`bb plugin config model-instructions set rules ...` or the settings
page) a value is rejected when:

1. it is not valid JSON or does not match the shape above;
2. a rule's `scope` glob matches no defined scope name;
3. a rule's `skills` glob matches no bundled skill (not counting `model-instructions`);
4. one rule's expanded `instructions` are longer than 4096 characters;
5. any known thread type would get more than 4096 characters. Known thread types
   are every provider × model that bb lists, as a top-level and as a child
   thread, for every project (its name and its checkout paths, so `scope` rules
   resolve) and for a thread with no project. Titles are not enumerated: a
   `skipTitles` match can only remove a rule, so a titled thread never gets more
   text than the same thread without a title. The length includes the `\n\n`
   between rules.

The budget error groups thread types by the set of rules they match, lists the
5 longest per group (provider, model, role, project, length) and ends with
`and <n> more`. A setting that has no `instructions` text skips check 5.

If the provider/model list or the project list has not loaded yet, or its last
refresh failed, a value with instruction text is rejected with
`budget not checkable yet: <provider list|project list> not loaded; retry`.
Retry after a minute or after the next thread starts. The lists refresh every
minute and when a thread is created.

These checks run only on save, never when a stored value is loaded. On load only
the structure can fail the setting. A `scope` or `skills` glob that matches
nothing then matches nothing, and the plugin logs one warning per rule, so a
renamed skill or a removed scope cannot switch off the other rules.

**At runtime**, a thread type that the save check never saw (a new model or a
new project) can still go over. The plugin then drops whole rules, never part of
one text:

- Rules are added in array order. The first rule that does not fit, and every
  later rule with text, is dropped. The room is 4096 minus the notice and its
  `\n\n`. A text that already fits in 4096 characters is never touched.
- When a rule was dropped, this line is appended, with `<n>` the number of
  dropped rules, so the agent can tell you:

  ```
  [model-instructions: <n> rule(s) omitted: over the 4096-character limit; tell the user to run bb model-instructions status]
  ```

- **Put role and guard rules first.** Later rules are dropped first.
- A warning is logged once per thread and set of dropped rules. The last 20
  events (thread, provider, model, role, project, dropped rule names and their
  lengths; never the text) are listed by `status`.
- After every cache refresh the plugin re-runs the budget check on the stored
  setting. A thread type that is over the limit is logged as a warning and listed
  by `status` as "over budget since <time>", before or at its first thread.

## Inspect and try

```sh
bb model-instructions status [--json]
bb model-instructions check [--provider P] [--model M] [--child] [--project <id>] [--path <dir>] [--title T] [--json]
bb model-instructions check --all [--json]
```

- `status` lists the scopes, the rules (name or `rules[<index>]`, matchers,
  instructions length, skills), the bundled skills with the rules that claim
  them and the unclaimed ones, the state of the caches, the thread types that
  are over budget and the recent overflow events.
- `check` shows what one thread would get: the matched rules, the length out of
  4096, the dropped rules and the skills. Run inside a bb thread, it takes
  provider, model, role, title, project and path from that thread; the output
  says which values were defaulted. A flag overrides its default. `--project`
  takes a project id; the name is looked up from it. Without a thread, give
  `--provider` and `--model`.
- `check --all` prints the save-time budget table, grouped like the budget
  error. It exits 1 when any thread type is over the limit.
- An unknown command exits 2 with a usage line.

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

## Example: everything except a few projects

```json
[
  {
    "skipProjects": ["opshub-legacy", "sandbox-*"],
    "instructions": "Run the project's tests before reporting done."
  }
]
```

Combine with `project` to narrow to a set first, e.g. `"project": ["opshub-*", "bb-*"], "skipProjects": "opshub-legacy"`; skip wins.

## Constraints

- The combined instructions for one thread are limited to 4096 characters by bb.
  The save check rejects a setting that would exceed it for a known thread type;
  at runtime the plugin drops whole rules and appends a notice (see Instruction budget).
- Side chats never receive plugin instructions.
- After saving rules that use `skipProjects` or `skipTitles` (in any form) or an array `project`, an older plugin version rejects the whole setting and applies no rules.
- After saving the object form (`vars`, `scopes`, `rules`), a rule with `name`, `scope` or `skills`, or a rule without `instructions`, an older plugin version rejects the whole setting and applies no rules.
- A `threads: child` rule also reaches devkit `review-code`'s lens and closure-review threads,
  since those are ordinary bb child threads. That skill's review-only brief asks the reviewer to
  ignore whatever this plugin injects into them — a prompt-level ask, not an enforced one (see
  the next bullet).
- Instructions guide the model; they do not enforce anything. Claude Code can
  still delegate through its own Task tool instead of bb threads; the Claude
  Code provider's "Disable provider subagents" setting hides that tool.
