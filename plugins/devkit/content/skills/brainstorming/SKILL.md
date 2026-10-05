---
name: brainstorming
description: Use before implementation — turns an approved spec into a design via Socratic dialogue. No code until approved.
metadata:
  added: 2026-05-18
  last_reviewed: 2026-05-18
  type: core
  status: active
  invokes_shell: false
  shell_reviewed: "valksor 2026-05-17"
  related: [planning, requirements-gathering, tdd, interview-first, verify-before-asserting]
  owns: brainstorming
---

# Brainstorming

Help turn ideas into fully-formed designs through natural collaborative dialogue.

## Hard gate

**Do NOT** invoke any implementation skill, write any code, scaffold any project, or take any implementation action until you have presented a design and the user has approved it. **EVERY** project goes through this — todo lists, single-function utilities, config changes, all of them. "Simple" projects are where unexamined assumptions cause the most wasted work.

The design can be short (a few sentences for truly simple things). You MUST still present it and get approval.

## Checklist

Create a TaskCreate item per step and complete in order:

1. **Explore project context** — check files, docs, recent commits
2. **Ask clarifying questions** — one at a time. Multiple choice when possible. Focus: purpose, constraints, success criteria.
3. **Propose 2–3 approaches** — with trade-offs and your recommendation (lead with the recommendation, explain why)
4. **Present design in sections** — each scaled to its complexity (sentences for simple, ≤300 words for nuanced). Confirm after each section.
5. **Write spec doc** — `docs/specs/YYYY-MM-DD-<topic>-design.md` (or per user preference). Commit it.
6. **Spec self-review** — fix placeholders, contradictions, ambiguity, scope problems inline
7. **User reviews written spec** — "Spec at `<path>`. Review before we plan implementation."
8. **Transition to planning** — invoke `Skill(planning)` to create the implementation plan

## Process

**Understanding the idea**

- Check current project state first.
- If the request describes multiple independent subsystems (e.g., "build a platform with chat, file storage, billing"), flag it immediately. Help decompose into sub-projects, each with its own design → plan → implementation cycle.
- For appropriately-scoped projects, ask one question per message. Prefer multiple-choice.

**Exploring approaches**

- 2–3 alternatives with trade-offs. Lead with your recommendation.

**Presenting the design**

- Scale sections to complexity. Confirm after each.
- Cover: architecture, components, data flow, error handling, testing.
- Be ready to revise.

**Design for isolation and clarity**

- Break the system into small units with one purpose, well-defined interfaces, independently testable.
- For each unit: what does it do, how do you use it, what does it depend on?
- Smaller files reason better. When a file grows large, that's often a signal it's doing too much.

**Working in existing codebases**

- Explore current structure first. Follow existing patterns.
- Where existing code has problems that affect the work (file grown too large, unclear boundaries), include targeted improvements as part of the design.
- Don't propose unrelated refactoring.

## After the design

**Spec self-review (run inline, no re-review):**

1. **Placeholder scan** — "TBD", "TODO", incomplete sections, vague requirements. Fix.
2. **Internal consistency** — sections contradict? Architecture matches features?
3. **Scope check** — focused enough for a single plan, or needs decomposition?
4. **Ambiguity check** — could any requirement be interpreted two ways? Pick one, make it explicit.
5. **Provenance check** — every load-bearing decision (one the rest of the design rests on) tags to a source: a user quote, an answer you explicitly requested, or "my judgment — rationale: X." Equivalence claims ("mirrors X exactly", "byte-identical") are testable — back them with evidence or use qualified wording ("approximates").

**User review gate:**

> "Spec written and committed to `<path>`. Please review it and let me know if you want to make any changes before we start writing out the implementation plan."

Wait for explicit approval. Then invoke `Skill(planning)`.

## Key principles

- **One question at a time** — don't overwhelm
- **Multiple choice preferred** — easier to answer
- **YAGNI ruthlessly** — remove unnecessary features
- **Explore alternatives** — always 2–3 approaches before settling
- **Incremental validation** — present, approve, move on
- **Be flexible** — revisit when something doesn't make sense

## Anti-patterns

- "This is too simple to need a design" — every project goes through this.
- Combining the visual-companion offer (if applicable) with a clarifying question — it's its own message.
- Invoking any implementation skill (e.g., `frontend-design-essentials`, `go-mcp`, language-specific skills) from INSIDE brainstorming. Brainstorming is design-time; implementation skills are post-planning. The ONLY skill you invoke at the END of brainstorming is `Skill(devkit:planning)`.

## Terminal state

The only valid next skill is `Skill(devkit:planning)`.
