#!/usr/bin/env bash
# PostToolUse hook, all tools. Nudges the agent to wrap up when its context grows.
#
# Every tool call re-sends the whole context, so the expensive calls are the ones
# made at 200k+ tokens. This reads the last real token reading from the session
# transcript and, each time usage crosses a new 200k band (200k, 400k, ... capped
# at 800k), adds one line of additionalContext asking the agent to end the turn
# with a short handoff instead of exploring further.
#
# State: $CLAUDE_PROJECT_DIR/.claude/logs/.context-nudge-<session-id> holds the
# highest band already announced (same convention as review-plan-before-exit.sh).
# session-reset.sh prunes it by age.
#   - A band fires once. Jumping several bands (150k -> 650k) fires once, for the
#     band reached.
#   - The stored band is lowered only on a real (non-zero, non-synthetic) reading
#     below it, e.g. after a compaction, so the next climb fires again.
#
# Known limits:
#   - Two parallel tool calls can both see the same new band and both fire. Accepted.
#   - A subagent's tool calls carry `agent_id` and are skipped: they would read the
#     parent's transcript and use up the parent's band. Claude Code documents
#     agent_id as identifying "the subagent or in-process teammate the hook fires
#     in"; it does not state that the field is absent on main-thread calls, so a
#     runtime that sends it there would silence this hook.
#
# Fail-soft: a missing jq, transcript or parse error exits 0 with no output.

set -uo pipefail

[ -z "${CLAUDE_PROJECT_DIR:-}" ] && exit 0
# Codex has no transcript in this shape, and the shim would only add a spawn.
[ "${AGENT_HOOKS_HOST:-}" = "codex" ] && exit 0
command -v jq > /dev/null 2>&1 || exit 0

INPUT=$(cat)
# \037 (not tab): a whitespace IFS would collapse an empty agent_id field.
FIELDS=$(printf '%s' "$INPUT" | jq -r '[(.agent_id // "" | tostring), (.session_id // "" | tostring), (.transcript_path // "" | tostring)] | join("\u001f")' 2> /dev/null) || exit 0
IFS=$'\037' read -r AGENT_ID SESSION_ID TRANSCRIPT <<< "$FIELDS"

# A subagent call: the parent's band is not this call's to spend.
[ -n "$AGENT_ID" ] && exit 0

SID=$(printf '%s' "$SESSION_ID" | tr -cd 'A-Za-z0-9_-')
[ -z "$SID" ] && exit 0
[ -n "$TRANSCRIPT" ] && [ -f "$TRANSCRIPT" ] || exit 0

# Last assistant entry whose model is real; a partial last line fails fromjson and
# is skipped. ctx is everything the call re-sent: fresh input plus both cache kinds.
CTX=$(tail -n 50 "$TRANSCRIPT" 2> /dev/null | jq -R -n -r '
  def n: (. // 0) | (tonumber? // 0) | floor;
  [inputs | fromjson? | select(type == "object" and .type == "assistant" and ((.message.model? // "") != "<synthetic>"))]
  | last // empty
  | .message.usage? // {}
  | (.input_tokens | n) + (.cache_read_input_tokens | n) + (.cache_creation_input_tokens | n)
' 2> /dev/null) || exit 0

# Untrusted numbers must never reach (( )) or [ -lt ]: digits only, sane length, and
# 10# so a leading zero is not read as octal.
digits() {
  case "$1" in '' | *[!0-9]*) echo 0 ;; *) [ "${#1}" -le 12 ] && echo $((10#$1)) || echo 0 ;; esac
}
CTX=$(digits "$CTX")
[ "$CTX" -gt 0 ] || exit 0 # no reading: leave the stored band alone

BAND=$((CTX / 200000 * 200000))
[ "$BAND" -gt 800000 ] && BAND=800000

LOG_DIR="$CLAUDE_PROJECT_DIR/.claude/logs"
STATE="$LOG_DIR/.context-nudge-$SID"
STORED=0
[ -f "$STATE" ] && STORED=$(digits "$(head -c 20 "$STATE" 2> /dev/null)")

[ "$BAND" -eq "$STORED" ] && exit 0
mkdir -p "$LOG_DIR" 2> /dev/null || exit 0
printf '%s\n' "$BAND" > "$STATE" 2> /dev/null || exit 0
# Lowered band (compaction): stored for the next climb, nothing to announce.
[ "$BAND" -lt "$STORED" ] && exit 0

jq -n --arg msg "Context is ~$((CTX / 1000))k tokens and every further call re-sends all of it. Finish the current step, then end the turn with a short handoff (done / next / key files) instead of continuing to explore. If you are a worker thread, report back to your parent now." '{
  hookSpecificOutput: {
    hookEventName: "PostToolUse",
    additionalContext: $msg
  }
}'
exit 0
