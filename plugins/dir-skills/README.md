# bb-plugin-dir-skills

Directory-scoped skills for bb, for every provider (Claude Code, Codex, Pi, ACP
providers). bb injects a plugin's `skills/<name>/SKILL.md` into every thread;
this plugin narrows that to threads whose workspace lives under a configured
directory.

## Layout

```
scopes.json            directory trees -> skill-name patterns
skills/<name>/SKILL.md ordinary bb skills (frontmatter: name, description)
```

`scopes.json`:

```json
{
  "scopes": [
    { "name": "work", "paths": ["~/workspace/work"], "skills": ["work-*"] }
  ]
}
```

- A skill whose name matches a scope pattern is injected only when the thread's
  environment path, or the checkout path of the thread's project, is inside one
  of that scope's directories. Managed worktrees therefore still count.
- A skill that no scope claims is injected everywhere.
- Paths are compared after symlink resolution on both sides.
- Project checkout paths are cached at load, every minute, and on thread
  creation. The very first thread of a managed worktree in a project created
  seconds earlier can miss a scoped skill until the next refresh; unmanaged and
  personal environments match by their own path and are unaffected.
- `*` in a pattern matches any characters. A skill may belong to several scopes.

### Private directories

The shipped `scopes.json` is an example. Keep real directory names out of the
repository by putting them in `~/.bb/dir-skills/scopes.json`, which uses the
same format. A scope there replaces the shipped scope with the same `name`;
other scopes are added. To point the bundled `work-*` skills at your real work
tree:

```json
{
  "scopes": [
    { "name": "work", "paths": ["~/workspace/<your-org>"], "skills": ["work-*"] }
  ]
}
```

`bb dir-skills status` shows whether the user file was loaded. Keep scoped skill
names neutral too (`work-<topic>`): the skill name is committed with the skill.

#### Settings UI

Settings → Plugins → Directory skills has a **Directory scopes** section, a
form for scopes that live in bb and not in a file.

- **From files** lists, read-only, the shipped `scopes.json` merged with
  `~/.bb/dir-skills/scopes.json` before the UI layer, one entry per name. When
  both files define a name, the user-file entry wins and is tagged `file`; the
  others are tagged `shipped`. The list is computed at the last load or save,
  so it matches what is active. A scope with a Claude profile carries the note
  "Claude profile — edit in ~/.bb/dir-skills/scopes.json".
- **Your scopes** are editable cards: a name, one or more directories
  (absolute or `~/…`), and skills. Skills are one checkbox per skill in the
  plugin's `skills/` directory, plus an **Extra patterns** field for globs such
  as `docs-*`, comma-separated. A stored entry that equals a skill name shows
  as a checked box; every other entry goes to Extra patterns. A scope needs at
  least one checked skill or pattern.
- **Save** is disabled until something changes. It is also enabled while a
  stored value could not be read, so saving with no scopes clears it. A
  validation or store error shows above the buttons, your edits stay, and
  nothing is stored. **Discard changes** is enabled after any edit, including
  an empty directory row, and restores the loaded state. The form reloads when
  the window gets focus only while it has no unsaved changes.

Rules and limits:

- Precedence: the shipped `scopes.json`, then `~/.bb/dir-skills/scopes.json`,
  then your scopes. A scope replaces an earlier scope with the same `name`; a
  scope with a new name is added.
- Names, directories and skills are trimmed. A name must not be empty, must
  not contain control characters and must be unique after trimming. Every
  directory must be absolute or start with `~/`.
- At most 32 scopes, 16 directories per scope, 64 skill entries per scope.
  Names and skill entries are at most 128 characters, directories at most 1024.
- `claudeConfigDir` is file-only. The form never shows or sends it, and the
  server rejects it in a save. A UI scope with the same name as a file scope
  that sets `claudeConfigDir` is ignored (the card warns before Save, and the
  name shows as skipped after it); `bb dir-skills status` lists it. Edit that
  scope in `~/.bb/dir-skills/scopes.json`. A UI scope with the same name as a
  file scope without a profile replaces it.
- The scopes are stored in the plugin's own key-value storage (key
  `uiScopes`). A stored value that no longer reads is ignored with a warning,
  the file layers stay active, and the form shows a banner; the next Save
  replaces it. `bb dir-skills status` shows the number of UI scopes, or why
  they are ignored (`ui scopes: ignored — …`).
- Anything that can call the plugin's `saveScopes` RPC can write UI scopes
  without file access. This is why the form cannot set a Claude profile or
  change where a profile applies.
- Auto-setup (see below) only checks whether `~/.bb/dir-skills/scopes.json`
  exists. On install it can add a file scope next to scopes that exist only in
  the UI.

Changes from v0.2.5, which had a **Scopes** JSON setting:

- The `scopes` setting and `bb plugin config dir-skills set scopes` are
  removed. A value stored there is no longer read, except by a one-time,
  best-effort import: when no scopes are stored yet, the plugin reads the old
  value once at startup, and if it is valid it is stored and one line is
  logged. If bb no longer returns the removed key, the import does nothing.
  The import accepts only scopes that have a name and only the keys `name`,
  `paths` and `skills`. A v0.2.5 value with an unnamed scope or another key is
  not imported. While the old value is invalid and nothing is stored yet, the
  warning is logged at every start, until the first Save.
- `bb dir-skills status --json` no longer has `settingReloadError`. The
  `settingScopes`, `settingError` and `settingSkipped` keys stay.
- Rolling back to v0.2.5 ignores the scopes saved by the form, because they
  are in storage and not in the old setting.

## Claude Code profile per directory

A scope may also set `claudeConfigDir`, a Claude Code config directory (an
absolute path or one starting with `~/`):

```json
{
  "scopes": [
    {
      "name": "work",
      "paths": ["~/workspace/<org>"],
      "skills": ["work-*"],
      "claudeConfigDir": "~/.claude-acme"
    }
  ]
}
```

Claude Code threads whose project lives under that scope start with
`CLAUDE_CONFIG_DIR` set to it, so they get that profile's plugins, subagents and
hooks natively while other projects keep the default profile. "Default
profile" here means the personal Claude login, the profile at `~/.claude`.
`skills` is still required.

- The profile replaces the default one entirely for those threads: its
  settings, permissions, hooks, MCP servers, plugins, memory and `CLAUDE.md`.
  Settings that only exist in the default profile (such as
  `worktree.bgIsolation`) are not inherited.
- Matching uses the project's checkout paths only, on the host the thread runs
  on. A project with a checkout under the scope gets the profile for all of its
  threads; an environment path under the scope alone gives the scope's skills
  but not the profile.
- Local host only. The directory is expanded and checked on the machine that
  runs the bb server, and bb does not tell a plugin which host that is, so the
  plugin cannot refuse other hosts: a thread running on a remote host would
  receive the same path, which does not exist there. Use `claudeConfigDir` only
  for projects whose threads run on the bb server's own machine.
- A thread's profile is fixed at its first resolution and kept for its
  lifetime, across plugin reloads, so editing scopes or reloading the plugin
  never moves a conversation to another profile. This includes the first
  resolution of a thread that already ran under a different profile: when a
  project already has Claude Code threads under another profile, each of those
  threads switches to the scope's profile on its next turn, and its earlier
  session stays in the old directory, so the turn may start without it.
- To make a thread resolve afresh (for example after fixing a scope), run
  `bb dir-skills unpin [<thread-id>]` (default: the current thread). It deletes
  the thread's pin and prints what it removed. The thread's earlier Claude
  session stays in its previous profile; the next turn may start without it. A
  project that cannot be resolved (lookup failed or took over 3 seconds) pins
  the thread to the default profile; unpin it to try again. Pins are kept when a
  thread is deleted.
- If the directory is not a directory (missing, or a file), a new thread
  starts with the default profile and is pinned to it; the plugin logs a
  warning and `check` shows the reason. It never lets Claude create a fresh,
  logged-out profile there. If a pinned directory later disappears, the thread
  still gets that directory (it fails closed and never falls back to the
  personal login), the plugin logs a warning, and the pin is kept. If a project
  matches several scopes with different directories, the first scope by name
  wins and a warning is logged. `claudeConfigDir` may not be your home
  directory or one of its parents.
- A forked thread gets its own id and resolves on its own; the same project
  gives the same profile.
- A `CLAUDE_CODE_OAUTH_TOKEN` passed by bb takes priority over the profile's
  own login. Without one, bb threads use the profile's login and refresh it
  alongside any standalone `claude` session using the same directory.
- `bb dir-skills status` shows each scope's `claudeConfigDir`; `bb dir-skills
  check --project <project-id>` shows which profile that project's checkouts
  select (all hosts; "unknown project" if bb cannot resolve it), and inside a
  thread also the profile the thread was pinned to.

## Automatic setup

When the plugin is installed and `~/.bb/dir-skills/scopes.json` does not exist,
it writes that file for you, with a `work` scope that points the bundled
`work-*` skills at your work tree and sets `claudeConfigDir` to your work Claude
profile. `bb dir-skills setup` runs the same logic on demand. Setup reads only
the sources listed below and guesses nothing: if any step is unsure, it writes
nothing and says why.

Detection, in order:

1. **Profile.** The `customAgents` setting of the `provider-acp` and
   `bb--provider-acp-next` plugins is a JSON array of ACP agents. Setup reads
   only each agent's `env.CLAUDE_CONFIG_DIR` (an absolute path or one starting
   with `~/`), resolves symlinks, and keeps directories that exist. The default
   profile (`~/.claude`) and your home directory or its parents never count.
   Exactly one distinct directory must remain, for example `~/.claude-acme`.
   Other settings of those plugins, including other agents' environment
   variables, are never read.
2. **Work remotes.** The profile's `settings.json` lists marketplaces under
   `extraKnownMarketplaces`. Only `git` marketplaces count. Each URL becomes a
   lowercase `host/first-path-segment` key, for example
   `git.example.com/acme`, whether it is written as `https://`,
   `ssh://git@host:port/`, or `git@host:group/...`; userinfo, port, and a
   trailing `.git` are dropped. Keys on GitHub, GitLab.com, Bitbucket Cloud and
   Codeberg are ignored, and so is any key the default profile's
   `settings.json` also lists. At least one key must remain.
3. **Projects.** Bb projects whose remote has one of those keys, and that have a
   checkout on this machine, are the work projects.
4. **Directory.** All matched checkouts must share one parent directory (for
   example `~/src/acme`), and that parent must not be your home directory or one
   of its parents. Every entry in the parent that does not start with a dot must
   be a git checkout whose `origin` remote has a work key. Setup reads each
   `.git/config` itself and does not run git; a `.git` file (a linked worktree)
   counts as not work.

The written scope looks like this, with paths in `~/` form when they are under
your home directory:

```json
{
  "scopes": [
    {
      "name": "work",
      "paths": ["~/src/acme"],
      "skills": ["work-*"],
      "claudeConfigDir": "~/.claude-acme"
    }
  ]
}
```

Limits:

- Only ACP `customAgents` are read. A work profile configured anywhere else is
  not found.
- Only a self-hosted `git` marketplace counts. Work hosted on GitHub or GitLab
  cloud always skips, because those keys are indistinguishable from public
  projects.
- An ssh config alias host (`git@work-alias:group/...`) does not match the real
  host, so such remotes never match. Write the file by hand.
- Nested layouts, where the work checkouts sit in more than one directory,
  skip.
- A directory scope covers every repository under the work tree, so repos you
  add there later get the scope's skills and profile too. This is why the
  parent must contain nothing but work checkouts.
- All paths are checked on the machine that runs the bb server.

Skip reasons: `exists` (the file is already there; setup only creates a missing
file and never refreshes it), `no-profile`, `ambiguous-profiles` (more than one
distinct `CLAUDE_CONFIG_DIR`; write the file by hand or remove the extra one),
`no-self-hosted-marketplace`, `no-project-match`, `no-common-parent`, and
`parent-has-non-work-entries`.

```
bb dir-skills setup [--dry-run] [--json]
```

- Without flags it creates the file when detection succeeds and reloads the
  scopes, so new threads use them without `bb plugin reload`. The file is
  created without overwriting anything that appears in the meantime.
- `--dry-run` always runs detection and writes nothing. It prints the scope it
  would write and the key each matched project produced, plus `would skip:
  exists` if the file is already there.
- `--json` prints `{ outcome, reason?, candidate?, matches, profileSource?,
  affectedThreads }`, where `outcome` is `wrote`, `skipped`, or `dry-run`.
- Exit code 0 for a write or a dry run, 2 for any skip.
- The output shows detected paths and normalized `host/group` keys only. Raw
  remote URLs, and anything that could hold credentials, are never printed or
  logged.

A thread that already started is pinned to the default profile for good (see
above). After a write, setup lists those threads whose project the new scope
covers; run `bb dir-skills unpin <thread-id>` for each to move it to the work
profile on its next turn. `bb dir-skills status` shows `auto-setup: wrote` or
`auto-setup: skipped (<reason>)` for the last install or non-dry run.

## Adding a work skill

1. Create `skills/work-<topic>/SKILL.md` with `name: work-<topic>` and a
   `description`. A Claude skill directory works unchanged; copy it in.
2. Run `bb plugin reload dir-skills` (also after editing either scopes file).
   Threads pick up the new catalog when their provider session is next started.
3. `bb dir-skills status` lists every skill and its scope. `bb dir-skills check
   ~/workspace/<your-org>/some-repo` shows what a thread there would receive.
4. Each thread start writes a debug log line with the environment path and the
   selected skills: `bb plugin logs dir-skills`.

Skills land in the agent under bb's plugin-skill namespace, e.g. Claude Code
sees `bb-global-skills:work-conventions`.

## Install

```
bb plugin install ~/workspace/bb-plugin-dir-skills
```
