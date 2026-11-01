---
name: testing-strategy
description: Use when deciding what to test where — unit vs integration vs e2e proportions, flaky test triage, coverage as signal, chaos at the edges.
metadata:
  added: 2026-05-18
  last_reviewed: 2026-05-18
  type: domain
  status: active
  invokes_shell: false
  shell_reviewed: "valksor 2026-05-17"
  related: [testing-property-based, testing-fuzzing-mutation, tdd, debugging, root-cause]
---

# Testing Strategy

**Iron Law: behavior-coverage beats line-coverage. Unit for invariants, integration for collaboration, e2e for user journeys. Flakes are bugs, not noise.**

## The pyramid (proportions matter)

| Tier            | Speed             | Confidence per test   | Maintenance | Healthy share |
| --------------- | ----------------- | --------------------- | ----------- | ------------- |
| **Unit**        | ms (sub-ms ideal) | Low (one piece)       | Low         | Most          |
| **Integration** | 100ms–10s         | High (a real seam)    | Medium      | Fewer         |
| **E2E**         | seconds–minutes   | Highest (whole stack) | High        | Fewest        |

Inverted ratio (many e2e, few unit) is a "test ice-cream cone" — slow, flaky, expensive.

## What each tier proves

| Tier            | Proves                                                                      |
| --------------- | --------------------------------------------------------------------------- |
| **Unit**        | One function/method behaves correctly on its inputs (invariants)            |
| **Integration** | Real components fit together at the seams — DB, HTTP, messaging, filesystem |
| **E2E**         | The full system delivers a user-visible journey                             |
| **Chaos**       | Behavior under injected faults (network, process, resource, time)           |
| **Property**    | Invariants hold across generated inputs (`Skill(testing-property-based)`)   |
| **Fuzz**        | No crashes for any input (`Skill(testing-fuzzing-mutation)`)                |
| **Mutation**    | Tests _fail_ when code is broken (`Skill(testing-fuzzing-mutation)`)        |

## Unit — fast, isolated, deterministic, one behavior

A unit is the smallest piece you'd change independently. **Not** a layer, not a module. Touches the network/disk/clock/DB → not a unit.

**AAA — Arrange, Act, Assert.** Two Acts = two tests.

```pseudo
def test_discount_caps_at_50_percent():
    # Arrange
    cart = Cart(items=[item(price=100)])
    coupon = Coupon(percent=80)
    # Act
    total = cart.apply(coupon).total()
    # Assert
    assert total == 50  # capped, not 20
```

**Names = documentation.** Pattern: `test_<thing>_<condition>_<expected>`. "And" in the name = split it.

**Isolation ≠ mock-everything.** Pure functions and small immediate collaborators: use the real thing. Mock external boundaries only.

**Don't test the framework.** Test the contract _you_ added, not the ORM's filter.

**Kill wobble:** inject the clock; seed PRNGs; sort before asserting; tolerances for floats; tmp dir fixtures; explicit env per test.

## Integration — real seams, real components

Real DB in a container. Real HTTP server on ephemeral port. Real client.

You need integration tests when:

- **Contract mismatch** (mocks lie — `user_id` vs `userId`).
- **Transaction/concurrency behavior** (isolation, locking, deadlocks).
- **Serialization/framing** (JSON edges, charsets, time zones).
- **Configuration glue** (env vars, secret loading, pool sizing).
- **N+1 / chattiness** (only visible against real latency).
- **Migration safety** (schema changes that compile but break runtime).

**Test data discipline** — pick one and stick with it:

| Strategy                               | Trade-off                                        |
| -------------------------------------- | ------------------------------------------------ |
| Empty DB per test (or per class)       | Easy to reason; slower per test, faster to debug |
| Shared baseline + transaction rollback | Fast; harder to debug pollution                  |

Never share mutable records ("the test user with id=1"). One test renames it, the next breaks.

**Don't sleep — poll** on the actual condition (`wait_for(predicate, timeout=...)`). Bind to port 0 and read back. Freeze the clock at the boundary.

If your integration suite takes 40 minutes, you run it nightly and bugs reach `main`. Parallelize, reuse containers across tests, scope DB state per class.

## E2E — few, focused, robust

A confidence tool, not a coverage tool. **A few dozen e2e tests is plenty. Hundreds is a smell.**

For: sign up, log in, place order, password reset, smoke tests on deploy, cross-browser when that's a real concern.

**Not for:** every form field (unit/integration), every permission matrix (unit), validating component logic (component tests).

| Pattern                             | Notes                                                                   |
| ----------------------------------- | ----------------------------------------------------------------------- |
| **Page Object Model**               | Wrap each page; selectors in one file; tests read like user intent      |
| **Selectors**                       | `data-testid` > accessible name/role > visible text > CSS class > XPath |
| **Auto-wait, never sleep**          | Wait on the _outcome_ ("URL is `/orders/123`"), not the animation       |
| **Seed via API**                    | Not via UI — UI seeding is itself flaky and slow                        |
| **Disable animations in test mode** | Pure flake fuel                                                         |
| **Capture artifacts on failure**    | Video, screenshot, network log, console log — CI uploads them           |

Smoke (≤10) runs on every deploy, < 2 min. Regression (the rest) runs nightly/pre-release, < 30 min.

CI retries hide flakes. Retry max once _with telemetry_; track flake rate.

## Flaky tests — root cause, not retry

A flake is either a bug in the test or a bug in the system, and the second case ships.

**Triage procedure:**

1. Reproduce in a loop before changing anything:
   `for i in $(seq 20); do npx --no-install vitest run <file> || { echo "failed on run $i"; break; }; done`
   (add `--sequence.shuffle` for ordering; read the output, since the loop's exit status does
   not tell you), `go test -count=50 -race -shuffle=on ./pkg/...`, or `pytest --count=50` /
   `pytest -p randomly` only when pytest-repeat / pytest-randomly is already a dev dependency.
   Never install a package just to reproduce.
2. Name the cause from the table below before editing.
3. Change an assertion only to match the spec, never to make it pass.
4. Stable means the reproduce loop passes in full, then the whole suite passes twice in a row.
5. After three failed fixes, stop and report what you tried (see `debugging`).

| Cause                   | Symptom                               | Fix                                                                   |
| ----------------------- | ------------------------------------- | --------------------------------------------------------------------- |
| **Time**                | Fails near midnight / DST / leap day  | Inject + freeze clock; test "+1 hour" not "23:30"                     |
| **Network**             | Fails on slow CI                      | Don't talk to real network; if you must, retry in setup not assertion |
| **Ordering**            | Fails when test order changes         | Per-test isolation; randomize order locally to catch dependencies     |
| **Shared state**        | Fails under parallelism               | Own DB schema / tmp dir / port per test                               |
| **Randomness**          | Fails with a specific seed            | Set seed deterministically; log seed on failure                       |
| **Race condition**      | Fails under load / on slower machines | Wait on the actual condition (poll), never `sleep()`                  |
| **Floating point**      | `0.30000000000000004`                 | Compare with tolerance                                                |
| **Iteration order**     | Fails after Python/Go map change      | Sort before asserting                                                 |
| **Data leakage**        | Fails when previous test ran          | Tear down; never trust clean state                                    |
| **External services**   | Fails when 3rd-party API down         | Mock at the boundary; contract-test the real API separately           |
| **Resource exhaustion** | Fails under memory pressure           | Fix leak; bound fixture resources                                     |

When investigating, walk this list. Cause is here 95% of the time.

**Anti-fixes that make flakes worse:**

| Anti-fix                                     | Why it's wrong                    |
| -------------------------------------------- | --------------------------------- |
| `sleep(2)`                                   | Slower _and_ still flaky          |
| `@retry(3)` on the test                      | Hides the bug; ships to prod      |
| Excluding the test indefinitely              | Migrates the flake to other tests |
| Catching the exception and asserting nothing | Always-passes, asserts-nothing    |
| "Run only on Linux because Windows is flaky" | Bug is in your code               |

**Sometimes the test is fine and production has a race.** Tells: fails more under high parallelism; needs multiple threads; adding logging "fixes" it (memory barrier in disguise); fix is "added a lock." Treat as priority bugs.

## Coverage — signal, not goal

Coverage tells you what _ran_. It does not tell you what was _checked_. Smoke detector, not thermometer.

| Kind               | Measures                       | Misses                                                             |
| ------------------ | ------------------------------ | ------------------------------------------------------------------ |
| **Line/Statement** | Each line ran                  | Branches; assertions                                               |
| **Branch**         | Each branch taken              | Combinations                                                       |
| **Condition**      | Each boolean to T and F        | Combinations                                                       |
| **Mutation score** | Tests fail when code is broken | The actually-useful metric — see `Skill(testing-fuzzing-mutation)` |

**Default to branch coverage** as the reportable number. Line coverage alone hides untested branches.

**Coverage is useful for:** spotting modules at 0%, PR drops on changed files, finding dead code.

**Coverage is not useful for:** proving correctness, comparing teams/projects, justifying release readiness.

**Why 100% is a smell:** tests written just to hit a line (no assertion), tests of trivial getters, "can't happen" branches with contrived inputs, mocks-of-mocks. Marginal cost rises steeply past ~85%; marginal value falls. Most healthy projects: 70-85% branch on parts that matter, _measured_ gaps elsewhere.

**Per-module floors beat global thresholds.** `core/ ≥ 85%`, `cmd/ ≥ 40%`, generated excluded with a comment explaining why.

## Chaos — at the boundary tier

Use chaos when: distributed system, defined SLO, non-obvious failure modes, on-call team that needs muscle memory.

Don't use it for: single-process apps; pre-MVP without basic tests; systems with no kill switch.

**Failure modes worth injecting:** network (latency, loss, partition, DNS), process (kill, pause, restart), resource (CPU, memory, disk, fd), time (skew, jump), dependency (500, slow, wrong data), state (stale/corrupt/cold cache).

**Game days:** scheduled, planned exercises — pick a scenario, write hypothesis, define abort criteria, run, compare, file findings. Run monthly/quarterly.

**CI-integrated chaos:** existing integration tests with injected faults; `toxiproxy` / `tc netem` in test containers. `tc netem` requires `--cap-add=NET_ADMIN`; without it `tc` exits 0 silently and the chaos test passes vacuously. Assert injection with `tc qdisc show` before asserting behavior.

**Steady-state metrics first.** If you can't measure "is the system OK?" in real time, chaos is just sabotage.

## Anti-patterns

- 100% line coverage as a goal
- Retry-on-flake (`--reruns`, `@retry(3)`)
- E2E for everything (ice-cream cone)
- Mocking all collaborators (test is now coupled to implementation)
- Unit tests that talk to real DB/network
- "Investigated, no root cause found" — usually "ran twice, gave up"
- "Add a sleep, it'll be fine"
- Calling a flake "intermittent" — same word, hidden bug
- Re-running CI until green and merging
- Chaos with no SLO, no kill switch, or no runbook
- Coverage as the testing KPI

## Hand-off

Invariants beyond examples: `Skill(testing-property-based)`. Crash-finding + assertion strength: `Skill(testing-fuzzing-mutation)`. TDD: `Skill(tdd)`. Bug triage: `Skill(debugging)` → `Skill(root-cause)`. Language runners: `Skill(python-testing)`, `Skill(go-testing)`, `Skill(rust-testing)`, `Skill(react)`, `Skill(typescript)`.
