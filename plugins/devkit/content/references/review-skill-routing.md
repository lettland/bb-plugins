# Review skill routing

Shared procedure for `/devkit:review-code`, `/devkit:review-impl`, and `/devkit:review-plan`.
It turns "what's under review" into a small, per-reviewer set of skill slugs that each
reviewer loads (via the `Skill` tool) before reviewing, so stack-specific idioms and
pitfalls inform the findings.

This is a **routing procedure, not a static skill catalog** — the live slug set comes from
`Skill(skill-discovery)` at runtime, so newly added skills are picked up automatically.

## Step 1 — Detect the stack

Build the set of language/stack **keywords** present in what's under review.

Primary signal — changed file extensions (review-code / review-impl) or files named in the
plan (review-plan):

| Extension / file                     | Keyword(s)                        |
| ------------------------------------ | --------------------------------- |
| `.go`                                | `go`                              |
| `.py`, `.pyi`                        | `python`                          |
| `.ts`, `.mts`, `.cts`                | `typescript`                      |
| `.tsx`, `.jsx`                       | `typescript`, `react`, `frontend` |
| `.js`, `.mjs`, `.cjs`                | `typescript`                      |
| `.rs`                                | `rust`                            |
| `.gd`                                | `gdscript`                        |
| `.sql`                               | `sql`                             |
| `.css`, `.scss`, `tailwind.config.*` | `frontend`                        |

Fallback signal — repository manifests. Use when extensions are absent or ambiguous; this
is the **primary** path for `/review-plan`, whose input is prose, not a diff:

| Manifest                             | Keyword(s)                                                  |
| ------------------------------------ | ----------------------------------------------------------- |
| `go.mod`                             | `go`                                                        |
| `pyproject.toml`, `requirements.txt` | `python`                                                    |
| `package.json` + `tsconfig.json`     | `typescript` (+ `react` if a `react` dependency is present) |
| `Cargo.toml`                         | `rust`                                                      |

For `/review-plan`, also add any language or framework the plan names explicitly
(e.g. "Django", "Tailwind", "axum").

If no keyword is found → **skip skill routing**; dispatch every reviewer with
`Stack skills: none`.

## Step 2 — Resolve candidate slugs

Invoke `Skill(skill-discovery)` once. For each detected keyword (and the framework names you
found), read that keyword's row to collect the current candidate slugs. Never invent a slug —
only use ones that appear in the skill-discovery output.

## Step 3 — Select per reviewer (cap ≤2 slugs each)

From the candidates, pick a tailored subset for each reviewer by slug family:

| Reviewer              | Picks                                                                                                                                                                                                                                                                        |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `reviewer-senior-dev` | language idioms: `<lang>-essentials` (+ `go-concurrency` for Go). Frontend/React: `react` + the UI-framework skill present in the change (`frontend-tailwind`, `frontend-shadcn-ui`, `frontend-ant-design`, …).                                                              |
| `reviewer-senior-qa`  | the stack's testing skill if a candidate exists (`python-testing`, `rust-testing`, `ts-vitest`); otherwise `testing-strategy`.                                                                                                                                               |
| `reviewer-security`   | `security`. (Its inline Go/Python/React vuln guidance already covers stack specifics; `security` adds OWASP/SAST depth.)                                                                                                                                                     |
| `reviewer-end-user`   | **only** when a UI or public API surface changed. Frontend/React → `ux-essentials` + `ux-wcag-a11y`. HTTP API (candidates include `rest-essentials`, `python-fastapi`, `python-django`, `go-chi`, `graphql-essentials`) → `rest-essentials`. Pure internal backend → `none`. |
| `reviewer-compliance` | `security` when auth, logging, or data handling changed; otherwise `none`.                                                                                                                                                                                                   |

Rules:

- **Cap ≤2 slugs per reviewer.** If more qualify, keep the most general (essentials /
  strategy) over the most specific.
- **Multi-language change** → union the per-reviewer picks across languages, then re-apply
  the ≤2 cap.
- A reviewer with no qualifying skill gets `none`.

## Step 4 — Pass to reviewers

In each reviewer's dispatch prompt, add one line (alongside the diff / plan / requirements):

```
Stack skills: <slug>, <slug>
```

or `Stack skills: none`. The reviewer loads each listed skill with the `Skill` tool before
reviewing.
