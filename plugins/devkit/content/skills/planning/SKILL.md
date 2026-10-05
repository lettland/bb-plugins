---
name: planning
description: Use after brainstorming to write an implementation plan — bite-sized tasks, exact files, TDD throughout. No placeholders.
metadata:
  added: 2026-05-18
  last_reviewed: 2026-06-17
  type: core
  status: active
  invokes_shell: false
  shell_reviewed: "valksor 2026-05-17"
  related: [brainstorming, tdd, subagent-driven-development, using-git-worktrees, verify-before-asserting]
  owns: planning
---

_Adapted from obra/superpowers (MIT); modified. See THIRD_PARTY_NOTICES.md._

# Planning

Write comprehensive implementation plans assuming the engineer has zero context for your codebase and questionable taste.

**Announce at start:** "I'm using the planning skill to create the implementation plan."

Assume they are skilled but know almost nothing about your toolset or problem domain. Assume they don't know good test design.

**Save plans to:** `docs/plans/YYYY-MM-DD-<feature-name>.md` (user override wins).

## Scope check

If the spec covers multiple independent subsystems, suggest breaking into separate plans — one per subsystem. Each plan should produce working, testable software on its own.

Phase the rollout, not the rigor: when a plan is split into phases, each phase must deliver production-grade, complete behavior for its slice — not a half-built stub finished later.

## File structure

Before defining tasks, map which files will be created or modified and what each is responsible for. This is where decomposition decisions get locked in.

- Design units with clear boundaries and well-defined interfaces. One responsibility per file.
- Files that change together live together. Split by responsibility, not by technical layer.
- In existing codebases, follow established patterns.

## Bite-sized task granularity

Each step is one action (2–5 minutes):

- "Write the failing test" — step
- "Run it to make sure it fails" — step
- "Implement the minimal code to make the test pass" — step
- "Run the tests and make sure they pass" — step
- "Commit" — step

## Plan document header

Every plan MUST start with:

```markdown
# [Feature Name] Implementation Plan

> **Execution skill:** Use `Skill(subagent-driven-development)` (recommended) or inline execution. Steps use `- [ ]` checkbox syntax.

**Goal:** [One sentence describing what this builds]
**Architecture:** [2–3 sentences about approach]
**Tech Stack:** [Key technologies/libraries]

---
```

## Task structure

````markdown
### Task N: [Component Name]

**Files:**

- Create: `exact/path/to/file.py`
- Modify: `exact/path/to/existing.py:123-145`
- Test: `tests/exact/path/to/test.py`

**Done when:** the test check passes — e.g. `pytest tests/exact/path/to/test.py -q` (substitute your stack's runner: `go test ./...`, `vitest run`, …) — and [any behavior that must be observable].

**Out of scope:** [files/refactors/behavior reserved for another task — omit if nothing adjacent is at risk].

- [ ] **Step 1: Write the failing test**

```python
def test_specific_behavior():
    result = function(input)
    assert result == expected
```

- [ ] **Step 2: Run test to verify it fails**
      Run: `pytest tests/path/test.py::test_name -v`
      Expected: FAIL with "function not defined"

- [ ] **Step 3: Write minimal implementation**

```python
def function(input):
    return expected
```

- [ ] **Step 4: Run test to verify it passes**
      Run: `pytest tests/path/test.py::test_name -v`
      Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add tests/path/test.py src/path/file.py
git commit -m "<message per Skill(devkit:commit-writer) — extract style from `git log -5 | cat`, do not invent>"
```
````

`Done when` and `Out of scope` are the task-level contract. `Done when` is the single check that proves completion — a fresh subagent runs it and stops guessing whether it's finished; put it on every task. `Out of scope` fences what the task must not touch, so a subagent executing one task in isolation doesn't drift into another task's files — when in doubt, include it; omit only when no adjacent file or responsibility could be wrongly pulled in.

## No placeholders

Every step must contain the actual content an engineer needs. These are **plan failures** — never write them:

- "TBD", "TODO", "implement later", "fill in details"
- "Add appropriate error handling" / "add validation" / "handle edge cases"
- "Write tests for the above" (without actual test code)
- "Similar to Task N" — repeat the code; engineer may read out of order
- Steps that describe what to do without showing how (code blocks required for code steps)
- References to types/functions/methods not defined in any task

## Self-review

After writing the complete plan, check against the spec:

1. **Spec coverage** — point to a task per spec requirement; list gaps
2. **Placeholder scan** — search for "TBD" / "TODO" / vague language; fix
3. **Type consistency** — same names + signatures used in later tasks as earlier tasks
4. **DRY/YAGNI** — no duplicated work, no speculative features
5. **Decision provenance** — each non-obvious design choice in the plan names its source (spec section, user decision, or "author judgment: rationale"). A fresh subagent executes this plan with zero context; an unsourced choice reads as fact and gets built on. Annotate the source inline or cut the choice.

Fix issues inline. If a spec requirement has no task, add the task.

## Calibrated review

Self-review is single-author — you check your own work. Before the execution handoff, get **independent perspectives**: run the calibrated plan review — `devkit_load_skill({ slug: "review-code" })` with scope `plan <saved-plan-path>` — to apply the five calibrated lenses (senior-dev, senior-qa, security, end-user, compliance) to the plan. Disposition their findings per `references/review-finding-disposition.md` — validate each against the plan, apply every valid revision directly to the plan document, skip false positives with a one-line reason — then proceed to the handoff. On bb, native plan mode reaches the same review automatically: auto-review holds a plan's first presentation, runs this review, and releases the revised plan to the user, so a plan is never handed off un-reviewed.

## Execution handoff

After saving the plan, offer execution choice:

> "Plan complete and saved to `docs/plans/<filename>.md`. Two options:
>
> 1. **Subagent-Driven (recommended)** — fresh subagent per task + two-stage review (`Skill(subagent-driven-development)`)
> 2. **Inline execution** — execute in this session with batch checkpoints
>
> Which approach?"

If subagent-driven, invoke `Skill(subagent-driven-development)`. If inline, ensure `Skill(tdd)` is in use and proceed task-by-task.
