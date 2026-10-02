#!/usr/bin/env bash
# PreToolUse(ExitPlanMode) hook — force a calibrated plan review before a plan is
# presented to the user.
#
# Single-fire per presentation (mirrors verify-before-stop): the FIRST ExitPlanMode
# of a plan is DENIED with an instruction to run bb devkit review plan and apply the
# four reviewers' findings; the gate file is ARMED on that deny, so the
# re-presentation after the review passes straight through (gate consumed). The
# gate self-re-arms for the next plan in the session — no persistent ledger.
#
# Why deny-then-allow and not content-hashing: the review EDITS the plan, so the
# re-presented plan has different text. A hash key would re-block in a loop. The
# single-fire gate is loop-safe by construction.
#
# Escape hatch: AGENT_HOOKS_SKIP_PLAN_REVIEW=1 → allow immediately (mirrors
# AGENT_HOOKS_SKIP_VALIDATOR). Per-plan skip: a plan containing the
# `<!-- agent-hooks:commit-plan -->` sentinel on a standalone line (emitted by
# bb devkit run commit) is allowed without arming the gate — a commit plan is not
# code. Fail-soft: missing jq, unset
# CLAUDE_PROJECT_DIR, a non-ExitPlanMode tool, or an un-writable gate dir → exit 0
# (never trap the user in plan mode).
#
# Ownership split with auto-review: in a bb `claude-code` thread with auto-review
# enabled, auto-review ALSO holds the first plan approval (its own gate, keyed off
# `interaction.pending` with `subject.kind: "plan"`), so without a handoff a plan
# in that thread gets reviewed twice. `bb auto-review status --json` reports
# `planGate: true` exactly for the thread auto-review's gate owns; when it does,
# this hook stands down for that plan instead of also arming. Every other thread
# (ACP, standalone Claude Code, auto-review off/skipped, a child thread) gets no
# such report (or none at all) and this hook reviews as it always has. Any
# failure reading that report — `bb` missing, a non-zero exit, output that is not
# JSON, no `planGate` field — falls through to today's deny+arm: worst case is a
# duplicate review, never a missed one.
#
# Output contract mirrors completeness-gate.sh: exit 0 + hookSpecificOutput JSON
# with permissionDecision "deny" on the block; exit 0 with no output to allow.

set -uo pipefail

# Per-need opt-out.
[ "${AGENT_HOOKS_SKIP_PLAN_REVIEW:-}" = "1" ] && exit 0

# jq parses the event envelope; without it, allow.
command -v jq > /dev/null 2>&1 || exit 0

# No project dir → nowhere to keep the single-fire gate → fail-soft allow.
[ -z "${CLAUDE_PROJECT_DIR:-}" ] && exit 0

INPUT=$(cat)
TOOL=$(printf '%s' "$INPUT" | jq -r '.tool_name // empty' 2> /dev/null || echo '')

# Defensive guard: the hooks.json matcher already scopes this to ExitPlanMode,
# but re-check so a loose matcher can never block an unrelated tool.
[ "$TOOL" = "ExitPlanMode" ] || exit 0

LOG_DIR="$CLAUDE_PROJECT_DIR/.claude/logs"
# Scope the gate to THIS session so two plan-mode sessions in the same repo never
# consume each other's gate. Fall back to a fixed name when the runtime gives no
# session_id. session-reset prunes stale gates by age, so a private name is safe.
SID=$(printf '%s' "$INPUT" | jq -r '.session_id // empty' 2> /dev/null || echo '')
GATE="$LOG_DIR/.plan-review-gate${SID:+-$SID}"
mkdir -p "$LOG_DIR" 2> /dev/null || exit 0

# Commit plans are not code — bb devkit run commit leads the plan it presents with a
# `<!-- agent-hooks:commit-plan -->` sentinel so this gate skips the 4-reviewer pass on it.
# Match the EXACT marker (close `-->` anchored) on ANY standalone line of the plan, not
# just line 1: /commit appends its Commit Plan to the active plan file, so the marker is
# rarely the literal first line of the presented string. The `^...[[:space:]]*$` anchor
# keeps it to a line of its own (CR absorbed by the trailing class), so an in-prose
# mention or a near-miss like `agent-hooks:commit-planner` still gets the normal review.
# Accepted false-skip: a real code plan carrying the exact sentinel on its own line (a
# meta-plan documenting this hook, even inside a fenced block) also skips — fine, the
# token is agent-hooks-internal and the gate is fail-open. Allow immediately and WITHOUT
# touching the single-fire gate, so a code plan later in the session is still reviewed.
#
# awk (one process) yields the 1-based line number of the FIRST standalone-line match,
# or empty if none — used only to enrich the skip log. Preferred over `grep -n | head |
# cut` because awk reads the final record even when the plan has no trailing newline
# (grep's behavior on an unterminated last line is POSIX-undefined), and it carries no
# pipefail/SIGPIPE or colon-split fragility.
PLAN=$(printf '%s' "$INPUT" | jq -r '.tool_input.plan // empty' 2> /dev/null || echo '')
MARKER_LINE=$(printf '%s' "$PLAN" |
  awk '/^[[:space:]]*<!--[[:space:]]*agent-hooks:commit-plan[[:space:]]*-->[[:space:]]*$/ { print NR; exit }')
if [ -n "$MARKER_LINE" ]; then
  printf -- "- \`%s\` | PLAN-REVIEW | SKIP | commit-plan marker on line %s (session %s), review bypassed\n" \
    "$(date +"%Y-%m-%d %H:%M:%S")" "$MARKER_LINE" "${SID:-none}" >> "$LOG_DIR/incident-log.md" 2> /dev/null || true
  exit 0
fi

# Re-presentation after review: consume the gate and let the plan through.
if [ -f "$GATE" ]; then
  rm -f "$GATE" 2> /dev/null
  exit 0
fi

# auto-review's own plan gate owns this thread: stand down instead of also
# arming. BB_THREAD_ID is unset outside a bb-run session (nothing to ask about,
# so nothing to stand down for); the bb binary (BB_CLI, else whatever `command -v
# bb` finds) is asked for THIS thread's planGate explicitly, since the hook has
# no other way to name the thread. Any failure here — no bb on PATH, a non-zero
# exit, output jq can't parse, a response with no planGate field — leaves
# $SERVED empty and falls through to the normal deny+arm below.
if [ -n "${BB_THREAD_ID:-}" ]; then
  BB_BIN="${BB_CLI:-}"
  [ -z "$BB_BIN" ] && BB_BIN=$(command -v bb 2> /dev/null || true)
  if [ -n "$BB_BIN" ] && STATUS_JSON=$("$BB_BIN" auto-review status "$BB_THREAD_ID" --json 2> /dev/null); then
    SERVED=$(printf '%s' "$STATUS_JSON" | jq -r 'if .planGate == true then "true" else empty end' 2> /dev/null || true)
    if [ "$SERVED" = "true" ]; then
      printf -- "- \`%s\` | PLAN-REVIEW | SKIP | auto-review gates this thread (%s)\n" \
        "$(date +"%Y-%m-%d %H:%M:%S")" "$BB_THREAD_ID" >> "$LOG_DIR/incident-log.md" 2> /dev/null || true
      exit 0
    fi
  fi
fi

# First presentation: arm the gate and route Claude through the reviewers.
# If we cannot arm (read-only FS, etc.), fail soft rather than trap the user.
: > "$GATE" 2> /dev/null || exit 0

# permissionDecisionReason is shown to the user (kept short); additionalContext is
# injected into the model's context (carries the full, actionable instruction).
SHORT="agent-hooks: plan not yet reviewed — run bb devkit review plan on the plan file, apply the findings, then present."
CONTEXT="agent-hooks: this plan has not been reviewed. Before presenting it: if the plan is not already saved \
to a file, save it (e.g. docs/plans/<name>.md); then run bb devkit review plan <path-to-that-plan-file> — \
pass the path explicitly. Let the 4 calibrated reviewers run, apply their findings to the plan, then \
call ExitPlanMode again to present the improved plan; the re-presentation passes this gate and goes to the \
user for approval. Edit only the plan file and do not implement anything until the user approves. If you \
are no longer in plan mode (for example an injected turn took you out of it), call EnterPlanMode first: \
outside plan mode ExitPlanMode approves itself without asking the user. \
Note: this is a 4-reviewer pass (tokens + latency). The gate can only be disabled by launching Claude \
with AGENT_HOOKS_SKIP_PLAN_REVIEW=1 in the environment — it cannot be toggled from inside a running session."

# Best-effort observability (fail-soft); mirrors completeness-gate / verify-before-stop.
printf -- "- \`%s\` | PLAN-REVIEW | DENY | armed gate, routed to /review:review-plan\n" \
  "$(date +"%Y-%m-%d %H:%M:%S")" >> "$LOG_DIR/incident-log.md" 2> /dev/null || true

jq -n --arg reason "$SHORT" --arg ctx "$CONTEXT" '{
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "deny",
    permissionDecisionReason: $reason,
    additionalContext: $ctx
  }
}'
exit 0
