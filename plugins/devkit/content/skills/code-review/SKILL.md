---
name: code-review
description: Use when reviewing code or requesting a review — what reviewers should catch and which reviewer to dispatch.
metadata:
  added: 2026-05-18
  last_reviewed: 2026-05-27
  type: core
  status: active
  invokes_shell: false
  shell_reviewed: "valksor 2026-05-18"
  related: [security, receiving-code-review, subagent-driven-development, tdd, finishing-a-development-branch]
  keywords: [silent failures, weak types, comment rot, missing tests]
---

# Code Review

**Iron Law: read for what's MISSING, not just what's there. Silent failures, comment rot, weak types, untested edge cases — those are the bugs reviewers should catch. Review early, review often; dispatch a reviewer subagent so your session stays focused.**

## Severity rubric

| Severity        | Examples                                                                                                  | Action                                     |
| --------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| **Block**       | swallowed error, untested security-sensitive branch, type that lets wrong states exist, comment that lies | Request changes                            |
| **Strong push** | primitive obsession in a public signature, missing edge-case test, stale TODO with no owner/trigger       | Request changes; accept ticketed follow-up |
| **Suggest**     | rename for clarity, extract helper, doc-comment polish                                                    | Comment, approve if otherwise sound        |
| **Style**       | formatter would catch it                                                                                  | Don't bring up — fix the formatter         |

If 80% of your comments are Style, you're reviewing wrong.

A finding that only swaps one acceptable choice for another is noise — review lands value by fixing what's broken, not by relitigating taste. Reversing a deliberate, equally-valid choice is how review oscillates across sessions (one pass swaps A→B, the next swaps B→A) and never converges.

## Silent failures — the bugs that hide

Loud by default. Silence is a deliberate, documented choice — never an accident.

| Anti-pattern                                   | Why it hides                                                |
| ---------------------------------------------- | ----------------------------------------------------------- |
| `except Exception: pass` / `catch(e){}`        | error class unknown, caller has no signal                   |
| `result, _ := op()` (Go)                       | error discarded; partial write, silent corruption           |
| `user.name \|\| "Anonymous"`                   | API errored → user is "Anonymous" forever                   |
| `api.get() or {}` then iterate                 | None-on-error becomes empty loop; nothing logged            |
| Promise returned, not `await`-ed / `.catch`-ed | unhandled rejection in Node = warning today, crash tomorrow |
| `go process(item)` with no recover             | panic in goroutine takes the process or leaks               |
| `logger.error(e); return None`                 | caller can't tell success from failure                      |
| `try: int(env["X"]); except: 30`               | typo `3O` silently uses default; no warning                 |
| `order?.items?.x ?? 0` everywhere              | masking an invariant — if order _should_ exist, assert      |

**The right shape — two functions, names disambiguate**:

```python
def get_user(uid):              # raises; loud
    user = db.find(uid)
    if not user: raise NotFound(f"user {uid}")
    return user

def get_user_or_none(uid):      # silent BY DESIGN; doc'd
    """Returns None for not-found. Other errors raise."""
    try: return get_user(uid)
    except NotFound: return None
```

Silence-is-correct cases: cleanup on shutdown (best-effort + log), idempotent retries, cancellation (`context.Canceled`), missing optional dep. Comment must say so.

## Type design — make wrong states unrepresentable

**Parse, don't validate**: once a value has the type, the invariant is a fact, not a promise.

```python
class Email:
    def __init__(self, raw: str):
        if "@" not in raw: raise ValueError("invalid email")
        self._raw = raw
def send(email: Email): ...      # cannot be called with an unverified string
```

**Score every new type** (low on all four = noise; high on two+ = earns it):

| Dimension            | Question                                                          |
| -------------------- | ----------------------------------------------------------------- |
| Encapsulation        | are internals hidden from callers?                                |
| Invariant expression | can the type hold a value that breaks the rule?                   |
| Usefulness           | does it buy clarity at the call site?                             |
| Enforcement          | does compiler/runtime catch misuse, or is comment the only guard? |

**Branded / nominal types** for cheap nominal typing without classes — `type UserId = string & { readonly __brand: "UserId" }` (TS); `type UserID string` (Go). `getUser(orderId)` becomes a type error.

**Sum types over flag soup** — when fields are only present in some states, use a discriminated union:

```ts
type Job =
  | { status: "pending" }
  | { status: "running"; startedAt: Date }
  | { status: "done"; startedAt: Date; completedAt: Date; resultUrl: string }
  | { status: "failed"; startedAt: Date; completedAt: Date; errorMessage: string };
```

`status === "done"` proves `resultUrl` exists — no `if (resultUrl)` defensive scatter.

**Primitive obsession**: 3+ primitives in 2+ signatures → introduce the type. `transfer(from, to, amount, currency, key, dryRun)` → `transfer(TransferRequest)`.

**Don't introduce a type** for one-call-deep helpers, pure data with no invariants, or test fixtures.

## Comment analysis — unverified prose

A wrong comment is worse than no comment. Compilers don't read them; tests don't run them; refactors don't update them.

| Pattern                                               | Action                         |
| ----------------------------------------------------- | ------------------------------ |
| Restates the code (`i = i + 1  # increment i`)        | delete                         |
| Lies (says "returns email", returns phone)            | block — fix                    |
| Cites a stale limitation                              | verify; remove or update       |
| Anonymous `TODO:` with no owner/trigger               | block — add both or delete     |
| `FIXME` / `XXX` with no reason it shipped             | block                          |
| Banner for a section that got refactored              | delete                         |
| `// @ts-ignore` / `# noqa` / `# nosec` with no reason | block — reason IS the artefact |

**Useful comments answer "why, not what"** — e.g., `# Use a smaller buffer here — server times out >4KB requests (see #3421)`. **TODO discipline**: owner + trigger + quarterly sweep — `TODO(jane, before 2.0):`, not anonymous. For comments **not in the diff** but in the touched function: did this PR invalidate them? Then the PR owns updating them.

## Test coverage — behaviour, not lines

Coverage tells you what _ran_, not what was _verified_. A test that asserts nothing gives green coverage.

| Gap                  | Pattern                                                       |
| -------------------- | ------------------------------------------------------------- |
| Boundary values      | happy values tested; bugs at 0, -1, MAX_INT, "", null, `"🦄"` |
| Empty/single-element | `[1,2,3]` works; `[]` and `[x]` break                         |
| Concurrent paths     | tested sequentially; race lives between `if` and `then`       |
| Error paths          | happy path covered; `if err != nil` arm tested by nobody      |
| Side effects         | function called; DB write/log/email never asserted            |
| Time/TZ/encoding     | en-US/UTC works; breaks in JP, with non-ASCII, at DST         |
| Floats               | `1.0` works; `0.1 + 0.2` breaks                               |

**For each function in the diff**: what happens at the edges? "No test exists" = the gap.

**Coverage smells**: new public function with only happy-path test; bugfix PR with no regression test; test mocks the thing under test; one giant integration test "covers" everything; coverage drops on a "no behaviour change" PR.

**Ask for a specific behaviour, not "more coverage"**: "add a test for `n=0`"; "force the dependency to fail and assert the right thing happens"; "regression test named after the bug ID".

Mutation testing (mutmut/Stryker/PIT/go-mutesting) on critical paths: flip `+` to `-` — if the suite passes, the test never verified the operator.

## Anti-patterns in the review itself

- Rubber-stamp approve ("LGTM" with no evidence you read it)
- Focusing only on style — formatter does that
- "Add try/except around it" — understand the failure first
- "Default to empty so the test passes" — the test is telling you a real bug
- "TODO: fix later" / "address in follow-up" accepted as resolution
- Asking for "more coverage" without naming a specific behaviour
- Bike-shedding naming when the type is wrong
- Proposing a lateral rewrite of working code because you'd have written it differently
- Reversing a deliberate, equally-valid choice without showing it's actually wrong
- Approving a PR with comments unresolved

## Requesting a review — dispatching a subagent

Mandatory: after each subagent-driven task; after a major feature; before merge to main. Optional but valuable: when stuck (fresh eyes); before a refactor (baseline); after a complex bugfix.

**Dispatch:**

```bash
BASE_SHA=$(git rev-parse HEAD~1)         # or origin/main
HEAD_SHA=$(git rev-parse HEAD)
```

Use `Agent(code-reviewer)` for single-perspective review. For plans or major implementations, use devkit's calibrated review (`bb devkit review plan <path>` or `bb devkit review impl <base>..<head>`) — both apply the calibrated five-reviewer cohort:

- `reviewer-senior-dev` — architecture, maintainability, complexity
- `reviewer-senior-qa` — testability, edge cases, failure modes
- `reviewer-security` — auth, injection, supply chain, secrets
- `reviewer-end-user` — usability, error messages, docs
- `reviewer-compliance` — privacy, licensing, regulatory obligations

**Reviewer prompt template:**

> Review changes between `<BASE_SHA>` and `<HEAD_SHA>`.
> What was built: <description>. Requirements: <plan reference or pasted text>.
> Constraints: do not flag tests/fixtures/\* (intentionally simple); do not refactor unrelated production code.
> Return: Strengths, Critical issues, Important issues, Minor issues, Assessment (ready / needs work).

Act on feedback: **Critical** → fix immediately; **Important** → fix before proceeding; **Minor** → note for later; **Reviewer wrong** → push back with technical reasoning via `Skill(receiving-code-review)`.

## Red flags

| Sign                                         | Reality                                |
| -------------------------------------------- | -------------------------------------- |
| "It's just a small change"                   | look at blast radius, not size         |
| Diff has tests but coverage didn't move      | tests not running, or not asserting    |
| New public type with no docstring            | who's the caller? what's the contract? |
| Comment changed, code didn't (or vice versa) | one is now wrong                       |
| Author can't explain WHY a line is there     | needs a comment, a test, or a deletion |
| Reviewer skipped because "it's simple"       | always at least a self-review pass     |

## Hand-off

For security-specific review (OWASP, authn, injection, secrets, supply chain): `Skill(security)`. When the missing piece is a test: `Skill(tdd)`. When responding to feedback you've received: `Skill(receiving-code-review)`. Before finishing the branch: `Skill(finishing-a-development-branch)`.
