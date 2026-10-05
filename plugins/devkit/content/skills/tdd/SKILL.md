---
name: tdd
description: Use when implementing any feature or bugfix — Red-Green-Refactor. No production code without a failing test first.
metadata:
  added: 2026-05-18
  last_reviewed: 2026-05-18
  type: core
  status: active
  invokes_shell: false
  shell_reviewed: "valksor 2026-05-17"
  related: [debugging, refactoring, code-review]
  owns: tdd
---

# Test-Driven Development (TDD)

Write the test first. Watch it fail. Write minimal code to pass.

**Core principle:** if you didn't watch the test fail, you don't know if it tests the right thing.

## The Iron Law

```
NO PRODUCTION CODE WITHOUT A FAILING TEST FIRST
```

Wrote code before the test? **Delete it. Start over.** Don't keep it as reference, don't "adapt" it while writing tests, don't even look at it. Implement fresh from tests.

## When to use

Always: new features, bug fixes, refactoring, behavior changes.

Exceptions (ask first): throwaway prototypes, generated code, configuration files.

Thinking "skip TDD just this once"? Stop. That's rationalization.

## Red-Green-Refactor

### RED — write failing test

One minimal test showing what should happen. One behavior, clear name, real code (no mocks unless unavoidable).

```python
def test_retries_failed_operations_3_times():
    attempts = 0
    def op():
        nonlocal attempts
        attempts += 1
        if attempts < 3:
            raise ValueError("fail")
        return "success"
    assert retry_operation(op) == "success"
    assert attempts == 3
```

### Verify RED — watch it fail

**Mandatory. Never skip.** Run the test. Confirm:

- It fails (doesn't error on syntax/import)
- The failure message is what you expected
- It fails because the feature is missing (not a typo)

Passes? You're testing existing behavior — fix the test.
Errors? Fix the error, re-run until it fails correctly.

### GREEN — minimal code

Simplest code to pass the test. No extra features, no "while I'm here" refactoring.

### Verify GREEN — watch it pass

Mandatory. All tests pass, output pristine (no warnings).

### REFACTOR — clean up

After green only. Remove duplication, improve names, extract helpers. Keep tests green. Don't add behavior.

## Good tests

| Quality      | Good                                | Bad                                              |
| ------------ | ----------------------------------- | ------------------------------------------------ |
| Minimal      | One thing. "and" in name? Split it. | `test_validates_email_and_domain_and_whitespace` |
| Clear        | Name describes behavior             | `test_test1`                                     |
| Shows intent | Demonstrates desired API            | Obscures what code should do                     |

## Common rationalizations

| Excuse                           | Reality                                                                 |
| -------------------------------- | ----------------------------------------------------------------------- |
| "Too simple to test"             | Simple code breaks. Test takes 30 seconds.                              |
| "I'll test after"                | Tests passing immediately prove nothing.                                |
| "Tests after achieve same goals" | Tests-after = "what does this do?" Tests-first = "what should this do?" |
| "Already manually tested"        | Ad-hoc ≠ systematic. No record, can't re-run.                           |
| "Deleting hours is wasteful"     | Sunk cost fallacy. Unverified code is technical debt.                   |
| "Need to explore first"          | Fine — throw away exploration, start over with TDD.                     |
| "Test hard = design unclear"     | Listen to the test. Hard to test = hard to use.                         |
| "TDD slows me down"              | TDD faster than debugging. Pragmatic = test-first.                      |

## Red flags — stop and start over

- Code before test
- Test after implementation
- Test passes immediately
- Can't explain why test failed
- "I already manually tested it"
- "Keep as reference" / "adapt existing code"
- "Already spent X hours, deleting is wasteful"
- "This is different because…"

All mean: delete code, start over with TDD.

## Verification checklist

Before marking work complete:

- [ ] Every new function/method has a test
- [ ] Watched each test fail before implementing
- [ ] Each test failed for expected reason (feature missing, not typo)
- [ ] Wrote minimal code to pass each test
- [ ] All tests pass
- [ ] Output pristine
- [ ] Tests use real code (mocks only if unavoidable)
- [ ] Edge cases and errors covered

Can't check all? You skipped TDD. Start over.

## When stuck

| Problem                | Solution                                                         |
| ---------------------- | ---------------------------------------------------------------- |
| Don't know how to test | Write the wished-for API first. Write assertion first. Ask user. |
| Test too complicated   | Design too complicated. Simplify interface.                      |
| Must mock everything   | Code too coupled. Use dependency injection.                      |
| Setup huge             | Extract helpers. Still complex? Simplify design.                 |

## Debugging integration

Bug found? Write a failing test reproducing it. Follow TDD. Test proves the fix and prevents regression. Never fix bugs without a test.

## Final rule

```
Production code → test exists and failed first
Otherwise → not TDD
```

No exceptions without explicit user permission.
