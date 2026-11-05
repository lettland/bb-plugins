#!/usr/bin/env bash
# Stop / SubagentStop hook — verify-before-stop gate.
#
# Blocks a stop ONCE when this turn's tool OUTPUT shows an unresolved failure
# (auth/login, build/compile, test failure, command-not-found, non-zero exit) so
# the agent must re-verify the fix or honestly report blocked / needs-input
# instead of claiming success it never checked.
#
# Single-fire: gated on stop_hook_active so it fires at most once per stop
# episode — the model's NEXT stop is always allowed, so an honest "needs input"
# passes straight through and the gate never loops (no persistent ledger).
#
# Scope: scans tool_result blocks only (tool OUTPUT — where the wall lives), not
# the model's own assistant text (where the false "done" lives, and where a
# reviewer subagent legitimately discusses errors). Keeps false positives low.
#
# Fail-soft: any missing tool (jq/python3), absent transcript, or parse error
# allows the stop (exit 0, no output). The signature list below is the tunable
# surface — deliberately high-precision (no bare "error"/"failed"/"no such file").
#
# Output contract: on a match, prints the block schema to stdout and exits 0; no
# match → exit 0, no output. The block schema differs by host: Claude Code wants
# {"decision":"block","reason":"..."}; Codex's deny_unknown_fields Stop schema wants
# {"continue":false,"stopReason":"..."} and rejects the Claude fields. The Codex
# hook shim exports AGENT_HOOKS_HOST=codex (a Codex Stop carries hook_event_name="Stop"
# just like Claude, so only the marker distinguishes the hosts).

INPUT=$(cat)

# jq parses the event envelope; without it, allow the stop.
command -v jq > /dev/null 2>&1 || exit 0

# Single-fire guard. Claude Code sets stop_hook_active on BOTH Stop and
# SubagentStop once a stop hook has already blocked this episode, so this one
# check covers both wirings — no per-event ledger needed, and no block loop.
if [ "$(printf '%s' "$INPUT" | jq -r '.stop_hook_active // false')" = "true" ]; then
  exit 0
fi

TRANSCRIPT=$(printf '%s' "$INPUT" | jq -r '.transcript_path // empty')
[ -z "$TRANSCRIPT" ] && exit 0
[ -f "$TRANSCRIPT" ] || exit 0
command -v python3 > /dev/null 2>&1 || exit 0

# Scan THIS turn's tool_result output for a high-precision failure signature.
# Prints the matched signal label to stdout (empty if none / on any error).
SIGNAL=$(
  python3 - "$TRANSCRIPT" << 'PY' 2> /dev/null
import json, re, sys

try:
    entries = []
    with open(sys.argv[1], encoding="utf-8", errors="replace") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                entries.append(json.loads(line))
            except Exception:
                continue

    def message(e):
        if isinstance(e, dict):
            m = e.get("message")
            if isinstance(m, dict):
                return m
        return None

    def is_user_prompt(e):
        # A real user prompt is a user-role message carrying a text block (or a
        # plain string). Tool results are ALSO user-role messages, but their
        # content is tool_result blocks only — those are not turn boundaries.
        m = message(e)
        if not m or m.get("role") != "user":
            return False
        c = m.get("content")
        if isinstance(c, str):
            return bool(c.strip())
        if isinstance(c, list):
            return any(isinstance(b, dict) and b.get("type") == "text" for b in c)
        return False

    # "This turn" = everything after the last real user prompt. If none is found,
    # fall back to the tail so we still scan something bounded.
    start = 0
    for i in range(len(entries) - 1, -1, -1):
        if is_user_prompt(entries[i]):
            start = i + 1
            break
    turn = entries[start:] if start else entries[-50:]

    def tool_output(e):
        m = message(e)
        if not m:
            return ""
        c = m.get("content")
        out = []
        if isinstance(c, list):
            for b in c:
                if isinstance(b, dict) and b.get("type") == "tool_result":
                    rc = b.get("content")
                    if isinstance(rc, str):
                        out.append(rc)
                    elif isinstance(rc, list):
                        for cb in rc:
                            if isinstance(cb, dict) and cb.get("type") == "text":
                                out.append(cb.get("text", ""))
        return "\n".join(out)

    blob = "\n".join(tool_output(e) for e in turn)[-20000:]

    # High-precision signatures, anchored to runtime/CLI output shapes so they
    # don't fire on source code or prose a subagent merely READS (the SubagentStop
    # false-positive surface): panic:/Python errors must sit at a line start, and
    # permission-denied / cannot-find-module need their actual error context.
    # Order = priority; first match wins. Searched with re.I | re.M.
    patterns = [
        ("authentication/login failure",
         r"not logged in|please log\s?in|login required|authentication failed|"
         r"not authenticated|401 unauthorized"),
        ("command not found", r"command not found"),
        ("permission denied",
         r": permission denied|permission denied [(]|\bEACCES\b"),
        ("build/compile failure",
         r"build failed|compilation failed|cannot find module [\x27\x22\x60]|"
         r"^\s*(?:ModuleNotFoundError|ImportError|SyntaxError|IndentationError): \S|"
         r"^\s*panic:|segmentation fault"),
        ("test failure",
         r"--- FAIL:|\bFAIL\t|\b[1-9]\d* failed\b"),
        ("non-zero exit status",
         r"(?:exit code|exit status)\s+[1-9]\d*|process exited with code [1-9]\d*"),
    ]
    for label, pat in patterns:
        if re.search(pat, blob, re.I | re.M):
            print(label)
            break
except Exception:
    pass
PY
)

[ -z "$SIGNAL" ] && exit 0

REASON="A step in this turn reported a failure (${SIGNAL}) but the turn is ending. \
Before you stop: if it is fixable, fix it and RE-RUN the failing command to confirm it now \
succeeds — do not assume. If you cannot proceed without the user (login/auth/access you cannot \
perform, or a decision only they can make), stop and state exactly what you need — that is an \
honest, accepted outcome, not failure. Do NOT report success for work you have not verified. \
Restate the real status (verified-done / blocked / needs-input) and stop."

# Best-effort observability (fail-soft); mirrors guard-bash / completeness-gate format.
# Incident log: outside the project, so a wipe of the project cannot take it along.
# Same helper as guard-bash.sh; keep the copies in step.
INCIDENT_LOG_DIR="${AGENT_HOOKS_LOG_DIR:-${HOME:-}/.bb/logs/agent-hooks}"
INCIDENT_LOG="$INCIDENT_LOG_DIR/${CLAUDE_PROJECT_DIR//\//-}.md"

# Append one line to the incident log, then set the user append-only flag on the
# log dir and file (macOS/BSD; skipped silently where chflags is missing). Fail-soft.
incident_append() {
  mkdir -p "$INCIDENT_LOG_DIR" 2> /dev/null || return 0
  printf '%s\n' "$1" >> "$INCIDENT_LOG" 2> /dev/null || true
  command -v chflags > /dev/null 2>&1 || return 0
  local p
  for p in "$INCIDENT_LOG_DIR" "$INCIDENT_LOG"; do
    case "$(stat -f %Sf "$p" 2> /dev/null)" in
      *uappnd*) ;;
      *) chflags uappnd "$p" 2> /dev/null ;;
    esac
  done
  return 0
}

if [ -n "${CLAUDE_PROJECT_DIR:-}" ]; then
  incident_append "$(printf -- "- \`%s\` | VERIFY | BLOCK | %s" "$(date +"%Y-%m-%d %H:%M:%S")" "$SIGNAL")"
fi

if [ "${AGENT_HOOKS_HOST:-}" = "codex" ]; then
  jq -n --arg reason "$REASON" '{continue: false, stopReason: $reason}'
else
  jq -n --arg reason "$REASON" '{decision: "block", reason: $reason}'
fi
exit 0
