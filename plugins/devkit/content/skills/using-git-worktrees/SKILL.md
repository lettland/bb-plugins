---
name: using-git-worktrees
description: Use when feature work needs isolation, or before executing an implementation plan — native worktree tools, else manual git worktree.
metadata:
  added: 2026-05-18
  last_reviewed: 2026-05-18
  type: core
  status: active
  invokes_shell: false
  shell_reviewed: "valksor 2026-05-17"
  related: [planning, subagent-driven-development, finishing-a-development-branch]
  owns: git-worktrees
---

# Using Git Worktrees

Ensure work happens in an isolated workspace. Prefer your platform's native worktree tools. Fall back to manual git worktrees only when no native tool is available.

**Core principle:** detect existing isolation first. Then use native tools. Then fall back to git. Never fight the harness.

**Announce at start:** "I'm using the using-git-worktrees skill to set up an isolated workspace."

## Step 0: detect existing isolation

```bash
GIT_DIR=$(cd "$(git rev-parse --git-dir)" 2>/dev/null && pwd -P)
GIT_COMMON=$(cd "$(git rev-parse --git-common-dir)" 2>/dev/null && pwd -P)
BRANCH=$(git branch --show-current)
```

**Submodule guard:** `GIT_DIR != GIT_COMMON` is also true inside git submodules. Verify:

```bash
git rev-parse --show-superproject-working-tree 2>/dev/null
```

If this returns a path, you're in a submodule — treat as a normal repo, NOT a worktree.

**If `GIT_DIR != GIT_COMMON` (and not a submodule):** you're already in a linked worktree. Skip to Step 2.

- On a branch: "Already in isolated workspace at `<path>` on branch `<name>`."
- Detached HEAD: "Already in isolated workspace at `<path>` (detached HEAD, externally managed). Branch creation needed at finish time."

**If `GIT_DIR == GIT_COMMON` (or in submodule):** normal repo. If the user hasn't already declared a worktree preference, ask:

> "Would you like me to set up an isolated worktree? It protects your current branch from changes."

If declined, work in place; skip to Step 2.

## Step 1: create isolated workspace

### 1a. Native worktree tools (preferred)

Do you have a tool named `EnterWorktree`, `WorktreeCreate`, a `/worktree` command, or a `--worktree` flag? Use it and skip to Step 2. Native tools handle directory placement, branch creation, and cleanup. Using `git worktree add` when you have a native tool creates phantom state your harness can't see.

### 1b. Git worktree fallback

Only if 1a doesn't apply. Directory selection priority:

1. **Check instructions** for a declared preference.
2. **Check for existing project-local dir:**
   ```bash
   ls -d .worktrees 2>/dev/null || ls -d worktrees 2>/dev/null
   ```
   If found, use it. `.worktrees` wins if both exist.
3. **Check for global dir:**
   ```bash
   project=$(basename "$(git rev-parse --show-toplevel)")
   ls -d ~/.config/devkit/worktrees/$project 2>/dev/null
   ```
4. **Default**: `.worktrees/` at project root.

**Safety verification (project-local only):**

```bash
git check-ignore -q .worktrees 2>/dev/null || git check-ignore -q worktrees 2>/dev/null
```

NOT ignored? Add to `.gitignore`, commit, then proceed. Prevents accidentally committing worktree contents.

**Create the worktree:**

```bash
project=$(basename "$(git rev-parse --show-toplevel)")
# For project-local: path="$LOCATION/$BRANCH_NAME"
# For global: path="~/.config/devkit/worktrees/$project/$BRANCH_NAME"
git worktree add "$path" -b "$BRANCH_NAME"
cd "$path"
```

**Sandbox fallback:** If `git worktree add` fails with permission denied, tell the user the sandbox blocked it; work in place.

## Step 2: project setup

Auto-detect and run:

```bash
[ -f package.json ] && (command -v pnpm >/dev/null && pnpm install || command -v bun >/dev/null && bun install || npm install)
[ -f Cargo.toml ] && cargo build
[ -f requirements.txt ] && pip install -r requirements.txt
[ -f pyproject.toml ] && (command -v poetry >/dev/null && poetry install || command -v uv >/dev/null && uv sync)
[ -f go.mod ] && go mod download
```

## Step 3: verify clean baseline

Run the project's test command. If tests fail, report and ask whether to proceed or investigate. If tests pass, report ready.

## Quick reference

| Situation                                 | Action                          |
| ----------------------------------------- | ------------------------------- |
| Already in linked worktree                | Skip creation (Step 0)          |
| In a submodule                            | Treat as normal repo            |
| Native worktree tool available            | Use it (1a)                     |
| No native tool                            | Git worktree fallback (1b)      |
| `.worktrees/` exists                      | Use it (verify ignored)         |
| Both `.worktrees/` and `worktrees/` exist | Use `.worktrees/`               |
| Directory not ignored                     | Add to `.gitignore` + commit    |
| Permission error on create                | Sandbox fallback, work in place |
| Tests fail during baseline                | Report + ask                    |

## Red flags

**Never:**

- Create a worktree when Step 0 detects existing isolation
- Use `git worktree add` when a native tool is available
- Skip Step 1a by jumping straight to git commands
- Create project-local worktree without verifying it's gitignored
- Skip baseline test verification
- Proceed with failing baseline tests without asking

**Always:**

- Step 0 detection first
- Native tools over git fallback
- Verify ignored for project-local dirs
- Auto-detect and run project setup
- Verify clean test baseline
