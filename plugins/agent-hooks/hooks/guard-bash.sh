#!/usr/bin/env bash
# PreToolUse hook for Bash commands.
# Uses structured JSON output for blocks (exit 0 + JSON stdout).
# Falls through with plain exit 0 for allowed commands.
#
# Three tiers:
#   HARD BLOCK  — always blocked, no override (permissionDecision: deny)
#   SOFT BLOCK  — blocked with explanation, user can re-request (permissionDecision: deny)
#   LOG WARNING — allowed but logged to incident log (exit 0, no JSON)
#
# Note: regex-on-shell-text is fundamentally fragile. This hook is a best-effort
# tripwire, not a sandbox. Catastrophic-rm and secret-exfil checks use token-scan
# (whitespace split) for better coverage than position-anchored regex.

# Guard against unset project dir (silently no-op rather than write to /)
[ -z "${CLAUDE_PROJECT_DIR:-}" ] && exit 0

INPUT=$(cat)
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty')
TIMESTAMP=$(date +"%Y-%m-%d %H:%M:%S")
LOG_DIR="$CLAUDE_PROJECT_DIR/.claude/logs"
INCIDENT_LOG="$LOG_DIR/incident-log.md"

mkdir -p "$LOG_DIR"

log_incident() {
  local SEVERITY="$1"
  local MSG="$2"
  # Fence user-controlled MSG to prevent markdown injection in the log file
  local SAFE_MSG
  SAFE_MSG="$(printf '%s' "$MSG" | tr '\n' ' ' | sed 's/`/'"'"'/g')"
  echo "- \`$TIMESTAMP\` | GUARD | $SEVERITY | $SAFE_MSG" >> "$INCIDENT_LOG"
}

deny() {
  local REASON="$1"
  local CONTEXT="$2"
  jq -n \
    --arg reason "$REASON" \
    --arg context "$CONTEXT" \
    '{
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: $reason,
        additionalContext: $context
      }
    }'
  exit 0
}

# ═══════════════════════════════════════════════════════
# Token normalization (F1)
# ═══════════════════════════════════════════════════════
#
# Shell word-splitting leaves shell syntax welded to tokens: `$(rm` from a command
# substitution, `/etc)` from its closing paren, `\rm` from an alias bypass. Stripping
# that is what lets a basename test see the real command, and it also closes a
# pre-existing gap where `rm -rf /etc)` slipped past the `/etc` path glob.
normalize_token() {
  local t="$1"
  t="${t#\$(}"        # $(rm      -> rm
  t="${t#[\(\{\`]}"   # (rm `rm {rm -> rm
  t="${t#[\"\'\`]}"   # one layer of surrounding quotes
  t="${t%[\"\'\`]}"
  t="${t#\\}"         # \rm       -> rm
  t="${t%[\)\};\`]}"  # /etc) rm; -> /etc rm
  printf '%s' "$t"
}

# Is any token in this clause an `rm` command?
#
# Deliberately NOT a command-word resolver. Resolving "the command" regresses
# `sudo -u root rm` (the -u value is eaten), `/bin/rm`, `command rm`, `busybox rm`
# and `find -exec rm` — all of which the old substring scan caught. Asking "is any
# token an rm?" is strictly NARROWER than the old `\brm\b` substring match and so
# cannot widen the gate; the only thing it newly exempts is a flag like docker's
# `--rm`, which is the entire false positive this fixes.
clause_has_rm() {
  local clause="$1" raw tok
  for raw in $clause; do
    case "$raw" in -*) continue ;; esac # a flag is never the command
    tok="$(normalize_token "${raw#*=}")" # drop a NAME= assignment prefix first
    case "${tok##*/}" in rm) return 0 ;; esac
  done
  return 1
}

# Is this rm target home itself, a direct child of a home directory, or
# something a glob could widen into one?
#
# Depth decides, not the prefix: deleting ~/.zshrc, ~/workspace or ~/* is
# catastrophic, but a file deep inside a project that happens to live under
# /Users (/Users/me/ws/proj/tmp.log) is ordinary work. Deeper paths return 1
# and fall through to the recursive-rm soft block, which still gates `rm -r`.
# Any `.`/`..` segment counts as catastrophic, since ~/a/../.. is home.
#
# Depth is read from the literal token, so a glob (* ? [ {) in the user segment
# or in either of the first two segments under home counts as catastrophic:
# ~/*/* or ~/workspace/* empties whole top-level trees without needing -r.
# Credential stores (~/.ssh, ~/.gnupg, ~/.aws) are blocked at any depth.
home_rm_is_catastrophic() {
  local rest seg1 seg2
  # shellcheck disable=SC2016,SC2088  # literal ~ / $HOME / ${HOME} text, as in the scan below
  case "$1" in
    '~/'*) rest="${1#\~}" ;;
    '~'*) return 0 ;; # ~ and ~otheruser
    '$HOME' | '$HOME/'*) rest="${1#\$HOME}" ;;
    '${HOME}' | '${HOME}/'*) rest="${1#\$\{HOME\}}" ;;
    /Users | /home) return 0 ;;
    /Users/* | /home/*)
      rest="${1#/*/}" # user[/sub...]
      case "${rest%%/*}" in *[\*\?\[\{]*) return 0 ;; esac # /Users/*/...
      case "$rest" in */*) rest="/${rest#*/}" ;; *) return 0 ;; esac
      ;;
    *) return 1 ;;
  esac
  case "$rest/" in */./* | */../*) return 0 ;; esac
  while [ "${rest#/}" != "$rest" ]; do rest="${rest#/}"; done
  while [ "${rest%/}" != "$rest" ]; do rest="${rest%/}"; done
  seg1="${rest%%/*}"
  case "$rest" in */*) seg2="${rest#*/}" && seg2="${seg2%%/*}" ;; *) return 0 ;; esac
  case "$seg1" in .ssh | .gnupg | .aws) return 0 ;; esac
  case "$seg1/$seg2" in *[\*\?\[\{]*) return 0 ;; esac
  return 1
}

# ═══════════════════════════════════════════════════════
# HARD BLOCK — never allowed, no exceptions
# ═══════════════════════════════════════════════════════

# Catastrophic rm: clause-aware token-scan for system and home paths. Split on &&/||/;/|
# and scan ONLY the tokens of clauses that actually invoke `rm`, so a system path
# in a SIBLING clause (`cd /Users/me/proj && rm localfile`) is never mistaken for
# an rm target. Within an rm clause this still catches: rm -r /, rm /etc,
# rm / -rf (flag-after-path), reorderings, and quoted paths like `rm -rf "/etc"`.
#
# KNOWN GAPS, documented so a later false-positive pass does not "discover" them
# as bugs and widen the rule further. None is a regression; all predate this:
#   - `find /etc -delete` (no rm token at all)
#   - `xargs` taking its command from stdin rather than argv
#   - mid-token quoting (`r'm' -rf /etc`) — evades the old \brm\b equally
#   - dynamic paths (`rm -rf $(mktemp -d)/../etc`) — the recursive-rm soft block
#     below still fires, so this is not an open hole
#
# KNOWN FALSE POSITIVE, kept on purpose: prose is scanned like argv. A heredoc
# body or a `git commit -m "..."` message that contains the word rm next to a
# home path is hard-blocked. Heredocs can feed a shell (`bash <<EOF`), so their
# bodies are not skipped; write such text to a file (`git commit -F <file>`).
if echo "$COMMAND" | grep -qE '\brm\b'; then
  RM_CLAUSES="$(echo "$COMMAND" | tr ';|&' '\n' | tr -s '\n')"
  while IFS= read -r rm_clause; do
    [ -z "$rm_clause" ] && continue
    clause_has_rm "$rm_clause" || continue
    for raw_token in $rm_clause; do
      token="$(normalize_token "$raw_token")"
      if home_rm_is_catastrophic "$token"; then
        log_incident "CRITICAL" "BLOCKED: rm targeting home path '$token' in: $COMMAND"
        deny "HARD BLOCK: rm targets a home directory or its direct child ($token). Catastrophic." "Use a project-relative path under \$CLAUDE_PROJECT_DIR. Never delete home directories or top-level home entries."
      fi
      # shellcheck disable=SC2016  # '$HOME'/'${HOME}' are literal patterns — the scan matches the unexpanded text of a command like `rm -rf $HOME`
      case "$token" in
        / | \
          /etc | /etc/* | /usr | /usr/* | /var | /var/* | /bin | /bin/* | /sbin | /sbin/* | \
          /lib | /lib/* | /lib64 | /lib64/* | /boot | /boot/* | /sys | /sys/* | /proc | /proc/* | \
          /dev | /dev/* | /opt | /opt/* | /root | /root/* | \
          /System | /System/* | /Library | /Library/* | \
          /Applications | /Applications/* | /Volumes | /Volumes/* | /private | /private/*)
          log_incident "CRITICAL" "BLOCKED: rm targeting system path '$token' in: $COMMAND"
          deny "HARD BLOCK: rm targets system path ($token). Catastrophic." "Use a project-relative path under \$CLAUDE_PROJECT_DIR. Never delete system directories."
          ;;
      esac
    done
  done <<< "$RM_CLAUSES"
fi

# Shell indirection bypass (B2): eval, sh -c, bash -c — these wrap commands in
# a way that defeats every other regex below. Soft-block so legitimate uses
# (build scripts, oneliners) can be re-requested.
# `fish` is in the list because it is this user's login shell: `fish -c "set"`
# otherwise evades both this rule and the environment-dump block (F8), since the
# dump token is a quoted argument rather than a clause of its own.
if echo "$COMMAND" | grep -qE '\b(eval|bash[[:space:]]+-c|sh[[:space:]]+-c|zsh[[:space:]]+-c|ksh[[:space:]]+-c|dash[[:space:]]+-c|fish[[:space:]]+-c|fish[[:space:]]+--command)\b'; then
  log_incident "HIGH" "SOFT BLOCKED: shell indirection: $COMMAND"
  deny "SOFT BLOCK: shell indirection (eval, sh -c, bash -c, fish -c, etc.) bypasses safety checks." "Run the underlying command directly so guard-bash.sh can inspect it. If indirection is genuinely required, ask the user to confirm."
fi

# Force push (F9). The agent must NEVER force push, so this closes two forms the
# old `git push .*--force` regex let through:
#   1. `git -c k=v push --force` / `git --git-dir=… push -f` — any global option
#      between `git` and `push` broke the adjacency the old pattern required.
#   2. `git push origin +main:main` — a leading `+` on a refspec IS a force push
#      and never contains the string "force" at all.
# --force-with-lease and --force-if-includes stay blocked: they are force pushes,
# and the standing instruction is "never".
# The alternation allows both a global FLAG (`--git-dir=…`, `-c`) and a flag's
# separate VALUE token (`core.pager=cat` after `-c`), which is what lets
# `git -c k=v push --force` match. Anything else between git and push stops it,
# so `git commit -m "push --force"` is not swept up.
GIT_PUSH='git([[:space:]]+(-[^[:space:]]+|[^-[:space:]][^[:space:]]*=[^[:space:]]*))*[[:space:]]+push\b'
if echo "$COMMAND" | grep -qE "${GIT_PUSH}.*(--force|-f([[:space:]]|$))" \
  || echo "$COMMAND" | grep -qE "${GIT_PUSH}[^|;&]*[[:space:]]\+[^[:space:]]*:"; then
  log_incident "CRITICAL" "BLOCKED: force push: $COMMAND"
  deny "HARD BLOCK: Force push rewrites shared history." "The agent must never force push. This includes --force, -f, --force-with-lease, --force-if-includes, and a +refspec. If a force push is genuinely required, the user runs it themselves."
fi

# git reset --hard (destroys uncommitted work)
if echo "$COMMAND" | grep -qE 'git[[:space:]]+reset[[:space:]]+--hard'; then
  log_incident "HIGH" "BLOCKED: git reset --hard: $COMMAND"
  deny "HARD BLOCK: git reset --hard destroys uncommitted changes." "Command blocked: git reset --hard. Suggest using git stash or git commit first."
fi

# git clean -f (deletes untracked files permanently)
if echo "$COMMAND" | grep -qE 'git[[:space:]]+clean[[:space:]]+(-[a-zA-Z]*f|-f)'; then
  log_incident "HIGH" "BLOCKED: git clean -f: $COMMAND"
  deny "HARD BLOCK: git clean -f permanently deletes untracked files." "Command blocked: git clean -f. Suggest using git stash instead."
fi

# chmod 777 (security risk)
if echo "$COMMAND" | grep -qE 'chmod[[:space:]]+777'; then
  log_incident "HIGH" "BLOCKED: chmod 777: $COMMAND"
  deny "HARD BLOCK: chmod 777 grants full access to all users." "Command blocked: chmod 777. Use more restrictive permissions like 755 or 644."
fi

# ═══════════════════════════════════════════════════════
# SECRET EXPOSURE — block commands that leak credentials
# ═══════════════════════════════════════════════════════

# Token-scan: any tool that prints/streams .env* file contents (Pass 1 B3,
# Pass 2 quote-bypass fix). Local file-movers (cp/mv/ln) are NOT in the list —
# they relocate bytes without exposing a value to stdout/log; rsync/scp stay
# because they move over the network. Secret-free templates (.env.example and
# friends) are exempt. Allow `grep -c KEY .env` / `grep --count` existence
# checks (no value leak). Same quote-stripping as the rm token-scan above.
if echo "$COMMAND" | grep -qE '\b(cat|head|tail|less|more|bat|grep|awk|sed|xxd|od|strings|sort|uniq|wc|tee|rsync|scp)\b'; then
  for raw_token in $COMMAND; do
    token="${raw_token#[\"\'\`]}"
    token="${token%[\"\'\`]}"
    case "$token" in
      *.env.example | *.env.sample | *.env.template | *.env.dist)
        continue
        ;; # secret-free templates — safe to read/inspect
      *.env | *.env.*)
        # `.env.NAME` with an ALL-CAPS identifier is a property path, not a file:
        # `jq '.env.ANTHROPIC_BASE_URL' settings.json`, `process.env.HOME`. Dotenv
        # files are named in lowercase (.env.local, .env.production), so those
        # still fall through. A file literally named `.env.PROD` is the accepted gap.
        # Strip every such path and re-test, so `.env.local;.env.X` still blocks.
        case "$(printf '%s' "$token" | sed -E 's/\.env\.[A-Z_][A-Z0-9_]*([^A-Za-z0-9_.-]|$)/\1/g')" in
          *.env | *.env.*) ;;
          *) continue ;;
        esac
        # Non-leaking shape checks are allowed: `grep -c KEY .env` (pre-existing)
        # and `wc -l .env` (F4). Deliberately NOT `grep -q`, which is a bisection
        # oracle — guess a prefix, read the exit code, extract the secret one
        # character at a time. Deliberately NOT `wc -c`, which leaks byte length.
        # The pre-existing `grep -c` allowance is the same oracle; it is inherited
        # rather than introduced here, so it stays, but the set is not extended.
        if echo "$COMMAND" | grep -qE '\bgrep[[:space:]]+(-[a-zA-Z]*c[a-zA-Z]*|--count)([[:space:]]|=)' \
          || echo "$COMMAND" | grep -qE '\bwc[[:space:]]+(-[lw]+|--lines|--words)([[:space:]]|$)'; then
          continue
        fi
        log_incident "HIGH" "BLOCKED: .env read via shell: $COMMAND"
        deny "HARD BLOCK: Reading .env* files via shell exposes credentials." "Use the variable name in your code; never read the file via shell. Use 'grep -c KEY .env' or 'grep --count KEY .env' for existence checks."
        ;;
    esac
  done
fi

# printenv with an explicit variable name prints its value (A7). Allow a
# safelist of well-known non-secret vars (PATH, HOME, …); block the rest, since
# any other var could hold a credential. (sed uses no \b — BSD/macOS sed lacks it.)
if echo "$COMMAND" | grep -qE '\bprintenv[[:space:]]+[A-Za-z_]'; then
  PRINTENV_VAR="$(echo "$COMMAND" | sed -nE 's/.*printenv[[:space:]]+([A-Za-z_][A-Za-z0-9_]*).*/\1/p')"
  case "$PRINTENV_VAR" in
    PATH | HOME | USER | LOGNAME | PWD | OLDPWD | SHELL | SHLVL | LANG | LANGUAGE | \
      TERM | TERM_PROGRAM | COLORTERM | HOSTNAME | TMPDIR | TZ | EDITOR | VISUAL | \
      PAGER | DISPLAY | COLUMNS | LINES | GOPATH | GOROOT | GOBIN | VIRTUAL_ENV | \
      CONDA_DEFAULT_ENV | LC_* | \
      NODE_ENV | ENV | CI | RUST_LOG | RUSTUP_HOME | CARGO_HOME | PYTHONPATH | \
      PYTHONUNBUFFERED | JAVA_HOME | ANDROID_HOME | DOCKER_HOST | KUBECONFIG | \
      XDG_* | SSH_AUTH_SOCK | HOMEBREW_PREFIX | NVM_DIR | FNM_DIR | PNPM_HOME)
      :
      ;; # benign environment var — reading it exposes nothing sensitive
      # F6 NOTE: this stays an ALLOWLIST (fail-closed) on purpose. Inverting it to
      # a secret-name denylist fails OPEN by construction: the denylist below is
      # finite literals and misses the vendor-prefix + generic-suffix shape
      # (TWILIO_AUTH_TOKEN, SENDGRID_API_KEY, SENTRY_AUTH_TOKEN, AWS_ACCESS_KEY_ID),
      # so any of those would print in full. Widen this list; never invert it.
      # Deliberately NOT `npm_config_*` — npm materializes a private-registry
      # _authToken into that namespace.
    *)
      log_incident "HIGH" "BLOCKED: printenv with arg: $COMMAND"
      deny "HARD BLOCK: printenv <var> prints the credential value to output." "Reference secrets by variable name only. Never print their values. Benign vars (PATH, HOME, …) are allowed."
      ;;
  esac
fi

# Environment dump (F8). A bare `env` / `printenv` / `set` / `export -p` prints
# EVERY variable to stdout, straight into the agent's context. Nothing above
# catches it: the printenv rule needs a variable NAME to follow, and destination
# rules only look at redirection. Worse, once leaked this way the secret is a
# LITERAL, so it also evades the $VAR secret-name regex on every later use.
#
# The check is on the COMMAND, not the destination — that is what makes it robust
# against `> file`, `>> file` and `| tee file` alike, instead of chasing syntax.
#
# "No arguments" is the wrong predicate (it misses `env -0`, `export`, `declare -p`)
# and so is "every remaining token is a flag" (it would block `set -e`). Each
# command needs its own dumping form enumerated.
DUMP_CLAUSES="$(echo "$COMMAND" | tr ';|&' '\n' | tr -s '\n')"
while IFS= read -r dump_clause; do
  [ -z "$dump_clause" ] && continue
  # Strip redirections so `env > /tmp/x` reduces to `env`.
  bare="$(echo "$dump_clause" | sed -E 's/[<>]+[[:space:]]*[^[:space:]]+//g' | tr -s '[:space:]' ' ' | sed -E 's/^ +| +$//g')"
  # Patterns are quoted because a bash `case` pattern is a single WORD: an
  # unquoted `env -0` parses as two and is a syntax error.
  case "$bare" in
    env | 'env -0' | 'env --null' | \
      printenv | 'printenv -0' | 'printenv --null' | \
      set | 'set -S' | 'set --show' | \
      export | 'export -p' | \
      'declare -p' | 'typeset -p')
      log_incident "CRITICAL" "BLOCKED: environment dump: $COMMAND"
      deny "HARD BLOCK: '$bare' prints every environment variable, exposing every credential at once." "Name the variable you actually need (e.g. 'printenv NODE_ENV' for a benign one). A full dump puts secrets into the transcript as literal text, where no later check can catch them."
      ;;
    'compgen -v')
      log_incident "MEDIUM" "SOFT BLOCKED: environment name listing: $COMMAND"
      deny "SOFT BLOCK: 'compgen -v' lists every variable name." "Names only, no values, so this is recoverable — but confirm you need the full list rather than a specific variable."
      ;;
  esac
done <<< "$DUMP_CLAUSES"

# Block echo/printf of environment variables whose name marks them as a secret
# (covers ${VAR} brace form via [{]? optional brace, and $VAR bare form). The
# names are specific, not broad prefixes: a bare `AWS_`/`DATABASE_`/`TOKEN`
# prefix wrongly caught `$AWS_REGION`, `$DATABASE_NAME`, `$TOKEN_COUNT`, so the
# list now requires the actual secret-bearing var names.
if echo "$COMMAND" | grep -qE '(echo|printf)[[:space:]]+.*\$[{]?(STRIPE_|OPENAI_|ANTHROPIC_|AWS_SECRET_ACCESS_KEY|AWS_SESSION_TOKEN|DATABASE_URL|DATABASE_PASSWORD|DB_PASSWORD|AUTH_SECRET|NEXTAUTH_SECRET|SESSION_SECRET|JWT_SECRET|CLIENT_SECRET|API_KEY|SECRET_KEY|SECRET_ACCESS_KEY|PRIVATE_KEY|ENCRYPTION_KEY|SIGNING_KEY|PASSWORD|PASSWD|GITHUB_TOKEN|GH_TOKEN|GITLAB_TOKEN|SLACK_TOKEN|NPM_TOKEN|AUTH_TOKEN|ACCESS_TOKEN|REFRESH_TOKEN|API_TOKEN)'; then
  log_incident "HIGH" "BLOCKED: secret echo: $COMMAND"
  deny "HARD BLOCK: Echoing secret environment variables exposes credentials." "Reference secrets by variable name only. Never echo their values."
fi

# Block piping credential files to network commands
if echo "$COMMAND" | grep -qE '\.env.*\|[[:space:]]*(curl|wget|nc|ncat|http|httpie)'; then
  log_incident "CRITICAL" "BLOCKED: credential file piped to network: $COMMAND"
  deny "HARD BLOCK: Piping credential files to network commands would exfiltrate secrets." "Never pipe .env files to network commands."
fi

# Block git add of credential files. Token-scan (not a single regex) so
# secret-free templates (.env.example and friends) can still be staged.
if echo "$COMMAND" | grep -qE '\bgit[[:space:]]+add\b'; then
  for raw_token in $COMMAND; do
    token="${raw_token#[\"\'\`]}"
    token="${token%[\"\'\`]}"
    case "$token" in
      *.env.example | *.env.sample | *.env.template | *.env.dist)
        continue
        ;; # templates carry no secrets — fine to commit
      *.env | *.env.*)
        log_incident "CRITICAL" "BLOCKED: git add of credential file: $COMMAND"
        deny "HARD BLOCK: Staging credential files (.env) for git commit would expose secrets publicly." "These files must stay in .gitignore. Never commit credentials to git. Templates like .env.example are allowed."
        ;;
    esac
  done
fi

# ═══════════════════════════════════════════════════════
# SOFT BLOCK — blocked, but user can re-request
# ═══════════════════════════════════════════════════════

# Git hook bypass. The agent must fix what a hook reports, not skip the hook:
# `--no-verify` (and its unambiguous prefixes), `commit -n`, a one-shot
# `-c core.hooksPath=…` / `--config-env` / GIT_CONFIG_* override, and a persistent
# `git config core.hooksPath <dir>`.
#
# Parsing rules adapted from ecc block-no-verify.js, Copyright (c) 2026 Affaan
# Mustafa, MIT.
#
# The `for raw in $clause` split used by the rm checks is quote-blind, so it would
# block `git commit -m "drop -n flag"`. This check tokenizes with python's shlex
# instead. The program below is FIXED text run as `python3 -I -c`; the command goes
# in on stdin and is never evaluated, sourced or put in argv. -I (isolated mode)
# keeps a planted shlex.py/re.py in the project dir, and PYTHON* env vars, out.
#
# Bash acts only on an explicit `ALLOW` or `BLOCK:<kind>` line. Anything else (no
# python3, the macOS stub exiting non-zero, unbalanced quotes, an exception, empty
# output) falls to a whitespace scan for the same patterns, which errs toward
# blocking.
#
# KNOWN GAPS (not regressions; do not "discover" them as bugs):
#   - HUSKY=0
#   - git aliases (`git ci -n`)
#   - heredoc bodies fed to a shell (bodies are not scanned, same as ecc), and a
#     `<<WORD` inside quoted text that has a later terminator line, which hides the
#     lines between
#   - hooks disabled through a config file the agent writes directly, and
#     GIT_CONFIG_GLOBAL pointing at such a file
IFS= read -r -d '' GIT_BYPASS_PY << 'PY'
import os
import re
import shlex
import sys

HOOK_CMDS = {"commit", "push", "merge", "cherry-pick", "rebase", "am"}
PUNCT = ";&|\n"
# Prefix words that may sit between a clause start and its assignments.
PREFIX_WORDS = {"env", "export", "declare", "typeset", "command", "exec", "sudo", "time", "nice", "nohup"}
ASSIGN = re.compile(r"^([A-Za-z_][A-Za-z0-9_]*)=(.*)$", re.S)
# `git commit` options whose value is the next token (or the rest of a short cluster).
COMMIT_LONG_VALUE = {
    "--message", "--file", "--reuse-message", "--reedit-message", "--template", "--author",
    "--date", "--cleanup", "--fixup", "--squash", "--pathspec-from-file", "--trailer",
}
CONFIG_READ_FLAGS = {
    "--get", "--get-all", "--get-regexp", "--get-urlmatch", "--unset", "--unset-all",
    "--list", "-l", "--remove-section", "--rename-section", "--edit", "-e",
}
CONFIG_VALUE_FLAGS = {"-f", "--file", "--blob", "--type", "--default", "--comment"}
GLOBAL_VALUE = {"-C", "--git-dir", "--work-tree", "--namespace", "--super-prefix"}


def strip_heredocs(text):
    """Drop heredoc bodies, keeping the marker's own line. No terminator: unchanged."""
    marker = re.compile(r"(?<!<)<<(?!<)(-?)[ \t]*(['\"]?)(\w+)\2")
    lines = text.split("\n")
    out = []
    i = 0
    while i < len(lines):
        line = lines[i]
        out.append(line)
        i += 1
        for m in marker.finditer(line):
            dash, delim = m.group(1), m.group(3)
            for k in range(i, len(lines)):
                cand = lines[k].lstrip("\t") if dash else lines[k]
                if cand == delim:
                    i = k + 1
                    break
    return "\n".join(out)


def join_continuations(text):
    """Remove backslash-newline pairs, as bash does (an escaped backslash does not count)."""
    return re.sub(r"(?<!\\)((?:\\\\)*)\\\n", r"\1", text)


def strip_comments(text):
    """Delete `# …` to end of line when # starts a word outside quotes."""
    out = []
    quote = None
    word_start = True
    i = 0
    n = len(text)
    while i < n:
        c = text[i]
        if quote == "'":
            out.append(c)
            if c == "'":
                quote = None
        elif quote == '"':
            out.append(c)
            if c == "\\" and i + 1 < n:
                i += 1
                out.append(text[i])
            elif c == '"':
                quote = None
        elif c == "\\" and i + 1 < n:
            i += 1
            out.append(c)
            out.append(text[i])
        elif c in "'\"":
            quote = c
            out.append(c)
        elif c == "#" and word_start:
            while i < n and text[i] != "\n":
                i += 1
            continue
        else:
            out.append(c)
        word_start = quote is None and c in " \t\n;&|()<>"
        i += 1
    return "".join(out)


def clauses(text):
    """Split into token lists on unquoted ; & | and newline. Raises ValueError on bad quoting."""
    lex = shlex.shlex(text, posix=True, punctuation_chars=PUNCT)
    lex.whitespace_split = True
    lex.whitespace = " \t\r"
    lex.commenters = ""
    toks = list(lex)
    res = []
    cur = []
    i = 0
    while i < len(toks):
        t = toks[i]
        nxt = toks[i + 1] if i + 1 < len(toks) else ""
        if t == "&":
            # `2>&1` and `&>file` are redirections, not a clause break.
            if cur and cur[-1].endswith((">", "<")):
                cur[-1] += "&"
                i += 1
                if re.fullmatch(r"\d+|-", nxt):
                    cur[-1] += nxt
                    i += 1
                continue
            if nxt.startswith(">"):
                cur.append("&" + nxt)
                i += 2
                continue
        if t and not t.strip(PUNCT):
            if cur:
                res.append(cur)
                cur = []
        else:
            cur.append(t)
        i += 1
    if cur:
        res.append(cur)
    return res


def norm(t):
    """Strip the shell syntax welded onto a token: $(git, (git, `git, \\git, x)."""
    if t.startswith("$("):
        t = t[2:]
    t = t.lstrip("({`")
    if t.startswith("\\"):
        t = t[1:]
    return t.rstrip(")};`")


def hooks_path_key(v):
    return v.split("=", 1)[0].strip().lower() == "core.hookspath"


def check_assignments(toks):
    for raw in toks:
        t = norm(raw)
        m = ASSIGN.match(t)
        if m:
            name, val = m.group(1), m.group(2)
            if name == "GIT_CONFIG_PARAMETERS":
                return "bypass"
            if re.fullmatch(r"GIT_CONFIG_KEY_\d+", name) and val.strip().lower() == "core.hookspath":
                return "bypass"
            continue
        if t.startswith("-") or os.path.basename(t) in PREFIX_WORDS:
            continue
        break
    return None


def find_git(toks):
    for idx, raw in enumerate(toks):
        t = raw if raw.startswith("-") else raw.partition("=")[2] if "=" in raw else raw
        if os.path.basename(norm(t)) == "git":
            return idx
    return None


def scan_hook_cmd(sub, rest):
    """True when the subcommand's options carry a hook bypass."""
    k = 0
    while k < len(rest):
        t = rest[k]
        k += 1
        if not t.startswith("-"):
            continue
        t = t.rstrip(")`}")  # `(git commit -n)` leaves the paren welded on
        if t == "--":
            break
        if t.startswith("--"):
            name = t.split("=", 1)[0]
            if len(name) >= 6 and "--no-verify".startswith(name):
                return True
            if sub == "commit" and "=" not in t and name in COMMIT_LONG_VALUE:
                k += 1
            continue
        if sub != "commit":
            continue
        cluster = t[1:]
        for pos, ch in enumerate(cluster):
            if ch == "n":
                return True
            if ch in "uS":  # stuck optional value: -uno
                break
            if ch in "mFCct":  # value is the rest of the cluster, else the next token
                if pos == len(cluster) - 1:
                    k += 1
                break
    return False


def scan_config(rest):
    """True when `git config` writes core.hooksPath. Reads stay allowed."""
    positional = []
    reading = False
    k = 0
    while k < len(rest):
        t = rest[k]
        k += 1
        if t.startswith("-"):
            name = t.split("=", 1)[0]
            if name in CONFIG_READ_FLAGS:
                reading = True
            if name in CONFIG_VALUE_FLAGS and "=" not in t:
                k += 1
            continue
        positional.append(norm(t))
    if reading:
        return False
    if positional[:1] and positional[0].lower() == "set":  # git 2.46+ syntax
        positional = positional[1:]
    return len(positional) >= 2 and positional[0].lower() == "core.hookspath"


def check_git(toks, j):
    n = len(toks)
    while j < n:
        t = toks[j]
        if t in ("-c", "--config-env"):
            if j + 1 < n and hooks_path_key(toks[j + 1]):
                return "bypass"
            j += 2
        elif t in GLOBAL_VALUE:
            j += 2
        elif t.startswith("--config-env="):
            if hooks_path_key(t[len("--config-env="):]):
                return "bypass"
            j += 1
        elif t.startswith("-c") and not t.startswith("--"):  # -ccore.hooksPath=x
            if hooks_path_key(t[2:]):
                return "bypass"
            j += 1
        elif t.startswith("-"):  # --git-dir=…, --no-pager, -C/tmp, --exec-path …
            j += 1
        else:
            break
    if j >= n:
        return None
    sub = norm(toks[j])
    rest = toks[j + 1:]
    if sub in HOOK_CMDS and scan_hook_cmd(sub, rest):
        return "bypass"
    if sub == "config" and scan_config(rest):
        return "hookspath"
    return None


def check_clause(toks):
    kind = check_assignments(toks)
    if kind:
        return kind
    g = find_git(toks)
    return None if g is None else check_git(toks, g + 1)


def main():
    text = sys.stdin.buffer.read().decode("utf-8", "replace")
    text = strip_comments(join_continuations(strip_heredocs(text)))
    for clause in clauses(text):
        kind = check_clause(clause)
        if kind:
            print("BLOCK:" + kind)
            return
    print("ALLOW")


main()
PY

# Quote-blind whitespace scan for the same patterns; prints the kind of the first
# hit, or nothing. Runs in a subshell (via $(...)), so `set -f` stays local.
git_bypass_fallback() {
  local clause raw tok ltok prev has_git has_hookcmd has_commit has_config has_nv has_n hp_key
  set -f
  while IFS= read -r clause; do
    [ -z "$clause" ] && continue
    has_git=0 has_hookcmd=0 has_commit=0 has_config=0 has_nv=0 has_n=0 hp_key=0 prev=""
    for raw in $clause; do
      tok="$(normalize_token "$raw")"
      ltok="$(printf '%s' "$tok" | tr '[:upper:]' '[:lower:]')"
      case "$raw" in -*) ;; *)
        case "$(normalize_token "${raw#*=}")" in git | */git) has_git=1 ;; esac
        ;;
      esac
      case "$tok" in
        GIT_CONFIG_PARAMETERS=*)
          echo bypass
          return
          ;;
        commit) has_commit=1 has_hookcmd=1 ;;
        push | merge | cherry-pick | rebase | am) has_hookcmd=1 ;;
        config) has_config=1 ;;
        --no-v | --no-ve | --no-ver | --no-veri | --no-verif | --no-verify | --no-verify=*) has_nv=1 ;;
        --*) ;;
        -*n*) has_n=1 ;;
      esac
      case "$ltok" in
        git_config_key_*=core.hookspath | *core.hookspath=*)
          echo bypass
          return
          ;;
        core.hookspath)
          if [ "$prev" = "-c" ] || [ "$prev" = "--config-env" ]; then
            echo bypass
            return
          fi
          hp_key=1
          ;;
        *)
          # a value after `git config … core.hooksPath` is a write
          if [ "$hp_key" = 1 ] && [ "$has_config" = 1 ]; then
            echo hookspath
            return
          fi
          ;;
      esac
      prev="$raw"
    done
    if [ "$has_git" = 1 ]; then
      if [ "$has_nv" = 1 ] && [ "$has_hookcmd" = 1 ]; then
        echo bypass
        return
      fi
      if [ "$has_n" = 1 ] && [ "$has_commit" = 1 ]; then
        echo bypass
        return
      fi
    fi
  done <<< "$(printf '%s' "$COMMAND" | tr ';|&\n' '\n' | tr -s '\n')"
}

# Gate (a bash builtin match, no extra process): run python only when the command has a
# `git` word (also behind a quote, backtick, backslash or path) or mentions GIT_CONFIG, so
# `.gitignore`/`github`/`digit` stay off it.
GIT_WORD='(^|[[:space:]/;&|(`\"'"'"'])git(["'"'"']|[[:space:]]|$)'
if [[ "$COMMAND" =~ $GIT_WORD || "$COMMAND" == *GIT_CONFIG* ]]; then
  GIT_VERDICT="$(printf '%s' "$COMMAND" | python3 -I -c "$GIT_BYPASS_PY" 2> /dev/null)" || GIT_VERDICT=""
  GIT_FALLBACK_NOTE=""
  case "$GIT_VERDICT" in
    ALLOW | BLOCK:bypass | BLOCK:hookspath) ;;
    *)
      GIT_FALLBACK_NOTE=" (Fallback scan: if the flag only appears in message text, write the message to a file and use \`git commit -F <file>\`.)"
      GIT_FALLBACK_KIND="$(git_bypass_fallback)"
      GIT_VERDICT="ALLOW"
      [ -n "$GIT_FALLBACK_KIND" ] && GIT_VERDICT="BLOCK:$GIT_FALLBACK_KIND"
      ;;
  esac
  case "$GIT_VERDICT" in
    BLOCK:bypass)
      log_incident "HIGH" "SOFT BLOCKED: git hook bypass: $COMMAND"
      deny "SOFT BLOCK: bypassing git hooks (--no-verify, commit -n, a core.hooksPath override) skips the repo's checks." "Fix what the git hook reports and re-run without the bypass. If a bypass is really needed, ask the user to run the command themselves.${GIT_FALLBACK_NOTE}"
      ;;
    BLOCK:hookspath)
      log_incident "HIGH" "SOFT BLOCKED: git core.hooksPath write: $COMMAND"
      deny "SOFT BLOCK: setting core.hooksPath disables or redirects the repo's git hooks." "This disables or redirects the repo's git hooks. If the repo really uses a custom hooks dir, ask the user to confirm; don't retry.${GIT_FALLBACK_NOTE}"
      ;;
  esac
fi

# rm with a recursive flag (-r / -R / --recursive) deletes a whole tree.
# Force-only rm (`rm -f <named files>`, no -r) is NOT soft-blocked — it drops
# to the LOW warn tier below, since forcing named files is low-risk and the
# catastrophic-path scan above still hard-blocks system targets.
# Clause-aware: split on &&/||/;/| and require EVERY recursive-rm clause to be
# on the allowlist, so `rm -rf .claude/backups/x && rm -rf foo` can't slip
# through the allowlist check (C7).
RECURSIVE_RM='(^|[[:space:]])(-[a-zA-Z]*[rR][a-zA-Z]*|--recursive)([[:space:]]|$)'
if echo "$COMMAND" | grep -qE '\brm\b' && echo "$COMMAND" | grep -qE "$RECURSIVE_RM"; then
  CLAUSE_FAILED=false
  # tr replaces all clause separators with newline; tr -s collapses repeats
  CLAUSES="$(echo "$COMMAND" | tr ';|&' '\n' | tr -s '\n')"
  while IFS= read -r clause; do
    [ -z "$clause" ] && continue
    if clause_has_rm "$clause" && echo "$clause" | grep -qE "$RECURSIVE_RM"; then
      if ! echo "$clause" | grep -qE '\.claude/(backups|logs/\.(quality-gate-active|session-blocks|tool-call-count|compaction-occurred))'; then
        CLAUSE_FAILED=true
        break
      fi
    fi
  done <<< "$CLAUSES"

  if [ "$CLAUSE_FAILED" = "true" ]; then
    log_incident "MEDIUM" "SOFT BLOCKED: recursive rm (or in compound): $COMMAND"
    deny "SOFT BLOCK: rm -r/-R deletes a directory tree permanently." "Command blocked: recursive delete. If intentional, ask the user to confirm with the specific paths listed. Compound commands are checked clause-by-clause; an allowlisted clause does not exempt other clauses. (Force-only 'rm -f <file>' is allowed.)"
  fi
fi

# Writing secrets: gated on GITIGNORE STATUS, not on the file's name (F5).
#
# The question was never "is this file called .env" but "can this content reach
# the remote". `git check-ignore` answers that directly, and it is better than the
# name match in both directions: appending a variable to an ignored secrets file
# is legitimate and was wrongly blocked, while a `.env` that is NOT ignored is the
# genuinely dangerous case the name rule waved through.
#
# Fails CLOSED by construction: no git, no repo, an error, or a path outside the
# tree all return non-zero, so the name-based rule below still runs.
path_is_gitignored() {
  local p="$1"
  [ -n "$p" ] || return 1
  command -v git > /dev/null 2>&1 || return 1
  git -C "$CLAUDE_PROJECT_DIR" rev-parse --is-inside-work-tree > /dev/null 2>&1 || return 1
  git -C "$CLAUDE_PROJECT_DIR" check-ignore -q -- "$p" 2> /dev/null
}

# Only env-assignment-shaped content is judged here. Appending prose to a tracked
# README is nobody's business; appending `API_KEY=…` to one is.
# Evaluated PER CLAUSE. A whole-command match is wrong and was a real false
# positive: in a multi-line script it paired an `echo` on line 1 with a `NAME=`
# on line 3 and a `2>/dev/null` on line 4, and refused the lot. The echo, the
# assignment and the redirection all have to belong to the SAME clause.
WRITE_APPROVED=0
WRITE_CLAUSES="$(printf '%s' "$COMMAND" | tr ';|&\n' '\n' | tr -s '\n')"
while IFS= read -r wclause; do
  [ -z "$wclause" ] && continue
  echo "$wclause" | grep -qE '^[[:space:]]*(echo|printf)\b' || continue
  echo "$wclause" | grep -qE '[A-Za-z_][A-Za-z0-9_]*=' || continue
  echo "$wclause" | grep -qE '>>?[[:space:]]*[^[:space:]]+' || continue

  WRITE_TARGET="$(echo "$wclause" | sed -nE 's/.*>>?[[:space:]]*([^[:space:]|;&<>]+).*/\1/p')"
  case "$WRITE_TARGET" in
    "" | /dev/*) continue ;; # device sinks are not files anyone commits
  esac

  IS_APPEND=0
  echo "$wclause" | grep -qE '>>[[:space:]]*[^[:space:]]+' && IS_APPEND=1

  if [ "$IS_APPEND" = "1" ] && path_is_gitignored "$WRITE_TARGET"; then
    # Ignored destination + append of a variable: the legitimate case. Allowed,
    # and WRITE_APPROVED stops the name-based fallback below from re-blocking it.
    # Truncation (`>`) is deliberately NOT exempted — destroying a populated
    # secrets file needs confirmation whether or not git can see it.
    WRITE_APPROVED=1
    log_incident "LOW" "ALLOWED: variable appended to gitignored '$WRITE_TARGET'"
  elif ! path_is_gitignored "$WRITE_TARGET"; then
    log_incident "HIGH" "SOFT BLOCKED: variable written to committable '$WRITE_TARGET': $COMMAND"
    deny "SOFT BLOCK: '$WRITE_TARGET' is not gitignored, so this variable could be committed." "Put it in a gitignored file (and confirm that file is in .gitignore), or confirm with the user that this value is safe to commit. Appending to an ignored file is allowed without asking."
  fi
done <<< "$WRITE_CLAUSES"

# Overwriting system/config files. Still name-based, and still the fallback
# whenever the gitignore test above could not run (no repo, no git, error) —
# which is exactly what makes F5 fail CLOSED. Skipped only when the gitignore
# gate positively approved this write.
if [ "$WRITE_APPROVED" = "0" ] \
  && echo "$COMMAND" | grep -qE '>[[:space:]]*(~\/\.|\/etc\/|\.env|\.ssh|\.claude\/settings)'; then
  log_incident "HIGH" "SOFT BLOCKED: config/system file overwrite: $COMMAND"
  deny "SOFT BLOCK: Writing to a sensitive config/system file." "Command blocked: system file overwrite detected. Verify this is intentional with the user."
fi

# curl/wget piped to shell (arbitrary code execution)
if echo "$COMMAND" | grep -qE '(curl|wget)[[:space:]].*\|[[:space:]]*(bash|sh|zsh|ksh|dash)'; then
  log_incident "HIGH" "SOFT BLOCKED: curl pipe to shell: $COMMAND"
  deny "SOFT BLOCK: Piping curl/wget to a shell executes arbitrary remote code." "Command blocked: pipe to shell. Download the file first, inspect it, then run it."
fi

# ═══════════════════════════════════════════════════════
# LOG WARNING — allowed but recorded
# ═══════════════════════════════════════════════════════

# Any rm command (non-recursive, non-force)
if echo "$COMMAND" | grep -qE '\brm\b'; then
  log_incident "LOW" "WARNING: rm command allowed: $COMMAND"
fi

# Any mv command (could lose data if target exists)
if echo "$COMMAND" | grep -qE '\bmv\b'; then
  log_incident "LOW" "WARNING: mv command allowed: $COMMAND"
fi

# Any git checkout that discards changes
if echo "$COMMAND" | grep -qE 'git[[:space:]]+checkout[[:space:]]+\.'; then
  log_incident "MEDIUM" "WARNING: git checkout . discards changes: $COMMAND"
fi

# Writing to files outside project directory (covers > and >>).
# Two-step check avoids the consumed-stdin bug from the previous pipe form.
if echo "$COMMAND" | grep -qE '>>?[[:space:]]*/'; then
  if ! echo "$COMMAND" | grep -qE ">>?[[:space:]]*${CLAUDE_PROJECT_DIR:-/dev/null/never-matches}"; then
    log_incident "MEDIUM" "WARNING: write outside project dir: $COMMAND"
  fi
fi

exit 0
