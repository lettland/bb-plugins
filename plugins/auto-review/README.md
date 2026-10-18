# bb-plugin-auto-review

Provider-neutral post-turn code review for bb. When an agent changes files during a turn,
auto-review injects one review-and-commit turn into the same thread: it reviews the
changes, applies fixes, commits only the paths that turn touched, and on a personal
mainline (e.g. `master`) merges the feature branch into it locally. It never pushes.

It also reviews plans, on every provider, through one of two paths kept strictly separate
by provider so a plan is never reviewed twice. On Claude Code (and its `claude-code-<slug>` profile providers), whose ExitPlanMode
routes to a real plan approval the gate can hold, the first presentation of a plan is held back
(queued, reviewed, revised) before the user sees it. Every other provider's plan approvals
never reach that gate, so instead a thread instruction tells those agents to write the
plan to a file and call the `PresentPlan` tool before substantial work, even outside plan
mode; `PresentPlan` holds the first call back for review and releases it on the second,
after the agent applies the review's findings to the plan file — the agent then ends its
turn and waits for the user's own, explicit approval, since a tool result is never
treated as that approval (unless the project opted in to auto-approve, below). If the
agent's very next tool call after an ExitPlanMode hold is the native `AskUserQuestion` (an MCP one, such as the bb-bridge tool of the same name, does
not count) asking the user what to change, auto-review answers that one question itself
(marked `[bb auto-review]`) so the queued review still reaches it instead of the user
being asked to explain a rejection they never made.

A project can opt in (Tools → Auto review → Plan auto-approve, or
`bb auto-review auto-approve on --project <id>`, which refuses to run inside a bb thread as
a guard against accidental agent use, not a security boundary; off by default) to have a
plan approved automatically once it has completed the review cycle; anything the gate
cannot show was reviewed still goes to the user. The agent mentions that the approval may
have come from auto-review rather than from the user.

In `devkit` mode, and in `auto` mode while the devkit plugin is running, the plan gate also
checks that the agent itself loaded `review-code` (`devkit_load_skill`) after the review was
sent, in whatever turn. It is an anti-shortcut check against running the review
from memory, not proof that a review ran: it does not count reviewers. A plan whose review
never loaded the skill is sent back once for a full re-review (its baseline is cleared, so
the whole plan is reviewed; reason `plan-review-redo`), whether or not the project
auto-approves. If the second round misses too, the plan is released to the user without an
auto-approve (`plan-review-incomplete`; the log names the thread and the plan file) and the
agent is told to say so; on Claude Code the only disclosure that reaches the approval dialog
is the first line the agent was asked to put in the plan text (`> auto-review: the calibrated
review did not run for this plan.`). When the check cannot be made (the plugin list, the
event log or the timeline cursor is unreadable, or more rows than the scan reads came
first) the plan is released with no auto-approve and no redo (`plan-review-unverified`).
`self` mode, and `auto` without a running devkit, check nothing. If the redo cannot be sent,
or is cancelled, the plan stays with the user as for any failed hold, with no disclosure
line. A review that runs past the 30-minute stale window re-presents into a new cycle,
which finds an empty delta, loads the skill and passes: one extra short cycle, not a loop.
Upgrading: in `devkit` and `auto` (with devkit) modes every plan whose review never loaded
`review-code` now gets one redo, auto-approve or not, and with auto-approve on such a plan
is no longer approved automatically. Set the review mode to `self` to opt out.

It ships enabled (opt-out).

## How it works

- Fires on `thread.idle` for top-level, git-branch, user coding threads.
- At most one code review per user message. Once a review is sent, no further code review fires
  for the thread until you send a new message of your own. Wake-up turns (child thread or
  background-task completions, bb system messages), tasks other threads tell it, worker
  completions and the review's own fix commits never trigger another; they stand down as
  `already-reviewed`. Work from wake-ups after the review ends (including review fixes committed
  in such a wake-up) is carried into the next review your message earns; fixes made inside the
  review turn or its continuation are covered by that review itself. A stop by you or
  `bb auto-review reset` drops the carried cursor, and reset also lifts the rule. Plan reviews
  are separate and do not count.
- Fires only at the end of work: a turn that changed nothing since the last idle that kept the
  carried cursor never fires. A question, a reply to a steer or a turn that only reads CI
  status stands down as `no-new-work`, and the carried work stays carried.
  It waits for the next turn that changes something, and nothing reviews it if no such turn
  comes; `bb auto-review reset` discards it. After a question has stood down as `no-new-work`,
  a later wake-up that commits fires the review, because your message is still unspent. Carried
  work that was pushed in the meantime drops out of scope, since only dirty or ahead paths are
  reviewed. A stop by you still drops the carried window: a question after a stop starts a fresh
  window and stands down as `no-authorship` (a reply that edits fires normally). A turn that ran
  a command that can write files (or anything whose writes can't be read) in a tree of more than
  200 uncommitted files, or with a file whose content could not be read, reviews, since a
  same-size edit to such a file cannot be seen.
- Claims only this thread's own changes. Own means this thread plus the bb children and
  owned threads it spawned, transitively. An edit made outside them (your IDE, a formatter or
  watcher, a commit nobody of the family made) neither triggers nor widens a review. Text
  cannot say exactly which files a command wrote, so a turn is decided in one of two modes:
  - **Exact**: everything the family ran was read-only or named every file it writes. The
    turn's own changes are exactly the files its file-change rows record, the files its targeted
    commands and tool rows name, and the commits it made. Any other change is `unclaimed`. A
    path a sibling thread changed through its own tools stays the sibling's unless the family's own
    file-change rows or targeted commands name it too; a tool row that only names it does not
    take it.
  - **Sweep**: the family ran something whose writes cannot be listed, so every working-tree
    change that nothing else accounts for is the turn's, as it was before this rule existed, and
    the sibling rules below still apply. When the evidence cannot be read in full (this thread's
    or a related thread's timeline is truncated or unreadable, the checkout path is unknown when
    a command wrote by name, the turn start time is unknown) the turn is a sweep too, with a log
    line naming the read that failed. When in doubt it is a sweep: losing a review of own work,
    or its secret scan, is the worse failure.

  What the family ran is classified from the text of its commands, looking through `bash -c`,
  `env`, `timeout`, subshells, `$( )` and the other wrappers listed under the family side below:
  - **Inert**, claims nothing: `cd`, `pushd`, `popd`, `echo`, `printf`, `pwd`, `true`, `false`,
    `test`, `[`, `sleep`, `which`, `command -v`, `type`, `export`, `set`, `date`, `read`; `cat`, `head`,
    `tail`, `less`, `wc`, `ls`, `grep`, `rg`, `cut`, `tr`, `sort`, `uniq`, `diff`, `jq`; `sed`
    without `-i` and without a `w`, `W` or `e` command; `awk` whose program has no `>`, `|` or
    `system` and that is given no `-i…`, `-E`, `-f…` or their long forms; `find` without `-exec`, `-execdir`, `-ok`, `-okdir`, `-delete`, `-fprint*` or `-fls`;
    read-only git (`log`, `show`, `diff`, `status`, `grep`, `blame`, `rev-parse`, `ls-files`,
    `fetch`, `branch` with no argument or with `--show-current`, `-a`, `-v`, `--list`,
    `config --get`, `stash list`, `remote -v`) and git that only touches the index, the history or
    a remote (`add`, `commit`, `push`, `tag`, `reset` without `--hard`, `rm --cached`); `gh pr|issue|run
    view|list|diff|checks`; `bb status|guide`, `bb thread show|log|output|wait|list|tell`,
    `bb auto-review status|show`; `ripwire` in a read mode (`--for`, `--grep`, `--expand`,
    `--callers`, `--impact`, `--uses`, `--exemplar`, `--pack-task`, `--plan-lanes`, `--from-trace`,
    `--quality-delta`); and check runs with no fix, update, output or report flag (`npm test`,
    `npm run lint`, `npm run typecheck` and `test:*` variants, also through `pnpm`, `yarn` and
    `bun`; `vitest`, `jest`, `tsc --noEmit`, `go test`, `go vet`, `cargo test|check|clippy`,
    `pytest`, `eslint`, `mypy`, `pyright`). A check run is opaque when it is given `-u`, `-w`,
    `--fix`, `--write`, any `--update*` (`--updateSnapshot`, `--update-snapshots`), a single-dash
    `-update*` (`go test -update`), `--snapshot-update`, `--force-regen`, `-o`, any `--output*`
    (`--outputFile`, `--output-file`), `--junit*`, any `--cov*` (`--coverage`), `--createstub`,
    `-o` (except for `jest`, where it means only-changed, and `pytest`, an ini override), the
    `go test` profile and output flags (`-coverprofile`, `-cpuprofile`, `-memprofile`, `-trace`,
    `-outputdir`), `pytest --basetemp` and `--html`, or `tsc --noEmit false`; `npm run tsc` is opaque. Read tools given an option that writes
    (`sort -o`, `rg --pre`, `git diff --output`) are not inert. So are the `cmd` of file-read and
    search rows, rows that were denied or never approved (they never ran), comments, heredoc bodies
    no interpreter reads, and a redirect into scratch space (`$TMPDIR`, `/tmp`, `/private/tmp`,
    `/var/folders`, `/dev`), unless the checkout itself lies there: a write whose path is under the
    checkout counts, and one through a variable sweeps.
  - **Targeted**, claims what it names: `>` and `>>` redirects, `tee`, `sed -i`, `perl -i`, `cp`,
    `install`, `mv`, `rm`, `rmdir`, `touch`, `mkdir`, `git rm`, `git mv`,
    `git checkout -- <paths>`, `git restore <paths>`. What each claims:
    - everything under a path (or under a directory a glob matches) only for `rm`, `rmdir`,
      `git rm`, a `mv` or `git mv` source and a `git checkout --` or `git restore` path;
    - `mkdir`, `touch`, `install -d`, `tee`, redirects and `sed -i` claim exactly the paths they
      name;
    - a `cp`, `install`, `mv` or `git mv` destination claims itself and `<dest>/<basename of each
      source>` (the destination may be an existing directory), never the whole directory; `cp -r`
      and `cp -a` claim what is beneath those too; `sed -i.bak`, `perl -pi.bak` and
      `--in-place=.bak` also claim each `<file>.bak`; unless every `mv` source is itself a
      changed file, what it moved is a directory, or something nothing of the turn's rows knew
      (made by file-change rows or by commands, then moved), so the destination claims itself and
      everything beneath it, and the moved files are kept;
    - `git rm --cached` only changes the index and claims nothing.

    A targeted command whose target is built from a variable, a substitution or a brace, that
    names nothing, that uses `-t` or `--target-directory`, or that writes after a `cd` that did not
    return to the checkout root, is opaque. A thread's shell keeps its directory from one row to
    the next (and across turns), as Claude Code's does, so a `cd` in an earlier row counts for the
    rows after it (a `cd` in a subshell, a `-c` string or a denied row does not). Each thread has
    its own shell, and so does a delegation. Where a relative path's directory is a guess, because a
    row records no `cwd` and no `cd` was seen, or its absolute `cwd` is not under the checkout
    (`/var` for `/private/var` is read as the same place), the command claims every changed path
    that equals the path or ends in `/<path>`, and with what is beneath it for a command that
    claims directories. A write is never dropped silently. A `cd` from before the lookback
    window (30 minutes) is not carried, so the write is a guess again. In Claude Code, a `cd`
    into a subdirectory makes later relative writes sweep for the lookback window, because its
    shell keeps the directory and the rows record none.
  - **Opaque**, forces a sweep: interpreters and script runs (`node`, `python`, `perl -e`, `bash x.sh`,
    `make`), `perl -i` given a script file instead of `-e` code, a `-M` module, or code that calls
    `system`, `exec`, `open`, `unlink`, `rename`, `mkdir`, `rmdir`, `truncate`, `symlink`, `link` or
    `chmod`, package scripts other than check runs (`npm run build`, `npm install`), formatters
    and fixers, `ripwire` outside its read modes (`--replace-symbol-body`, `--html`, …), text cut
    at the lexer limit, a heredoc with no terminator, process substitution (`<(…)`), a delegation
    row that shows nothing of what its subagent ran (no nested work rows and no readable child
    thread; the row is given a window like any opaque one), and any command not listed above,
    such as `bb aislop scan` or `gh pr create`. The log names only the basename of the first
    one's program, never an argument or an environment prefix.
  - **Tool rows**: a tool on the read-only list claims nothing. That list is closed: `Read`,
    `fetch`, `Grep`, `Glob`, `ToolSearch`, `Skill`, `WebSearch`, `WebFetch`, the bookkeeping
    tools `TodoWrite`, `Task*`, `SendMessage`, `ListAgents`, `Cron*`, `PushNotification`, the
    read-only Chrome tools, and these bridge tools by exact name, bare or as `mcp__bb-bridge__<name>`:
    `advisor_review`, `devkit_find_skills`, `devkit_load_skill`, `devkit_docs`,
    `agent_checklist_get`, `agent_checklist_update`, `progressive_skill_list`,
    `progressive_skill_used`, `runtime_search`, `runtime_thread`, `runtime_skill_resource`
    (and their `platform_*` aliases), `ReportReview`, `PresentPlan`,
    `update_environment_directory`, `bb_keep_checkout`. The tools that run commands or git
    (`runtime_container`, `runtime_git`, `runtime_ops`) and `Monitor` are not on it. Any other
    tool claims the changed paths its argument strings name exactly (or as the end of an absolute
    path), and a string it is given as a `command`, `cmd`, `script` or `code` field (an array of words is
    joined into one line) is classified as shell as above. Any other string with whitespace is
    prose or content, unless it opens with a program that is opaque by name (a package manager
    not running a check, `npx`, `node`, `python`, `make`, a shell, a formatter or other rewriter), which
    makes the tool opaque; so does file content that happens to open that way. It is opaque when it has no argument string,
    and the turn is a sweep, naming the tool, when it names no changed path and has no command
    field read as shell (an `edit_symbol {symbol: "Foo.bar"}` or a prompt "fix the imports" may
    have written anything). Work rows of other kinds (web search and fetch, images viewed, plan
    steps, questions) are inert; image generation, extensions and workflows are opaque.
  - **Open rows from before the turn**: an opaque row that began before the turn and was still
    pending or unended at its idle (a background `npm run dev`) does not force a sweep. It is
    logged, and writes it makes are not claimed in exact mode.

  Commits, in a sweep, are all kept after the sibling and upstream filtering below, whatever
  their author date: an opaque script can `cherry-pick` or `commit -C` and keep an old one. In exact
  mode, after that filtering, a commit is the thread's when any of these holds; a commit none of
  them holds for is left out and logged with its sha:
  the family ran git that writes history during the turn, read through wrappers (`commit`,
  `merge`, `revert`, `pull`, `rebase`, `cherry-pick`, `am`, `stash pop|apply`, `filter-branch`,
  `reset`); it was authored while an opaque command or a tool of the family ran; its author date
  or its paths are unknown; or it touches a file the family claims.

  Limitations: in a turn that ran something opaque (a build, codegen, a script, an unknown
  command) an outside edit made during that turn is swept into the review, since the code cannot
  tell it apart. A test, lint or typecheck run counts as read-only, so "run the tests and tell me"
  while you edit in your IDE fires nothing; the miss this accepts is a file such a run writes on
  its own (a snapshot), such as `cargo test` or `cargo check` rewriting `Cargo.lock`, and a
  `lint` or `test` package script that itself runs a fixer (the script's name says it only
  checks). Writes a background process makes after the turn started are not claimed in exact
  mode. A hook that rewrites files when `git commit` runs is not seen.

  When changes exist and none were claimed, the turn stands down with the reason
  `unclaimed-changes` (`no-authorship` still means nothing changed), and `bb auto-review status`
  shows how many in `lastFire`, as a count; the log lists at most five example paths. A review
  that fires with some changes left unclaimed records the count in `lastFire` as well.
- Leaves out what changed while a parked turn waited. A turn parked behind another review
  takes a snapshot of the tree when it is parked, and on release anything that appeared after the
  latest such snapshot and that the turn had not touched before it (an uncommitted path, or a
  commit that arrived meanwhile, such as a fast-forward merge or your own commit) is not the
  turn's: it is not reviewed, and a commit among it is scanned for secrets but never rewritten.
  Such a commit is still in the branch, so it rides along when the turn's work is merged: it is
  scanned, not reviewed. A file or commit the turn already touched stays, whoever changed it
  again. Untracked harness output (`.claude/`, `.codex/`, `.bb/`) is never counted. When only such
  changes are left the turn stands down as `changed-while-parked` and scans nothing;
  `lastFire` and the log name the commits and up to five example paths. Something you commit
  while a turn waits is not reviewed by that turn: ask in a later turn to have it reviewed.
  Nothing is left out after any activity of the thread or its children since the park (checked
  again after the files are read), or work that may still be writing: a shell command that
  mentions a lone `&`, `nohup`, `setsid`, `disown`, `daemon`, `coproc`, `systemd-run`, `systemctl`,
  `service`, `launchctl`, `crontab`, `pm2`, `batch`, any `tmux` or `screen`, `brew services`,
  `at` as a command, or `docker`, `podman`, `nerdctl` or `compose` with `-d`, `--detach`, `start`, `restart`
  or `up` (even inside quotes or `$( )`); a background agent; a harness background command or a
  workflow task not finished before the park; any extension (MCP) call or tool not known to be
  read-only, since a tool can start a detached process the timeline cannot show. Nor is it left
  out when HEAD does not descend from the head at the park (an amend, a rebase, a reset), when
  the turn's commit list is capped, a commit's paths cannot be read, or the park snapshot's
  commit lists do not reach back to the turn-start head, or after a failed read. A turn parked
  again takes a new snapshot, so changes between two parks stay with the turn. Limits: a row of
  the thread opened more than 30 minutes before the turn started is not seen, and a row the host
  has not yet recorded when the timelines are read is not seen either (a small race).
- Attributes work to the turn from the thread's own file-change rows plus a working-tree
  snapshot taken at turn start, so shell edits, generators and commits made during the
  turn all count in a sweep. Files another thread changed, files already dirty and left untouched,
  and harness state under `.claude/`, `.codex/` and `.bb/` are not claimed.
  Commits replayed by a rebase with the same patches as the turn started with do not
  count as new work; changed replayed patches still count.
  A commit a sibling thread made with git from its shell during the turn (`commit`,
  `merge`, `revert` or `pull`) is left to that thread, and its own auto-review covers it. It
  is only left to the sibling when nothing of this thread's own family (this thread, its
  bb children and owned threads) was running at the commit's time and the commit touches
  none of the files that family edited with tools; any doubt keeps the commit with this
  thread. A commit that arrived with a pull is left out the same way, as upstream: it is
  reachable from `origin/<mainline>` or from the remote-tracking ref of the checkout's own
  branch (`origin/<branch>`), was authored outside every window of this thread's family, and
  touches none of the files that family edited with tools. The log names the ref that held
  each such commit. If a row of the family may have pushed or moved a remote-tracking ref
  from the turn start, or from the earliest such commit's author date when that is earlier,
  nothing is dropped as upstream, from either ref, and the log says so and names the
  thread(s): a commit of the thread's own, even backdated, would otherwise look pulled once
  pushed. Once the family has pushed, pulled older work stays in review too. The same
  holds when a tool edited a file under `refs/remotes/`, `packed-refs` or `.git/config`;
  the log names the file and the thread, never file content. The row matches loosely, in
  shell text of any length: the word `push` (not after a `.`, so `git stash push` counts
  and `.push(` does not), `update-ref`, `send-pack`, `set-url`, `insteadOf`, `packed-refs`,
  `refs/remotes/`, `remotes/origin/`, a `remote.<name>.url` key, `git remote add` or
  `rename`, `gh repo sync`, or a `git fetch` with a refspec (`a:b`) or a local source (`.`,
  `./`, `$PWD`, `$(pwd)`); a row that was denied or never ran does not count. A push made
  through a script, an alias or a tool that is not a shell row, or a push in an earlier
  turn of a commit whose author date is later than that push, is not detected, so a
  deliberately backdated commit pushed that way can still be dropped. A commit someone
  made by hand in the same checkout and pushed to the branch counts as upstream too, as on
  the mainline. Only `origin/<branch>` is checked, not another configured upstream remote.
  Uncommitted paths a sibling's shell command wrote to by name during the turn (a
  redirect or `tee` target, the last argument of `cp`/`mv`/`install`, `rm`, `sed -i`, `perl -i`,
  `git checkout --` and `git restore` paths, and the paths in a `python`, `node`, `ruby` or `perl`
  script that writes a file) are left to it the same way, when no tool edit or kept commit of
  this thread's family accounts for them and nothing the family ran names them. The match is
  strict on the sibling side and generous on the family side; any doubt keeps the path with this
  thread. Nothing moves when this thread's or a related thread's timeline cannot be read in
  full, or the checkout path is unknown. The log names every credited path, in lines of at most
  20 paths that each name the sibling, never the command. What each side reads:
  - Sibling side (strict). Only the first 8,192 characters of a text are read; the command the cut
    touched and a heredoc body cut mid-way are dropped, so a cut word is never a target. The part
    past the cut (up to 1,000,000 characters) is scanned, not lexed, for a `cd`, `pushd`, `popd`,
    `builtin cd`, `command cd` or `export GIT_DIR=`/`GIT_WORK_TREE=` at the start of a line or
    after `;`, `&`, `|`, `(` or `{`; only a match, or a remainder longer than that, makes the
    shell's directory unknown for the sibling's later rows, so a long heredoc body with no such
    line leaves it known.
    Comments and heredoc bodies (`<<EOF`, `<<-EOF`, `<<'EOF'`, `<<\EOF`, tags such as `END-X`,
    `EOF.1` or `1EOF`, and a quoted tag may hold blanks, `<<'END TEXT'`) are not commands, and a
    `<<` or `#` in single quotes, or in double quotes outside a `$(…)`, is plain text; a `<<TAG`
    inside a `$(…)` is a heredoc even in double quotes (`git commit -m "$(cat <<'EOF' … EOF)"`), so
    its body is never read as commands. It belongs to the command inside the `$(…)` (`cat`), never
    to the command around it, so `python3 tools/post.py --body "$(cat <<'EOF' … EOF)"` credits
    nothing. Nothing after a `cd`, `pushd`, `popd`, `builtin cd` or `command cd` in the same text
    counts. A sibling's relative targets resolve only
    while its shell is known to be at the checkout root: an empty or unknown row `cwd` is the root
    until an earlier row of the same sibling `cd`s or `pushd`s anywhere else (`cd src`, `cd ..`,
    `cd -`, `cd` alone, `popd`, a variable); from then on only absolute targets under the root
    count, until a `cd` to the root by an absolute path. A `cd` inside a subshell `( … )`, a
    `$(…)` or `bash -c '…'` moves nothing for later rows. A row whose own `cwd` is a non-empty
    absolute path resolves against it, and a relative `cwd` resolves against the checkout root.
    `git -C`, `--git-dir`, `--work-tree` and a `GIT_DIR=`, `GIT_WORK_TREE=` or `GIT_INDEX_FILE=`
    prefix give no targets, and neither does any `git` after an `export GIT_DIR=…` or
    `export GIT_WORK_TREE=…` (or the bare assignment) in the same text or an earlier row of that
    sibling. `perl -i` counts as a short-flag cluster with `i` (`-pi`, `-i.bak`, `-0pi`), not
    `-Mstrict` or `-Ilib`. A script credits only when it contains a file-writing call:
    `open(…, 'w'|'a'|'x'|'w+')` (also `Path(…).open('w')`), `writeFile`, `writeFileSync`,
    `appendFile*`, `createWriteStream` (also `fs.promises.writeFile`), `write_text` or
    `write_bytes`. A bare `.write(` (`sys.stdout.write`, `process.stdout.write`, `res.write`) is
    not one, so `python3 -c "import sys; sys.stdout.write(open('README.md').read())"` credits
    nothing, while `f=open(p,'w'); f.write(s)` still credits `p`'s literal. A script whose every
    write call has a string-literal path credits only those paths. An `open(` call's mode is read
    only inside that call's own parentheses, so `open(x, encoding='utf8')` and
    `open('src/a.ts', 'r')` are reads, not writes. If one write call builds its path, every
    path-like word in the script counts, and a glob counts when it has a directory and a literal in
    its last segment.
  - Family side (generous). Its command text, the path and query of its reads and searches and every
    string in its tool arguments, object keys included, all count. Only command text is read as
    shell; the others only name things (exactly, as a suffix, by an absolute path or by a glob), so
    a tool called with `{ path: "src/x.ts" }` names `src/x.ts` and nothing else. A tool string
    that contains whitespace is lexed as shell text as well as names, whatever its first word
    (`{ command: "cd web && npm run format" }`, `FOO=1 npm run fix`, `./scripts/gen.sh --all`, a
    multi-line string starting with a comment), so the commands rule below applies to it; a prose
    note such as `"see notes"` names nothing but its own words. A string that is a single token
    stays names-only. All of them count, as does any glob that matches (a glob
    without a `/` only inside a command that writes), a quoted word with a blank taken whole
    (`"dir/my file.ts"`), any directory in the same simple command when it writes (a write target,
    `rm -r`, or `--fix`, `--write`, `-u`, `--update`, `--update-snapshot` outside a reader such as
    `grep` or `sort`) and the directory before a `*` or `{` in one of its words (`src/*`,
    `src/{a,b}.ts`). A text over 65,536 characters and a heredoc with no terminator line name
    every path. So does a command that rewrites files without naming them:
    - git that rewrites the tree (`stash`, `merge`, `pull`, `rebase`, `cherry-pick`, `revert`,
      `am`, `switch`, `clean`, `checkout <branch>`, `apply` without `--cached`, `reset --hard`,
      `submodule update`, `submodule foreach`) and dependency changes (`npm install`, `add`, `remove`, …)
    - a fixer flag with no path (`eslint --fix`, `jest -u`, `prettier --write`) and a whole-tree
      formatter (`go fmt`, `cargo fmt`, `deno fmt`, `gofmt -w`, `black`, `isort`, `autopep8`, `yapf`,
      `ruff format`); `python -m black .` and the other formatters run through `python -m` count
      the same way
    - a package script or make target whose name contains `fix`, `format`, `fmt`, `codemod`,
      `generate`, `gen`, `update`, `sync` or `prettier`, or `make` with no target; a plain `lint`,
      `test` or `build` script does not count, nor do tests, `git reset <paths>` or
      `git apply --cached`. A package manager's own options before the script name are skipped,
      with their values, so these count like the bare forms: `pnpm --filter web run format`,
      `pnpm -C web fix`, `pnpm -r --filter x lint:fix`, `yarn workspace web fix`,
      `yarn workspaces foreach run fix`, `npm --prefix web run fix`, `npm -w web run format`, and the
      same before `install` or `add`
    - a script file (`python x.py`, `node build.js`, `bash x.sh`, `tsx`, `ts-node`, `bun x.ts`,
      `bun run x.ts`, `deno run x.ts`, `./x.sh`), `jscodeshift` and `go generate`. For `bash`, `sh`, `zsh`, `dash`
      and `ksh`, `-e`, `-u`, `-x` and `-o <opt>` are options, so `bash -e scripts/gen.sh` and
      `bash -euo pipefail x.sh` run a script file; only `-c` (or a cluster ending in `c`, such as
      `-lc`) takes a command string. For `node`, `python`, `ruby` and `perl`, `-e` and `-c` take
      the code itself. Options that take a value (`node --import x`, `--require x`, `-r x`,
      `--loader x`, `--env-file .env`, `--conditions x`, `--input-type x`) are skipped when looking
      for the script path, so `node --env-file .env x.js` counts. A script `bun run` names
      counts like one `bun` is given directly (`bun run build` is a package script and does not)
    - an `eval` whose string is built from `$…` or a backtick (`eval "$VAR"`, `eval $(ssh-agent -s)`),
      which cannot be read; an `eval` of plain words is read as the shell text it runs
    - `python -m <module>`: a formatter (`black`, `isort`, `ruff`, `autopep8`, `yapf`) given no path
      or `.`, a module whose name contains one of the rewriting words above, and any dotted module
      (project code, which can do anything); `pip` (so `pip install`), `pytest` and other plain
      module names do not count
    - `xargs` and `parallel`, `find` with `-exec`, `-execdir`, `-ok` or `-delete`, `fd` with `-x` or
      `-X`, and `patch`, `rsync`, `unzip` and `tar` with `x` in its mode
    - a writing command whose write target is built with `$`, a backtick or `$(…)`
      (`sed -i … $(git ls-files)`, `echo x > $p/a.ts`)

    A `$(…)` does not split the command around it: its inner commands are read on their own, and
    the outer command goes on after the `)` with a `$()` word, so `mv $(git ls-files '*.ts') lib/`
    names `lib/`.

    The command is read through its wrappers: `env` and its `VAR=x` arguments, `cross-env` and its
    `VAR=x` arguments, `timeout <dur>`, `nohup`, `nice`, `exec`, `command`, `sudo`, `time`,
    `stdbuf`, `npx`, `bunx`, `uvx`, `pnpm exec|dlx`, `yarn dlx`, `uv run`, `poetry run`,
    `pipenv run`, `bundle exec` and `deno run`, so `timeout 300 npm install` and
    `env CI=1 npm run format` count like the bare forms. The string a `sh`, `bash`, `zsh`, `dash`
    or `ksh` runs with `-c` or `-lc`, and the words an `eval` runs, are read as commands too.

  Known gaps:
  - a sibling write that names no path, builds it from variables or brace expansion, or uses a
    pattern the strict rules reject (a bare `*`, a glob without a directory or a literal in its last
    segment, anything after a `cd`) stays with this thread, so it is reviewed one extra time
  - a command of this thread's family that rewrites a file without naming it through something the
    family side does not know (a custom codegen binary, an alias, a make target without one
    of the words above) lets a sibling's write to that file go to the sibling
  - a script that writes one file while reading another through a variable, or through `.write(`
    alone, credits every path it names
  - a path left to a sibling is covered by that sibling's own review only if its write changed the
    content during the sibling's turn; otherwise neither review covers it (content-neutral targets
    such as `touch` and `git restore --staged` are excluded to keep this rare)
  - a family row that began more than 30 minutes before the turn and is still running is not seen
  - the real fix for a shared checkout is one checkout per session (BB's "Checkout, then worktree")
  - this thread's own shell edits (no tool row) swept into a sibling's `git add -A` commit
    are left to the sibling
  - a sibling's `rebase`, `cherry-pick` and `am` commits keep their author date, so they are
    still credited to this turn
  - an amend or `-C` reuse of a sibling's commit keeps the sibling's author date and can be
    left to the sibling
  - a commit left to a sibling is reviewed and secret-scanned only by that sibling's own
    auto-review; if that one stands down (for example user-stopped), nothing reviews it
- Fixes and commits valid pre-existing issues the review finds in the files the turn touched,
  except unrelated ones when the work is a named feature (a user-named `/` branch, not the
  tool-generated branches such as `bb/…`, or a cited ticket). A pre-existing fix lands in the same
  commit as the turn's other changes to that file, named in the commit message.
- Chooses commit and merge from a branch policy keyed on the mainline name. A feature
  branch (name contains a `/`, e.g. `fix/x`, `bb/<slug>`) merges into an eligible mainline;
  a top-level branch such as `develop` is never merged; a non-eligible (protected) mainline such as
  `main` is never a merge target, and the primary checkout is never committed to there.
- Holds the turn while any child it spawned, in any turn, is still running (directly or
  transitively): bb wakes it with a new turn each time one ends, but only the turn after
  the last one ends reviews its work — an earlier wake-up with another child still running
  just re-parks.
- A review that hands its work to child threads stays in flight while one of them is
  running or a due wake-up from one is queued, until the first idle 2 hours after the review
  was delivered. The wake-up turns that apply its fixes are part of that review and are not
  reviewed again. A stop by you ends it. A turn of your own during the hold ends it too and
  is reviewed normally, once the children finish; a message steered into the review or a
  wake-up turn counts as part of the review. Other reviews on the provider wait behind
  the hold, up to that cap. Residual race: if a child goes idle before bb queues its wake-up,
  the hold ends one idle early and that wake-up turn's fixes get one more review.
- Runs one review at a time per provider across all projects, since those reviews share
  the provider's usage limits. A turn ending behind another review is deferred, not
  dropped, and fires when the blocking review ends. A question you send while the turn is
  parked does not fire it: the parked work becomes carried work, and the next turn that
  changes something reviews it.
  When nothing disables it, a released turn leaves out what changed while it was parked (see
  `changed-while-parked` above).
- Never fires alongside a message you queued. If a user message is waiting when the turn
  ends (or its turn has already started), the review is carried into that turn. It fires
  once a turn that changes something ends with nothing of yours queued, covering every turn
  since; if your message only asks a question, the work stays carried (`no-new-work`).
- Commits only a complete, working change. The review turn gets the full list of files the
  turn authored, checks that nothing the staged change depends on is left out, and runs the
  project's typecheck/build and tests. If the work is unfinished, broken, or could only be
  committed in part, it leaves it uncommitted and reports what is missing. When the work
  separates cleanly, it commits it as small focused commits, one per logical change,
  rather than one large commit. Each commit is checked to carry what it depends on, but
  only the full set is built and tested. If one of those commits fails, the earlier ones
  stay, the rest is left uncommitted, and the branch is not merged. A turn that changed
  more than 400 files is reviewed but left for the user to commit.
- After committing, the review turn checks the thread's plan and continues genuinely
  unfinished planned work. It never invents work.
- Records what each review reported. The review turn ends by calling the `ReportReview` tool
  with an outcome (`committed`, `merged`, `uncommitted`, `blocked`, `no-changes`), a summary
  and its findings. Findings persist per thread as chains with stable keys: the next review is
  told what is still open, a repeat is marked re-raised, and dismissing a false positive a
  second time needs a new reason. A review that never reported shows as `not-reported`, a
  stopped or cancelled one as `stopped`, one that could not be sent as `unavailable`; none
  reads as a pass. Outcomes are agent-reported, not verified against git. A session started
  before this plugin version does not have the tool until restarted and shows "Review not
  reported". See `bb auto-review status` and `bb auto-review findings`.

The full behavior, including the branch policy table and every `status` reason, is in
[`skills/auto-review/SKILL.md`](skills/auto-review/SKILL.md). The skill ships with the
plugin, so agents can read it too.

## Settings

| Setting | Default | Meaning |
|---|---|---|
| Enabled | on | Global kill switch |
| Merge-eligible mainlines | `master` | Comma-separated branch names a feature branch may be merged into locally |
| Review mode | `auto` | `auto` uses devkit's calibrated review when `devkit_load_skill` is available, else self-review; `devkit` requires it; `self` always self-reviews |

Under bb, `auto` (when devkit is available) and `devkit` modes hand the five lens reviews — and
the closure review — to bb child threads when the thread can spawn children (otherwise provider
subagents, or sequentially in the same thread); `self` mode and the no-devkit case in `auto`
still review in the same thread. A full calibrated review costs about six sessions on the
provider (five lenses plus closure).

Per-project overrides are stored in the plugin's own storage. bb's settings page for this
plugin (Tools → Auto review) also has a Plan auto-approve section that lists every project with its own switch for approving reviewed
plans automatically; it writes the same storage as `bb auto-review auto-approve`.

## CLI

All commands accept `--json`.

| Command | What it does |
|---|---|
| `bb auto-review status` | Effective state (including `planGate`, whether this thread's plan review is served here by the native ExitPlanMode gate), last-fire outcome, and the last review's reported outcome with open/re-raised finding counts (`reviewResult`, plus `omittedFromPrompt`: open findings the next review's prompt cannot list) for the current thread |
| `bb auto-review show` | Global defaults, project override and resolved settings for the current project |
| `bb auto-review enable [--global \| --project <id>]` | Turn it on; bare `enable` is global |
| `bb auto-review disable [--global \| --project <id>]` | Turn it off, same scoping |
| `bb auto-review auto-approve <on\|off> --project <id>` | Approve reviewed plans automatically for one project (off by default); `--project` is required and must exist, and `on` is refused from inside a bb thread (an accident guard, not a security boundary) |
| `bb auto-review findings [thread-id] [--clear]` | List what a thread's reviews reported (finding chains, flagging high/blocker ones dismissed more than once, and incidents). `--clear` drops the chains only; it is refused inside a bb thread and needs an explicit thread id |
| `bb auto-review reset <thread-id>` | Clear a wedged loop-guard latch on an idle thread, and discard its carried work; refused while the thread is running or holds a `deferred` turn (its review runs when the hold clears) |

The agent-hooks plugin's `review-plan-before-exit.sh` reads `planGate` from
`bb auto-review status --json` and stands down where it is true, so a plan is reviewed
once rather than twice. Renaming or removing this field brings back the duplicate review.

## Install

```sh
bb plugin install npm:@lettland/bb-plugin-auto-review
```

Install [devkit](../devkit) alongside it to get the calibrated review in `auto` mode.

Install [aislop](../aislop) alongside it and every code review also runs `bb aislop scan`
on the branch's changes — also on the root branch itself, where it covers unpushed
commits and uncommitted work, and from the turn-start commit when the turn already
committed. Its findings are advisory: the review fixes the real ones in
the files the turn touched, pre-existing lines included, and it leaves false positives and
anything against the project's own rules (CLAUDE.md / AGENTS.md, lint config, local
conventions) unfixed, listing each with a reason. auto-review checks the plugin list
before each review and asks for the scan only while a running plugin serves `bb aislop`;
with aislop missing or disabled the step is left out, and each plugin works on its own.

## Development

```sh
npm install --include=dev --legacy-peer-deps
npm test
npm run test:coverage
npm run typecheck
bb plugin build
```
