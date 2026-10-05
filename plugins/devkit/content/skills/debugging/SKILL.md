---
name: debugging
description: Use for any bug, test failure, or unexpected behavior before proposing fixes — root-cause, hypothesis, implementation. No fix without root cause.
metadata:
  added: 2026-05-18
  last_reviewed: 2026-05-18
  type: core
  status: active
  invokes_shell: false
  shell_reviewed: "valksor 2026-05-17"
  related: [root-cause, tdd]
  owns: debugging
---

# Systematic Debugging

Random fixes waste time and create new bugs. Quick patches mask underlying issues.

**Core principle:** ALWAYS find the root cause before attempting fixes. Symptom fixes are failure.

## The Iron Law

```
NO FIXES WITHOUT ROOT CAUSE INVESTIGATION FIRST
```

If you haven't completed Phase 1, you cannot propose fixes.

## When to use

Any technical issue: test failures, production bugs, unexpected behavior, performance problems, build failures, integration issues. Especially when:

- Under time pressure (emergencies make guessing tempting)
- "Just one quick fix" seems obvious
- You've already tried multiple fixes
- Previous fix didn't work
- You don't fully understand the issue

Don't skip when the issue "seems simple" — simple bugs have root causes too.

## The four phases

### Phase 1: Root cause investigation

**Before any fix:**

1. **Read error messages carefully** — don't skip past. Note line numbers, file paths, codes. Read full stack traces.
2. **Reproduce consistently** — exact steps, every time. Not reproducible → gather more data, don't guess.
3. **Check recent changes** — `git diff`, recent commits, new deps, config changes, environmental differences.
4. **Gather evidence in multi-component systems** — log data at each boundary (workflow → script → tool → output). Run once to see WHERE it breaks. THEN investigate that specific layer.
5. **Trace data flow backward** — where does the bad value originate? What called this with the bad value? Trace up until you find the source. Fix at source, not at symptom.

### Phase 2: Pattern analysis

1. **Find working examples** — locate similar working code in the same codebase
2. **Compare against references** — if implementing a pattern, read the reference implementation completely. Don't skim.
3. **Identify differences** — list every difference between working and broken. Don't assume "that can't matter."
4. **Understand dependencies** — what other components, settings, config does it need?

### Phase 3: Hypothesis and testing

1. **Form a single hypothesis** — "I think X is the root cause because Y." Be specific.
2. **Test minimally** — smallest possible change. One variable at a time. Don't fix multiple things at once.
3. **Verify before continuing** — worked? Phase 4. Didn't? New hypothesis. Don't pile fixes.
4. **When you don't know, say so** — don't pretend. Ask for help. Research more.

### Phase 4: Implementation

1. **Create a failing test case** — automated if possible, one-off script if not. Use `Skill(tdd)`.
2. **Implement single fix** — one change. No "while I'm here" improvements. No bundled refactoring.
3. **Verify fix** — test passes? Other tests still pass? Issue actually resolved?
4. **If the fix doesn't work** — STOP. Count attempted fixes. < 3? Return to Phase 1 with new info. ≥ 3? Question the architecture (next step).
5. **If 3+ fixes failed: question the architecture** — pattern indicating architectural problem: each fix reveals new coupling/state in different places; fixes require "massive refactoring"; each fix creates new symptoms elsewhere. **Stop**. Discuss with the user before attempting more fixes. This is not a failed hypothesis — this is a wrong architecture.

## Red flags — stop and follow the process

- "Quick fix for now, investigate later"
- "Just try changing X and see if it works"
- "Skip the test, I'll manually verify"
- "It's probably X, let me fix that"
- "Pattern says X but I'll adapt it differently"
- Proposing solutions before tracing data flow
- "One more fix attempt" (when already tried 2+)
- Each fix reveals a new problem in a different place

All mean: STOP. Return to Phase 1.

## Quick reference

| Phase             | Activities                                             | Success criteria            |
| ----------------- | ------------------------------------------------------ | --------------------------- |
| 1. Root cause     | Read errors, reproduce, check changes, gather evidence | Understand WHAT and WHY     |
| 2. Pattern        | Find working examples, compare                         | Identify differences        |
| 3. Hypothesis     | Form theory, test minimally                            | Confirmed or new hypothesis |
| 4. Implementation | Create test, fix, verify                               | Bug resolved, tests pass    |

## Common rationalizations

| Excuse                   | Reality                                    |
| ------------------------ | ------------------------------------------ |
| "Issue is simple"        | Simple issues have root causes too         |
| "Emergency, no time"     | Systematic is FASTER than guess-and-check  |
| "Just try this first"    | First fix sets the pattern. Do it right.   |
| "I'll write test after"  | Untested fixes don't stick                 |
| "Multiple fixes at once" | Can't isolate what worked                  |
| "I see the problem"      | Seeing symptoms ≠ understanding root cause |

## When process reveals "no root cause"

If systematic investigation truly shows the issue is environmental or external:

1. Document what you investigated
2. Implement appropriate handling (retry, timeout, error message)
3. Add monitoring/logging for future investigation

But: 95% of "no root cause" cases are incomplete investigation.

## Real-world impact

Systematic: 15–30 min to fix. Random fixes: 2–3 hours of thrashing. First-time fix rate: 95% vs 40%. New bugs introduced: near zero vs common.
