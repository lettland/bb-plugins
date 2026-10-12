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
