#!/usr/bin/env bash
# SessionStart hook — clears stale gate files so a crashed session cannot deadlock
# the next one.
#
# This exists ONLY to serve two hooks' session-scoped state files:
#   - review-plan-before-exit.sh arms `.plan-review-gate-<session-id>`. If a session
#     dies between arming the gate and re-presenting its plan, the file is left
#     behind; without this prune, the next session in that repo inherits it and is
#     blocked on a review it cannot satisfy.
#   - context-nudge.sh keeps `.context-nudge-<session-id>`, the highest context band
#     it has announced. It only needs to outlive its session, so it is pruned much
#     later than a gate (a long session must not re-fire after two idle hours).
#
# TRIMMED IN THE PORT from k0d3's 89-line version. Dropped:
#   - chmod +x over $CLAUDE_PROJECT_DIR/hooks
#   - frontmatter validation over $CLAUDE_PROJECT_DIR/agents
#     Both only ever did anything inside the k0d3 repo itself, whose layout put
#     those directories at the project root. They are no-ops in any other repo.
#   - audit-trail.md truncation, which served the log-changes hook that is not
#     being ported.
#   - pruning of .quality-gate-active, .tool-call-count and .compaction-occurred.
#     No surviving hook writes any of them.

[ -z "${CLAUDE_PROJECT_DIR:-}" ] && exit 0

LOG_DIR="$CLAUDE_PROJECT_DIR/.claude/logs"
mkdir -p "$LOG_DIR" 2> /dev/null || exit 0

# Prune by AGE, never by name. Gate files are session-scoped
# (.plan-review-gate-<id>), so a startup must never delete a CONCURRENT session's
# fresh gate — that would force it through a redundant review pass.
#
# Known quirk, carried over unchanged: a session idle for more than two hours
# between presenting a plan and re-presenting it loses its gate and is asked to
# review once more. Annoying, not harmful; the alternative (name-based pruning)
# breaks concurrent sessions, which is worse.
find "$LOG_DIR" -name ".plan-review-gate*" -mmin +120 -delete 2> /dev/null
find "$LOG_DIR" -name ".session-blocks-*" -mmin +120 -delete 2> /dev/null
find "$LOG_DIR" -name ".context-nudge-*" -mmin +1440 -delete 2> /dev/null

exit 0
