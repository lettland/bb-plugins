#!/usr/bin/env bash
# PreToolUse hook for Write|Edit|MultiEdit.
#
# Blocks writing an API key, token or private key into a file that could be
# COMMITTED. Extracted from k0d3's completeness-gate.sh, which bundled this with
# several checks on that plugin's own scaffolding (knowledge-base.md provenance,
# memory.md length caps, agents/*.md markers). Those files no longer exist; only
# the secret scan was worth keeping, so this is that scan standing alone.
#
# CHANGED IN THE EXTRACTION: the exemption is no longer the file's NAME. It is
# gitignore status. The old rule exempted anything matching `*.env*`, which is
# wrong in both directions -- a secret written to a tracked `config.yml` was
# caught only by pattern, and one written to a `.env` that nobody had gitignored
# was waved through on the name alone. The question is "can this reach the
# remote", and `git check-ignore` answers it directly.
#
# Only inspects `new_string` for Edit (by design -- a pre-existing secret in
# `old_string` is not an edit gate's responsibility).
#
# Fails OPEN on a missing tool and CLOSED on an unknown ignore status.

[ -z "${CLAUDE_PROJECT_DIR:-}" ] && exit 0
command -v jq > /dev/null 2>&1 || exit 0

INPUT=$(cat)
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty')
TOOL=$(echo "$INPUT" | jq -r '.tool_name // empty')
TIMESTAMP=$(date +"%Y-%m-%d %H:%M:%S")
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

[ -z "$FILE_PATH" ] && exit 0

if [ "$TOOL" = "Write" ]; then
  CONTENT=$(echo "$INPUT" | jq -r '.tool_input.content // empty')
elif [ "$TOOL" = "Edit" ] || [ "$TOOL" = "MultiEdit" ]; then
  CONTENT=$(echo "$INPUT" | jq -r '.tool_input.new_string // empty')
else
  exit 0
fi

[ -z "$CONTENT" ] && exit 0

# Write to a temp file rather than `echo "$CONTENT"`: on macOS, echo of content
# near ARG_MAX truncates, which would silently shorten the text being scanned.
CONTENT_FILE="$(mktemp)"
trap 'rm -f "$CONTENT_FILE"' EXIT
printf '%s' "$CONTENT" > "$CONTENT_FILE"

RELATIVE_PATH="${FILE_PATH#"$CLAUDE_PROJECT_DIR"/}"

log_incident() {
  local SEVERITY="$1"
  local MSG="$2"
  local SAFE_MSG
  SAFE_MSG="$(printf '%s' "$MSG" | tr '\n' ' ' | sed 's/`/'"'"'/g')"
  incident_append "- \`$TIMESTAMP\` | SECRET-SCAN | $SEVERITY | $SAFE_MSG"
}

block_high() {
  local FILE="$1"
  local MSG="$2"
  local SUGGESTION="${3:-Remove the credential, then retry the write.}"
  log_incident "HIGH" "BLOCKED: $MSG | File: $FILE"
  jq -n \
    --arg reason "$MSG" \
    --arg file "$FILE" \
    --arg suggestion "$SUGGESTION" \
    '{
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: ("SECRET SCAN: " + $reason + " | File: " + $file),
        additionalContext: ("Write blocked by the secret scan. Issue: " + $reason + ". Suggestion: " + $suggestion)
      }
    }'
  exit 0
}

# Destination test. Exit 0 means "git ignores this path", i.e. safe for secrets.
# Every failure mode -- no git, no repo, an error, a path outside the tree --
# returns non-zero, so the scan still runs. Fails CLOSED.
path_is_gitignored() {
  local p="$1"
  [ -n "$p" ] || return 1
  command -v git > /dev/null 2>&1 || return 1
  git -C "$CLAUDE_PROJECT_DIR" rev-parse --is-inside-work-tree > /dev/null 2>&1 || return 1
  git -C "$CLAUDE_PROJECT_DIR" check-ignore -q -- "$p" 2> /dev/null
}

if path_is_gitignored "$FILE_PATH"; then
  exit 0 # gitignored destination: secrets belong here
fi

# Covers Stripe, OpenAI (sk-proj), Anthropic (sk-ant-api03), classic GitHub
# (ghp_/ghs_), fine-grained GitHub PATs (github_pat_), GitLab (glpat-), JWTs
# (eyJhbGci…), AWS access keys (AKIA), Slack tokens (xox*), Slack webhooks, and
# GCP service-account JSON keys.
SECRET_PATTERN='(sk[-_](live|test|ant|proj)[_-][A-Za-z0-9]{20,}|sk-ant-api[0-9]{2}-[A-Za-z0-9_-]{40,}|ghp_[A-Za-z0-9]{36}|ghs_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{82}|glpat-[A-Za-z0-9_-]{20}|eyJhbGci[A-Za-z0-9+/=]{50,}|AKIA[0-9A-Z]{16}|xox[bpsar]-[A-Za-z0-9-]{20,}|hooks\.slack\.com/services/T[A-Z0-9]+/B[A-Z0-9]+/[A-Za-z0-9]+|"private_key":[[:space:]]*"-----BEGIN[[:space:]]+(RSA[[:space:]]+)?PRIVATE[[:space:]]+KEY-----)'

if grep -qE "$SECRET_PATTERN" "$CONTENT_FILE"; then
  block_high "$RELATIVE_PATH" \
    "Content contains what appears to be an API key, token, or secret, and this file is not gitignored." \
    "Move the value into a gitignored file (and confirm that file is in .gitignore), then reference it by variable name (e.g. STRIPE_SECRET_KEY) instead of pasting the value."
fi

exit 0
