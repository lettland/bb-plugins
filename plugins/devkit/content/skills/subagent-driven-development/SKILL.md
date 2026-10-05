---
name: subagent-driven-development
description: Use to execute an APPROVED multi-task plan — fresh subagent per task, SEQUENTIAL, two-stage review. Implementation, vs dispatching-parallel-agents.
metadata:
  keywords: [sdd]
  added: 2026-05-18
  last_reviewed: 2026-05-18
  type: core
  status: active
  invokes_shell: false
  shell_reviewed: "valksor 2026-05-17"
  related:
    [planning, tdd, dispatching-parallel-agents, code-review, using-git-worktrees, finishing-a-development-branch]
  owns: subagent-driven-development
---

# Subagent-Driven Development

Execute plan by dispatching fresh subagent per task, with two-stage review after each: spec compliance review first, then code quality review.

**Why subagents:** isolated context per task. You construct exactly what each agent needs — they should never inherit your session's history. Preserves your own context for coordination.

**Core principle:** fresh subagent per task + two-stage review (spec then quality) = high quality, fast iteration.

**Continuous execution:** do NOT pause to check in with the user between tasks. Execute all tasks from the plan without stopping. Only stop on: unresolvable BLOCKED status, ambiguity that genuinely prevents progress, or all tasks complete. "Should I continue?" prompts waste their time.

## When to use

- You have an implementation plan
- Tasks are mostly independent
- You want to stay in this session (no parallel-session handoff)

Otherwise: manual execution, or brainstorm first.

## The process

For each task:

1. **Dispatch implementer subagent** with full task text + context (don't make them read the plan file). The task's `Done when` and `Out of scope` lines are part of that text — the implementer must satisfy the first and stay inside the second.
2. **Answer any questions** the implementer asks before they proceed.
3. **Implementer implements, tests, commits, self-reviews.**
4. **Dispatch spec reviewer subagent** — confirms code matches spec exactly.
5. If spec gaps: implementer fixes → spec reviewer re-reviews → repeat until ✅.
6. **Dispatch code quality reviewer subagent**.
7. If quality issues: implementer fixes → code reviewer re-reviews → repeat until ✅.
8. **Mark task complete** in TaskWrite/TaskUpdate.
9. Next task.

After ALL tasks: dispatch a final code reviewer for the entire implementation, then `Skill(finishing-a-development-branch)`.

## Model selection

Use the least powerful model that can handle each role to conserve cost and increase speed.

**How to specify the model**: pass `model: 'haiku' | 'sonnet' | 'opus'` (the family name) to the `Agent` tool. The Claude Code runtime resolves family names to the current best model in that family at dispatch time — you don't need to know the concrete model ID, and you shouldn't hardcode one (today's "claude-haiku-4-5" becomes tomorrow's stale string). If you need to verify what your harness currently resolves to, check `~/.claude/settings.json` or the agent definitions under `agents/`. The runtime handles the mapping; the family name is the stable API.

For agents whose own definition declares `model: <family>`, the Agent tool's `model` parameter overrides it for that invocation only.

**Mechanical implementation** (isolated functions, clear specs, 1–2 files): cheap fast model (`haiku`). Most implementation tasks are mechanical when the plan is well-specified.

**Integration and judgment** (multi-file coordination, pattern matching, debugging): standard model (`sonnet`).

**Architecture, design, and review**: most capable model (`opus`).

**Task complexity signals:**

- 1–2 files with complete spec → cheap model (`haiku`)
- Multiple files with integration concerns → standard model (`sonnet`)
- Requires design judgment or broad codebase understanding → most capable model (`opus`)

If a task hits BLOCKED with reason "need more reasoning power", re-dispatch with one tier higher.

## Handling implementer status

Implementers return one of four:

**DONE** → proceed to spec compliance review.

**DONE_WITH_CONCERNS** → read concerns. Correctness/scope → address before review. Observations (e.g., "this file is getting large") → note and proceed.

**NEEDS_CONTEXT** → provide missing context and re-dispatch.

**BLOCKED** → assess:

1. Context problem → more context + re-dispatch with same model
2. Needs more reasoning → re-dispatch with more capable model
3. Task too large → break into smaller pieces
4. Plan itself is wrong → escalate to user

**Never** force the same model to retry without changes. If the implementer said it's stuck, something needs to change.

## Two-stage review

**Stage 1: spec compliance**

- "Does this code match the spec? Anything missing? Anything extra?"
- Verify the task's `Done when` check actually passes and nothing outside its `Out of scope` fence was touched (a task with no `Out of scope` line fences nothing — don't flag its absence).
- Reviewer is read-only (`tools: [Read, Grep, Glob]`)
- Issues → implementer fixes → spec reviewer re-reviews → repeat

**Stage 2: code quality** (only after spec is ✅)

- "Is this implementation well-built? Any code smells? Any anti-patterns?"
- Strengths + Critical / Important / Minor issues + Assessment
- Issues → implementer fixes → code reviewer re-reviews → repeat

**Order matters**: spec compliance first. Don't review quality of code that doesn't meet spec — wasted effort.

## Red flags

**Never:**

- Start implementation on `main`/`master` without explicit user consent
- Skip reviews (spec OR code quality)
- Proceed with unfixed issues
- Dispatch multiple implementation subagents in parallel (conflicts)
- Make subagent read the plan file (provide full text instead)
- Skip scene-setting context (subagent needs to know where task fits)
- Ignore subagent questions (answer first)
- Accept "close enough" on spec compliance
- Skip review loops
- Let self-review replace actual review (both are needed)
- Start code quality review before spec compliance is ✅
- Move to next task while either review has open issues

**If subagent fails task:**

- Dispatch a fix subagent with specific instructions
- Don't try to fix manually (context pollution)

## Integration

**Required workflow:**

- `Skill(using-git-worktrees)` — isolated workspace
- `Skill(planning)` — creates the plan this skill executes
- `Skill(code-review)` — template for reviewer subagents
- `Skill(finishing-a-development-branch)` — completion after all tasks

**Subagents should use:**

- `Skill(tdd)` — TDD for each task

## Cost vs benefit

More subagent invocations (implementer + 2 reviewers per task), more controller prep work, but catches issues early — much cheaper than debugging after merge.
