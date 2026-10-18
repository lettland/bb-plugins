/**
 * Reads shell text for git that writes history. The match is strict and misses
 * on purpose — a lone `&`, subshells, `bash -c`, `env git`, `--git-dir <p>`
 * written as two words — because a miss only keeps a commit with this thread.
 * Extending the parser is unsafe only if it starts matching non-git text.
 * `mayMoveRemoteRef` below is the opposite: loose on purpose, because a miss
 * there would drop a commit of this thread's from its review.
 */

/** Only this much of a command is scanned, so the cost stays linear in what a row carries. */
const HISTORY_GIT_SCAN_LIMIT = 8_192;
const HISTORY_GIT_SUBCOMMANDS: ReadonlySet<string> = new Set(["commit", "merge", "revert", "pull"]);
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/u;

/**
 * One piece of shell text: a quoted string (an unterminated one runs to the
 * end), an escaped character, a separator (`;`, `&&`, `|`, a newline), blanks, or
 * a run of plain characters.
 */
const SHELL_PIECE = /'[^']*(?:'|$)|"(?:\\[\s\S]|[^"\\])*(?:"|$)|\\[\s\S]|&&|[;|\n]|[^\S\n]+|[^\s;|&'"\\]+|&/gu;

/** A word piece without its quotes or escaping backslash. */
function pieceText(piece: string): string {
  const quote = piece.charAt(0);
  if (quote !== "'" && quote !== '"') {
    return piece.replace(/^\\/u, "");
  }
  return piece.slice(1, piece.length > 1 && piece.endsWith(quote) ? -1 : undefined);
}

/** Splits shell text into simple commands of unquoted words, at separators outside quotes. */
function simpleCommands(text: string): string[][] {
  const commands: string[][] = [];
  let words: string[] = [];
  let word: string | null = null;
  const endWord = () => {
    if (word !== null) {
      words.push(word);
      word = null;
    }
  };
  const endCommand = () => {
    endWord();
    if (words.length > 0) {
      commands.push(words);
      words = [];
    }
  };
  for (const [piece] of text.slice(0, HISTORY_GIT_SCAN_LIMIT).matchAll(SHELL_PIECE)) {
    if (/^(?:[;|\n]|&&)$/u.test(piece)) {
      endCommand();
    } else if (/^\s/u.test(piece)) {
      endWord();
    } else if (piece !== "\\\n") {
      word = (word ?? "") + pieceText(piece);
    }
  }
  endCommand();
  return commands;
}

/** The git subcommand of a simple command, or undefined when it is not git. */
function gitSubcommand(words: readonly string[]): string | undefined {
  let at = 0;
  while (ENV_ASSIGNMENT.test(words[at] ?? "")) {
    at += 1;
  }
  if (words[at] !== "git") {
    return undefined;
  }
  at += 1;
  while ((words[at] ?? "").startsWith("-")) {
    at += words[at] === "-C" || words[at] === "-c" ? 2 : 1;
  }
  return words[at];
}

function writesHistory(words: readonly string[]): boolean {
  return HISTORY_GIT_SUBCOMMANDS.has(gitSubcommand(words) ?? "");
}

/**
 * Whether shell text runs `git commit`, `merge`, `revert` or `pull`. Strict on
 * purpose: it decides that a commit was another thread's. `rebase`,
 * `cherry-pick` and `am` keep the original author date, so they cannot be
 * matched to a commit by time.
 */
export function isHistoryWritingGit(text: string): boolean {
  return simpleCommands(text).some(writesHistory);
}

/**
 * Shell text that can move a remote-tracking ref, which would make a local
 * commit look like pulled work: the word `push` anywhere (`git push`, inside a
 * nested shell, behind `env` or a path to git), `update-ref`, a
 * `refs/remotes/` name, `gh repo sync`, or a `git fetch` whose source is `.`.
 * Not a parser: false positives (`git stash push`, `echo push`) only keep a
 * commit in review, and a miss would drop one.
 */
const REMOTE_REF_MOVERS =
  /\bpush\b|\bupdate-ref\b|refs\/remotes\/|\bgh\s+repo\s+sync\b|\bfetch\b[^;&|\n]*\s\.(?:\s|$)/u;

export function mayMoveRemoteRef(text: string): boolean {
  return REMOTE_REF_MOVERS.test(text);
}
