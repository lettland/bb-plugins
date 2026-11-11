# bb-plugin-model-instructions

Custom instructions per provider, model, and project for bb. bb's built-in
"Custom instructions" setting applies to every thread; this plugin adds
instructions only to threads whose provider, model, project, and position
(top-level or child thread) match a rule. It also gives Claude Code threads a
separate Claude profile per directory (see Claude profiles).

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
| `name` | no | 1–128 characters, unique among the rules. Names the rule in `status`, `check`, logs and overflow events; a rule without a name is `rules[<index>]`. |
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
  another source defines it. Profile scopes (see Claude profiles) are another source.
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

1. it is not valid JSON or does not match the shape above (two rules with the
   same `name` do not);
2. a rule's `scope` glob matches no defined scope name;
3. a rule's `skills` glob matches no bundled skill (not counting `model-instructions`);
4. one rule's expanded `instructions` are longer than 4096 characters;
5. any known thread type would get more than 4096 characters. Known thread types
   are every provider × model that bb lists (a provider whose models cannot be
   listed is left out, see below), as a top-level and as a child
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
`budget not checkable yet: <provider list|project list> not loaded; retry after the next refresh (every minute), or see bb model-instructions status`
(never loaded) or
`budget not checkable yet: <provider list|project list> refresh failed; retry after the next refresh (every minute), or see bb model-instructions status`
(last refresh failed). It is also rejected when providers are available but none
of their model lists could be loaded:
`budget not checkable yet: no provider's models could be listed (<id> (<reason>), ...); see bb model-instructions status`.
A loaded list with no available provider has nothing to check and does not block a save.
The lists refresh every minute and when a thread is created. At most one refresh
runs at a time; calls made during one share one follow-up refresh.

The provider list counts as failed only when listing the providers fails or
times out. When the models of one available provider cannot be listed, that
provider is left out of the known thread types and `status` and `check --all`
list it as unchecked, with the error. The save is then checked against the other
providers. When the provider comes back, the next refresh re-checks the stored
setting and records any overflow.

The save check does not cover everything:

- The save check covers threads whose scope match comes from a project's checkouts. A thread whose environment directory (for example a worktree) is inside a scope while its project's checkouts are not, a provider listed as unchecked, and a model that appears only in a workspace-scoped model catalog are not covered; for those, the runtime fallback applies (whole rules dropped from the end, with the notice).
- When the matched text is over the limit, the budget for kept rules is 4096 minus the notice; a very long first rule (close to 4096) can then be dropped too, leaving only the notice. Keep guard rules short and first.

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
  by `status` as "over budget since <time>", before or at its first thread. A
  thread type that stays over the limit keeps its time; its length and rules
  are updated.
- The first refresh runs in the background after the plugin registers its
  instructions and its command, so the rules apply at once. Scope matching
  through project checkouts starts working when the project list loads; the
  environment path of a thread is always a candidate.

## Claude profiles

A profile scope is a scope that also sets `claudeConfigDir`, a Claude Code
config directory (an absolute path or one starting with `~/`). Profile scopes
live in `~/.bb/model-instructions/profiles.json`, a file you own, not in the
`rules` setting:

```json
{
  "scopes": [
    { "name": "work", "paths": ["~/workspace/<org>"], "claudeConfigDir": "~/.claude-work" }
  ]
}
```

- The file is strict: `scopes` only, each scope has `name`, `paths` and
  `claudeConfigDir` and nothing else. Names, paths and limits are the same as for
  setting scopes (1–128 character unique names, 1–16 paths, at most 32 scopes).
  `claudeConfigDir` may not be your home directory or one of its parents.
- A profile scope is a full scope: a rule can name it in `scope`, and the save
  check knows its name. A rule can use it to inject text and skills for the same
  directories that select the profile.
- **The file defines the profile scope.** A scope in the `rules` setting with the
  same name as a profile scope is ignored: the plugin logs a warning at load, and
  `status` and `check` show `ignored setting scope "<name>": a profile scope with
  that name comes from profiles.json`. The profile decision uses only the paths in
  the file, so nothing that can run `bb plugin config` can move or redirect a
  Claude login.
- The file is read when the plugin loads, again on `bb plugin reload`, and right
  after `setup` or `import-dir-skills` writes it.

Claude Code threads whose project lives under a profile scope start with
`CLAUDE_CONFIG_DIR` set to its directory, so they get that profile's plugins,
subagents and hooks natively while other projects keep the default profile.
"Default profile" here means the personal Claude login, the profile at
`~/.claude`.

- The profile replaces the default one entirely for those threads: its
  settings, permissions, hooks, MCP servers, plugins, memory and `CLAUDE.md`.
  Settings that only exist in the default profile (such as
  `worktree.bgIsolation`) are not inherited.
- Matching uses the project's checkout paths only, on the host the thread runs
  on. A project with a checkout under the scope gets the profile for all of its
  threads; an environment path under the scope alone matches the scope's rules
  but does not select the profile.
- Local host only. The directory is expanded and checked on the machine that
  runs the bb server, and bb does not tell a plugin which host that is, so the
  plugin cannot refuse other hosts: a thread running on a remote host would
  receive the same path, which does not exist there. Use `claudeConfigDir` only
  for projects whose threads run on the bb server's own machine.
- A thread's profile is fixed at its first resolution and kept as a pin for its
  lifetime, across plugin reloads, so editing the file or reloading the plugin
  never moves a conversation to another profile. This includes the first
  resolution of a thread that already ran under a different profile: when a
  project already has Claude Code threads under another profile, each of those
  threads switches to the scope's profile on its next turn, and its earlier
  session stays in the old directory, so the turn may start without it.
- **An existing pin is always served first and fails closed.** If a pinned
  directory later disappears, the thread still gets that directory (it never
  falls back to the personal login), the plugin logs a warning, and the pin is
  kept. This holds in every state of profiles.json.
- **New pins are written only while profiles.json is valid.**
  - Absent: a thread with no pin gets no `CLAUDE_CONFIG_DIR` and no pin is
    written, so threads keep using the default profile until you create the file.
  - Malformed (it cannot be read, is not valid JSON or breaks a rule above): it is
    never treated as absent. The plugin logs a warning at load and `status` shows
    `profiles.json: malformed — <message>`. Existing pins are still served, no new
    pin is written, and rules and skills keep working.
- To make a thread resolve afresh (for example after fixing the file), run
  `bb model-instructions unpin [<thread-id>]` (default: the current thread). It
  deletes the thread's pin and prints what it removed. The thread's earlier
  Claude session stays in its previous profile; the next turn may start without
  it. A project that cannot be resolved (the lookup failed or took over 3
  seconds) pins the thread to the default profile; unpin it to try again. Pins
  are kept when a thread is deleted.
- If the directory is not a directory (missing, or a file), a new thread starts
  with the default profile and is pinned to it; the plugin logs a warning and
  `check` shows the reason. It never lets Claude create a fresh, logged-out
  profile there. If a project matches several profile scopes with different
  directories, the first scope by name wins and a warning is logged.
- A forked thread gets its own id and resolves on its own; the same project
  gives the same profile.
- A `CLAUDE_CODE_OAUTH_TOKEN` passed by bb takes priority over the profile's
  own login. Without one, bb threads use the profile's login and refresh it
  alongside any standalone `claude` session using the same directory.
- `status` shows the state of profiles.json, each profile scope with its
  directory and whether it exists, the ignored setting scopes and the number of
  pins. `check` shows which profile the project's checkouts select (all hosts;
  "unknown project" if bb cannot resolve it) and the pin of the calling thread.

## Setup

```sh
bb model-instructions setup [--dry-run] [--json]
```

`setup` creates `profiles.json` with one `work` scope when the file is absent. It
reads only the sources listed below and guesses nothing: if any step is unsure, it
writes nothing and says why. It never replaces a file that exists, even one that
appears while it runs.

1. **Profile.** The `customAgents` setting of the `provider-acp` and
   `bb--provider-acp-next` plugins is a JSON array of ACP agents. Setup reads only
   each agent's `env.CLAUDE_CONFIG_DIR` (an absolute path or one starting with
   `~/`), resolves symlinks, and keeps directories that exist. The default profile
   (`~/.claude`) and your home directory or its parents never count. Exactly one
   distinct directory must remain, for example `~/.claude-work`.
2. **Work remotes.** The profile's `settings.json` lists marketplaces under
   `extraKnownMarketplaces`. Only `git` marketplaces count. Each URL becomes a
   lowercase `host/first-path-segment` key, for example `git.example.com/acme`,
   whether it is written as `https://`, `ssh://git@host:port/`, or
   `git@host:group/...`; userinfo, port, and a trailing `.git` are dropped. Keys on
   GitHub, GitLab.com, Bitbucket Cloud and Codeberg are ignored, and so is any key
   the default profile's `settings.json` also lists. At least one key must remain.
3. **Projects.** Bb projects whose remote has one of those keys, and that have a
   checkout on this machine, are the work projects.
4. **Directory.** All matched checkouts must share one parent directory, and that
   parent must not be your home directory or one of its parents. Every entry in
   the parent that does not start with a dot must be a git checkout whose `origin`
   remote has a work key. Setup reads each `.git/config` itself and does not run
   git; a `.git` file (a linked worktree) counts as not work.

The written file looks like this, with paths in `~/` form when they are under your
home directory:

```json
{ "scopes": [ { "name": "work", "paths": ["~/src/acme"], "claudeConfigDir": "~/.claude-work" } ] }
```

- Without flags it creates the file when detection succeeds and reads it into the
  running plugin at once, so new threads use it without `bb plugin reload`.
- `--dry-run` always runs detection and writes nothing. It prints the scope it
  would write and the key each matched project produced, plus `would skip: exists`
  if the file is already there.
- `--json` prints `{ outcome, reason?, candidate?, matches, profileSource?,
  affectedThreads }`, where `outcome` is `wrote`, `skipped`, or `dry-run`.
- Exit code 0 for a write or a dry run, 2 for any skip. Skip reasons: `exists`,
  `no-profile`, `ambiguous-profiles`, `no-self-hosted-marketplace`,
  `no-project-match`, `no-common-parent` and `parent-has-non-work-entries`.
- The output shows detected paths and normalized `host/group` keys only. Raw
  remote URLs, and anything that could hold credentials, are never printed or
  logged.
- Setup does not run on install; run it yourself. Only ACP `customAgents` are
  read, only a self-hosted `git` marketplace counts, an ssh config alias host never
  matches the real host, and nested layouts skip. A directory scope covers every
  repository under the work tree, which is why the parent must contain nothing but
  work checkouts. All paths are checked on the machine that runs the bb server.

A thread that already started is pinned to the default profile for good (see
above). After a write, setup lists those threads whose project the new scope
covers; run `bb model-instructions unpin <thread-id>` for each to move it to the
work profile on its next turn.

## Moving from dir-skills

`dir-skills` is deprecated: this plugin does what it did (directory scopes, skills,
Claude profiles, pins). Skills are now claimed by a rule's `skills` globs, so a
scope's skill patterns become rules. To move your scopes, claims and pins over:

1. In dir-skills, run `bb dir-skills export`. It writes
   `~/.bb/dir-skills/export.json` with the scopes from its settings form and every
   Claude profile pin, which only that plugin can read.
2. In this plugin, run `bb model-instructions import-dir-skills --dry-run`, read
   the plan, then run it without `--dry-run`.

```sh
bb model-instructions import-dir-skills [--dry-run] [--json]
```

It takes no file argument. It reads only `~/.bb/dir-skills/scopes.json` (may be
absent) and `~/.bb/dir-skills/export.json` (required; without it the command exits
1 with `import-dir-skills: ~/.bb/dir-skills/export.json not found; run bb
dir-skills export first`).

- **Setting scopes and skill rules.** Every scope without `claudeConfigDir` (from
  `scopes.json`) and every settings-form scope (from `export.json`) becomes a
  scope in the `rules` setting plus a rule `{ "name": "dir-skills:<scope>",
  "scope": "<scope>", "skills": [<the scope's patterns>] }`. A settings-form scope
  replaces a `scopes.json` scope of the same name, except one that has
  `claudeConfigDir`. The example scope dir-skills shipped (`work`, `~/workspace/work`,
  `work-*`) is never imported.
- **Profile scopes.** A `scopes.json` scope with `claudeConfigDir` goes into
  `profiles.json`, only when that file is absent; a file that exists is never
  overwritten. The scope is then listed as skipped, with its reason, and so is its
  rule, unless the file already has the identical scope (a re-run).
- **Pins.** Each pin in `export.json` is checked strictly. A pin is imported when
  its directory is `null` (default profile) or equals a `claudeConfigDir` in
  `profiles.json` after the write above; any other pin is rejected and listed. An
  existing pin is never overwritten (it is listed as kept).
- **Skill patterns** that match no bundled skill would fail the save check, so
  that pattern is not written; it is listed as `skipped: no bundled skill matches
  "<pattern>"`.
- **Names.** A scope whose name, paths or directory break this plugin's rules is
  rejected with a list, nothing is written and the command exits 1; rename it in
  the source file and run again.
- **The setting** is changed by read-modify-write: it must parse (otherwise exit 1,
  nothing written), an array is converted to the object form
  `{ "vars": {}, "scopes": [...], "rules": [...] }`, every existing rule is kept
  unchanged and in order, and the imported scopes and rules are appended. A scope or
  rule whose name already exists is skipped and listed. The normal save-time check
  runs; if it rejects, the command prints the reason and exits 1.
- **Order.** Everything is validated first; then `profiles.json`, then the setting,
  then the pins. `--dry-run` prints the full plan and writes nothing; `--json`
  prints the same data.

Run it again after a failure part-way: scopes and rules that already exist are
skipped, and the profile scope already in `profiles.json` is recognised.

## Inspect and try

```sh
bb model-instructions status [--json]
bb model-instructions check [--provider P] [--model M] [--child | --top-level] [--project <id>] [--path <dir>] [--title T] [--json]
bb model-instructions check --all [--json]
bb model-instructions setup [--dry-run] [--json]
bb model-instructions unpin [<thread-id>]
bb model-instructions import-dir-skills [--dry-run] [--json]
```

- `status` lists the state of profiles.json, the profile scopes, the ignored
  setting scopes and the pin count (see Claude profiles), the scopes, the rules (name or `rules[<index>]`, matchers,
  instructions length, skills), the bundled skills with the rules that claim
  them and the unclaimed ones, the state of the caches, the providers whose
  models could not be listed (unchecked, with the reason), the thread types that
  are over budget and the recent overflow events. A `scope` or `skills` glob that
  matches nothing is marked under its rule (`! scope "<glob>" matches nothing`;
  `unresolved` in `--json`).
- `check` shows what one thread would get: the matched rules, the length out of
  4096, the dropped rules and the skills, then the Claude profile decision for the
  project and the calling thread's pin. Run inside a bb thread, it takes
  provider, model, role, title, project and path from that thread; the output
  says which values were defaulted. A flag overrides its default. `--child` and
  `--top-level` force the role; giving both is a usage error. `--project`
  takes a project id; the name is looked up from it. Without a thread, give
  `--provider` and `--model`.
- `check --all` prints the save-time budget table, grouped like the budget
  error. It exits 1 when any thread type is over the limit. When providers are
  unchecked it ends with `unchecked providers: <id> (<reason>), ...`.
- `setup`, `unpin` and `import-dir-skills` are described above.
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
