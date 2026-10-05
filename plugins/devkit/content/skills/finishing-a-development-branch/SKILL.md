---
name: finishing-a-development-branch
description: Use when implementation is done and tests pass, to integrate the work — verify, present options (merge / PR / keep / discard), then execute and clean up.
metadata:
  added: 2026-05-18
  last_reviewed: 2026-05-18
  type: core
  status: active
  invokes_shell: false
  shell_reviewed: "valksor 2026-05-17"
  related:
    [using-git-worktrees, code-review, subagent-driven-development, commit-writer, pr-description, deploy-checklist]
  owns: finishing-branch
---

# Finishing a Development Branch

**Core principle:** verify tests → detect environment → present options → execute choice → clean up.

**Announce at start:** "I'm using the finishing-a-development-branch skill to complete this work."

## Step 1: verify tests

Run the repo's test command, for example `npm test`, `cargo test`, `pytest`, or `go test ./...`.

**Tests failing:**

```
Tests failing (<N> failures). Must fix before completing:
[show failures]
Cannot proceed with merge/PR until tests pass.
```

Stop.

**Tests pass:** continue.

## Step 2: detect environment

```bash
GIT_DIR=$(cd "$(git rev-parse --git-dir)" 2>/dev/null && pwd -P)
GIT_COMMON=$(cd "$(git rev-parse --git-common-dir)" 2>/dev/null && pwd -P)
```

| State                                  | Menu                 | Cleanup                         |
| -------------------------------------- | -------------------- | ------------------------------- |
| `GIT_DIR == GIT_COMMON` (normal repo)  | 4 options            | No worktree to clean            |
| `GIT_DIR != GIT_COMMON`, named branch  | 4 options            | Provenance-based                |
| `GIT_DIR != GIT_COMMON`, detached HEAD | 3 options (no merge) | No cleanup (externally managed) |

## Step 3: determine base branch

```bash
git merge-base HEAD main 2>/dev/null || git merge-base HEAD master 2>/dev/null
```

Or ask: "This branch split from main — is that correct?"

## Step 4: present options

**Normal / named-branch worktree — exactly 4 options:**

```
Implementation complete. What would you like to do?
1. Merge back to <base-branch> locally
2. Push and create a Pull Request
3. Keep the branch as-is (I'll handle it later)
4. Discard this work
Which option?
```

**Detached HEAD — exactly 3 options:**

```
Implementation complete. You're on a detached HEAD (externally managed workspace).
1. Push as new branch and create a Pull Request
2. Keep as-is (I'll handle it later)
3. Discard this work
Which option?
```

## Step 5: execute choice

### Option 1: merge locally

```bash
# Capture worktree path BEFORE cd-ing away — Step 6 needs it
export WORKTREE_PATH=$(git rev-parse --show-toplevel)
MAIN_ROOT=$(git -C "$(git rev-parse --git-common-dir)/.." rev-parse --show-toplevel)
cd "$MAIN_ROOT"

git checkout <base-branch>
# If git pull fails (diverged remote, auth, network), STOP — do not proceed with merge.
git pull || { echo "git pull failed; resolve before merging"; exit 1; }
git merge <feature-branch>

# Verify tests on merged result
<test command>

# Only after merge succeeds: cleanup worktree (Step 6), then delete branch
git branch -d <feature-branch>
```

### Option 2: push and create PR

```bash
git push -u origin <feature-branch>

gh pr create --title "<title>" --body "$(cat <<'EOF'
## Summary
<2-3 bullets of what changed>

## Test Plan
- [ ] <verification steps>
EOF
)"
```

**Do NOT clean up worktree** — user needs it for PR iteration.

Use `Skill(commit-writer)` and `Skill(pr-description)` for content.

### Option 3: keep as-is

Report: "Keeping branch `<name>`. Worktree preserved at `<path>`."
Don't cleanup.

### Option 4: discard

**Confirm first:**

```
This will permanently delete:
- Branch <name>
- All commits: <commit-list>
- Worktree at <path>
Type 'discard' to confirm.
```

Wait for exact typed confirmation. Then cleanup + force-delete:

```bash
# Capture worktree path BEFORE cd-ing away — Step 6 needs it
export WORKTREE_PATH=$(git rev-parse --show-toplevel)
MAIN_ROOT=$(git -C "$(git rev-parse --git-common-dir)/.." rev-parse --show-toplevel)
cd "$MAIN_ROOT"
# cleanup worktree (Step 6 — uses $WORKTREE_PATH captured above)
git branch -D <feature-branch>
```

## Step 6: cleanup workspace

**Only for Options 1 and 4.**

**Important**: Options 1 and 4 already exported `$WORKTREE_PATH` BEFORE `cd`-ing to MAIN_ROOT. Use that captured value here — do NOT recompute from the current `cwd` (you're in MAIN_ROOT now; `git rev-parse --show-toplevel` would return MAIN_ROOT, not the worktree).

```bash
# Re-detect from the captured worktree path using -C; cwd is MAIN_ROOT now.
GIT_DIR=$(git -C "$WORKTREE_PATH" rev-parse --absolute-git-dir 2>/dev/null)
GIT_COMMON=$(git -C "$WORKTREE_PATH" rev-parse --git-common-dir 2>/dev/null)
# Make GIT_COMMON absolute so the equality check below is reliable
case "$GIT_COMMON" in
  /*) ;;  # already absolute
  *) GIT_COMMON="$WORKTREE_PATH/$GIT_COMMON" ;;
esac
```

**`WORKTREE_PATH == MAIN_ROOT`:** the user ran `finishing-a-development-branch` from inside the main repo, not from a worktree — nothing to clean. Done.
**Worktree under `.claude/worktrees/`** (`EnterWorktree`-owned): call `ExitWorktree(action: "keep")` first — updates harness cwd before deletion; skipping causes `ENOENT posix_spawn '/bin/sh'` on the next Stop hook (Node.js can't spawn with a missing cwd). Then:

```bash
git worktree remove "$WORKTREE_PATH"
git worktree prune
```

**Worktree under `.worktrees/`, `worktrees/`, or `~/.config/devkit/worktrees/`:** we own cleanup.

```bash
MAIN_ROOT=$(git -C "$(git rev-parse --git-common-dir)/.." rev-parse --show-toplevel)
cd "$MAIN_ROOT"
git worktree remove "$WORKTREE_PATH"
git worktree prune
```

**Otherwise (harness-owned):** do NOT remove. If your platform provides a workspace-exit tool, use it. Otherwise leave it.

## Quick reference

| Option           | Merge | Push | Keep worktree | Delete branch |
| ---------------- | ----- | ---- | ------------- | ------------- |
| 1. Merge locally | yes   | —    | —             | yes           |
| 2. Create PR     | —     | yes  | yes           | —             |
| 3. Keep as-is    | —     | —    | yes           | —             |
| 4. Discard       | —     | —    | —             | yes (force)   |

## Red flags

**Never:**

- Proceed with failing tests
- Merge without verifying tests on the result
- Delete work without typed confirmation
- Force-push without explicit user request
- Clean up worktrees you didn't create (provenance check)
- Run `git worktree remove` from inside the worktree (silent failure)

**Always:**

- Verify tests before offering options
- Present exactly 4 options (or 3 for detached HEAD)
- Get typed "discard" for Option 4
- Cleanup for Options 1 & 4 only
- Call `ExitWorktree` before `git worktree remove` for `.claude/worktrees/` paths
