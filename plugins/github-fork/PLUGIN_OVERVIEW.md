See the open issues and pull requests of your repositories inside bb. Hand one to an agent with one click.

## What you get

- A GitHub panel with Issues and Pull requests tabs across every tracked repository. It has a repository filter and a New issue form.
- Issue details: body, comments, a comment box, and editing of status, assignee, and labels.
- Send agent on an issue, or Review with agent on a pull request. bb starts a thread in the repository's project and links it from the item.
- Mentions. Type `@` or `#` in any composer to attach an issue or pull request. Its title, body, and state go to the agent at send time. `@` lists open items only. `#` also lists closed items the sync caches (the most recently created closed ones per repository) from all tracked repositories, ranked by exact number, then open items, then the current project's repositories. `#<number>` is looked up live in each of the current project's repositories that doesn't have it cached, when the GitHub CLI is ready.

## How it works

The plugin tracks every bb project whose checkout has a GitHub `origin` remote. Add more repositories in the Extra repositories setting as a comma-separated `owner/repo` list. Choose a Default project for repositories that are not attached to a project. A background service refreshes the cache at startup, then waits 15 minutes after each completed sync to reduce background GitHub traffic. Press Refresh in the panel to update now.

## For agents

The `bb github` command lists cached data. Use `bb github repos`, `bb github issues [owner/repo]`, `bb github prs [owner/repo]`, or `bb github sync`. Every command accepts `--json`, and `bb github --help` or `bb github <command> --help` prints the arguments and options and exits 0.

## Requirements

The GitHub CLI must be installed and signed in with `gh auth login`. See https://cli.github.com for installation. The plugin uses your `gh` session and stores no tokens. Until `gh auth status` passes, the plugin reports that it needs configuration.

With several `gh` accounts logged in, the plugin reads a tracked repository that the active account cannot see as another logged-in account that can see it. It never switches the active account, and writes (comment, close, create, labels, assignees) always use the active account. Tokens are read from `gh` at runtime and held in memory only. The "mine" filter uses the active account, so items assigned to the other account never show as "mine". Issue and PR text from repositories read as the other account can appear in agent thread context, while agents still write as the active account. After adding, switching or re-logging a `gh` account, run `bb github sync` to apply it at once; the background sync also picks it up for repositories that start failing.
