---
name: dispatching-parallel-agents
description: Use for 2+ INDEPENDENT investigations runnable CONCURRENTLY — one agent per domain. Investigation, not implementation, vs subagent-driven-development.
metadata:
  keywords: [concurrent]
  added: 2026-05-18
  last_reviewed: 2026-05-18
  type: core
  status: active
  invokes_shell: false
  shell_reviewed: "valksor 2026-05-17"
  related: [subagent-driven-development, debugging]
  owns: parallel-agents
---

# Dispatching Parallel Agents

**Iron Law: one agent per INDEPENDENT problem domain. Never parallelize when failures share state, when agents would edit the same files, or when one fix could resolve multiple symptoms — investigate sequentially first.**

You delegate tasks to specialized agents with isolated context. Their instructions must be precise — they never inherit your session's context. You construct exactly what they need, which also preserves your own context for coordination.

## When to use

| Use when                                         | Don't use when                                              |
| ------------------------------------------------ | ----------------------------------------------------------- |
| 3+ test files failing with different root causes | Failures are related (one fix could resolve multiple)       |
| Multiple subsystems broken independently         | You need full system context to understand                  |
| Each problem stands alone without shared context | Exploratory debugging — you don't know what's broken yet    |
| No shared state, no overlapping file edits       | Agents would interfere (editing same files, same resources) |

## The pattern

### 1. Identify independent domains

Group failures by what's broken:

- File A tests: tool approval flow
- File B tests: batch completion behavior
- File C tests: abort functionality

Each domain is independent — fixing tool approval doesn't affect abort tests.

### 2. Create focused agent tasks

Each agent gets:

- **Specific scope** — one test file or subsystem
- **Clear goal** — make these tests pass
- **Constraints** — don't change other code
- **Expected output** — summary of what you found and fixed

### 3. Dispatch in parallel

Single message, multiple Agent tool calls:

```
Agent("Fix agent-tool-abort.test.ts failures")
Agent("Fix batch-completion-behavior.test.ts failures")
Agent("Fix tool-approval-race-conditions.test.ts failures")
```

All three run concurrently.

### 4. Review and integrate

When agents return:

- Read each summary
- Verify fixes don't conflict
- Run full test suite
- Integrate all changes

## Agent prompt structure

```markdown
Fix the 3 failing tests in src/agents/agent-tool-abort.test.ts:

1. "should abort tool with partial output capture" — expects 'interrupted at' in message
2. "should handle mixed completed and aborted tools" — fast tool aborted instead of completed
3. "should properly track pendingToolCount" — expects 3 results but gets 0

These are timing/race-condition issues. Your task:

1. Read the test file and understand what each verifies
2. Identify root cause — timing or actual bugs?
3. Fix by:
   - Replacing arbitrary timeouts with event-based waiting
   - Fixing bugs in abort implementation if found
   - Adjusting test expectations if testing changed behavior

Do NOT just increase timeouts — find the real issue.

Return: summary of what you found and what you fixed.
```

## Common mistakes

| ❌                                               | ✅                                                  |
| ------------------------------------------------ | --------------------------------------------------- |
| "Fix all the tests" (too broad)                  | "Fix agent-tool-abort.test.ts" (focused scope)      |
| "Fix the race condition" (no context)            | Paste the error messages and test names             |
| No constraints (agent might refactor everything) | "Do NOT change production code" or "Fix tests only" |
| "Fix it" (vague output)                          | "Return summary of root cause and changes"          |

## Verification + failure handling

After agents return:

1. **Review each summary** — understand what changed.
2. **Check for conflicts** — did agents edit the same code?
3. **Run the full suite** — verify all fixes work together.
4. **Spot check** — agents can make systematic errors.

**When one agent fails / returns nothing / times out**: re-dispatch the same agent solo with the original error context verbatim and a narrower FILE SCOPE (e.g., specific file paths instead of a directory). If the second run also fails (context overrun, sandbox restriction, tool error), investigate sequentially yourself — do NOT re-dispatch the full parallel batch. Per-agent context budget matters: dispatching 5+ agents with broad read permissions can saturate each agent's context mid-task; cap file reads or scope the prompt to a specific path tree.

**Secrets in agent summaries.** Agent return summaries land in your context (and via hooks may land in `.claude/logs/` or audit trails). If an agent investigates env-var loading, integration tests, or any path that touches credentials, instruct it in the prompt: "Never echo or quote environment variable values, file contents under `.env*`, or any token-shaped string in your summary — refer to them by name only." A `DATABASE_URL=postgres://admin:hunter2@host/db` in a summary persists in logs forever.

## Anti-patterns

- Parallel dispatch when failures share state or files — one agent's edit conflicts the others'
- Vague prompts ("fix it") with no scope, constraints, or expected return shape
- Re-dispatching the full batch when one agent fails — investigate sequentially after second failure
- Asking agents to summarize files containing secrets without an explicit redaction instruction

## Hand-off

For sequential plan execution (the inverse pattern — one agent at a time advancing through a plan): `Skill(subagent-driven-development)`. For per-agent debugging when one returns wrong: `Skill(debugging)`.
