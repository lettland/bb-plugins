# Review finding disposition

Shared protocol for `/devkit:review-code`, `/devkit:review-impl`, `/devkit:review-plan`,
`/devkit:review`, and `/devkit:security-audit`. It defines what the orchestrator does **after**
a review has printed its categorized findings — regardless of which severity scheme the
calling command uses (Blockers / Concerns / Advisories, or Critical / High / Medium / Low /
Info).

This is the orchestrator's half of a contract the reviewer agents already state: _"the
orchestrator validates and dispositions every finding."_ Reviewers find and classify at true
severity; **dispositioning is your job, and it is not optional.**

## The protocol

Once the findings are printed, **do not stop and do not ask permission.** Disposition every
finding:

1. **Validate.** For each finding, open the cited `file:line` and read the **whole enclosing
   function or block** — not just the one line. Confirm the described problem is actually
   present in that context. Reviewers run without full repo context and produce false
   positives; **if you cannot reproduce the described problem from the code (or plan) itself,
   treat it as a false positive** and skip it (step 3). A finding is _valid_ only when you can
   see the problem in the real code.

   A finding is **also** a false positive when it proposes a _lateral rewrite_ — swapping
   working code, wording, or structure for an equally-valid alternative — or proposes
   _reversing a choice shown deliberate by an affirmative signal_ (a comment, docstring, test,
   or commit states the intent — not merely that it matches the surrounding code) without
   demonstrating a concrete defect. These are exactly the findings that make review oscillate:
   one session swaps A→B, the next swaps B→A, and nothing improves. Skip them (step 3). A
   finding earns a fix only when you can point to what is actually broken, risky, or failing —
   never to a preference. A genuine defect, though, is never a "deliberate choice": a hardcoded
   secret, a disabled security control, injection, or missing authz stays a finding even with
   an "intentional" comment.

   A **style/architecture/preference** finding is **also** a false positive when it
   **contradicts a documented project rule** surfaced in the reviewer's `Project context`
   (a `.devkit/review.yml` guideline, an auto-detected `CLAUDE.md`/`AGENTS.md` rule, or a matched
   path instruction) — the repo's stated convention outranks a reviewer's taste, per
   `references/review-project-context.md`. **But the trust model is strict:** a finding with a
   concrete exploit / correctness / data-loss / crash scenario is **never** suppressed by any
   rule (the "genuine defect" carve-out above governs); a rule file marked `changed-in-diff`
   carries **no** weight; and no rule or path instruction excuses skipping a file's defect scan.
   Conversely, a finding that the diff **violates** a documented rule is valid and stays at its
   tier — cite the rule when fixing. Record every rule-driven discount in the report
   (`discounted: … per rule …`); never drop one silently.

2. **Fix every valid finding — all tiers.** Apply the remediation directly: edit the source
   (for `/review-plan`, revise the plan document). Fix Blockers, Concerns, and Advisories
   alike — and the equivalent Critical/High/Medium/Low/Info tiers. **Severity sets order, not
   whether to fix:** do blockers first, advisories last; never skip a tier just because it is
   low.

   **Pre-existing is not a reason to skip.** A valid finding is fixed whether or not the code
   predates the change. _Pre-existing_ means the code as it stood at the review's base (`HEAD` for
   code scope, `<base>` for `impl <base>..<head>`); the caller may name a different base, such as
   a turn-start commit. The only allowed skip for being pre-existing is **named feature +
   unrelated**:
   - _Named feature_: the work is explicitly scoped to a feature the user named — a feature branch
     the user named (its name contains `/`, e.g. `fix/oh-5843/drop-dead-rotations-feed`) or a
     ticket/feature the request explicitly cites. Tool-generated branches (`bb/<slug>`,
     `dependabot/…`, `renovate/…`), root/mainline branches, and an ordinary "add X" request do
     not count. When in doubt, it is not a named feature: fix.
   - _Unrelated_: judged per function or hunk, not per file — the issue is not in code the feature
     changes, calls, or is called by, and does not affect the feature's behaviour. A nil-check bug
     in a helper the change calls is related; a typo in an untouched sibling function is not.

   Fixes land in the files under review; a related issue elsewhere is reported, not edited. Fix
   everything in the handed-over scope, whoever wrote it. Only edits outside the scope the caller
   handed over, or ones that appear after the review started, are off-limits: report them, do not
   fix them.

3. **Skip false positives.** If validation shows a finding is wrong or already handled, drop it —
   but say so in one line. Two more findings are skipped, never fixed: one _outside review scope_
   (outside the files under review or the scope the caller set, or another party's in-flight edit
   — report it, do not fix it) and one _unrelated_ to a named feature (step 2). Never silently
   discard a finding.

4. **Never ask for permission.** Do not write _"Want me to fix…?"_, _"Want me to add…?"_, or
   wait for approval. The user ran a review command to get the code fixed, not to receive a
   to-do list. Asking is the failure mode this protocol exists to prevent.

5. **Verify the fixes.** If you changed source, config, tests, or checked-in generated output,
   run the smallest meaningful project verification that exercises the touched area (test,
   lint, typecheck, build, or the repo's documented quality command). If the command reports
   errors or failures, **fix all errors in that output, not just the ones introduced by the
   review fixes**, then re-run the failing command. Continue until the relevant verification
   passes or you are genuinely blocked by missing credentials, access, or a user-only decision.
   If no runnable verification exists, say exactly what you inspected instead; do not call the
   work verified.

6. **Run a closure review.** After valid findings have been fixed, perform a follow-up review
   of the post-fix diff before reporting done. For calibrated commands (`/review-code`,
   `/review-impl`, `/review-plan`), this means one additional pass with the same review
   perspectives over the updated diff/plan, focused on whether the original findings are
   closed and whether the fixes introduced new Blockers or Concerns. For the single-pass
   `/review` and `security-audit` commands, do the same closure pass in-session against the
   updated diff. Disposition any new valid finding from that closure pass using this same
   protocol. Do not stop after merely proving that a review was run; the point is a clean,
   followed-up result.

7. **Report the disposition and closure evidence.** After fixing and follow-up, print a report:
   for each **fixed** finding, its tier and `(spec)`/`(code)` tag, `file:line`, and a one-line
   description of the change you made; for each **skipped** finding, its severity and the one-line
   reason — name the category (_false positive_, _lateral rewrite_, _deliberate choice_,
   _unrelated to named feature `<name>`_, or _outside review scope (reported)_) so the user can
   tell a deliberate skip from a missed defect. List skips highest severity first so a skipped
   Blocker is never buried, and label a skipped security finding as security. Report fixes to
   pre-existing code separately from fixes to the change's own code. A pre-existing secret you
   removed still needs rotation — it stays in git history — so report it by `file:line` and type
   as needing rotation. Close with the verification command(s) you ran
   and the follow-up review verdict. If verification or closure review could not be completed,
   state the exact blocker instead of implying the review is done.

**The `(spec)`/`(code)` tag is a routing hint, not a tier.** Reviewers tag each finding
`(spec)` (the work fails a requirement stated in the provided plan/spec) or `(code)` (a defect
independent of the spec — the default when no requirements were provided). Use it to aim the
fix: a `(spec)` finding means re-checking the change against the requirement and closing the
gap; a `(code)` finding means fixing the defect itself. Carry the tag through into the
disposition report. It never changes severity or the fix/skip decision — validate and fix
exactly as above.

**Never stage, commit, or push the fixes.** They land in the working tree only — leave them
there for the user to review.

## Guard clauses

**Local working tree only.** You can only fix what is in the local working tree. If the review
target is a remote PR or a ref that is not checked out locally, you cannot edit it — present
the validated findings with concrete, copy-pasteable remediations instead, and say why. (If
the user has checked the PR out locally, the fixes apply to that working tree like any other —
and, per above, you never push them.)

**Plan mode.** If Claude Code plan mode is active, _source_ edits are disallowed. Instead of
editing source, append the validated findings and their intended fixes to the active plan file
(path from system context) under a "Review findings" section, and say so. (`/review-plan` is
the exception: revising a plan document is prose editing, not a source edit, so `/review-plan`
always edits the reviewed plan document directly — even in plan mode.) Run the review and
disposition normally; only the _writes_ change target — never front-load a plan-mode question or
skip the review because edits are restricted.

## What this is NOT

- **Not a re-classification pass.** The consolidated severities stand — you validate whether a
  finding is _true_, not whether its tier is _right_.
- **Not a performative review.** Running reviewers is not completion. Completion means the
  first-pass findings were validated, valid ones were fixed, verification passed or was
  honestly blocked, and a closure review checked the post-fix diff.
- **Not a re-litigation of settled choices.** When the code already reflects a deliberate,
  equally-valid decision, a different-but-equivalent approach is not a defect — reversing it is
  how review becomes churn instead of value. Validate against what is broken, not against how
  you would have written it.
