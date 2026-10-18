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
 * Words that can move a remote-tracking ref or the remote it follows, found
 * anywhere in shell text: `push` (not after a `.`, as in a `.push(` pattern),
 * `update-ref`, `send-pack`, `set-url`, `insteadOf`, `packed-refs`, and
 * `remotes/` (git reads `remotes/origin/x` as `refs/remotes/origin/x`).
 */
const REMOTE_REF_WORDS =
  /(?<![.\w])push\b|\bupdate-ref\b|\bsend-pack\b|\bset-url\b|\binsteadOf\b|\bpacked-refs\b|\bremotes\//u;

/** A `git fetch` source that is this repository. */
const LOCAL_SOURCES: ReadonlySet<string> = new Set([".", '"."', "'.'", "./", "$PWD", '"$PWD"', "$(pwd)"]);

/** Whether one command, split at `;`, `&`, `|` or a newline, fetches into a local ref or runs `gh repo sync`. */
function mayMoveRemoteRefInCommand(command: string): boolean {
  const words = command.split(/\s+/u);
  const fetch = words.indexOf("fetch");
  if (fetch !== -1) {
    // A refspec (`a:b`) or a local source makes the fetch write refs of this repository.
    const rest = words.slice(fetch + 1);
    if (rest.some((word) => LOCAL_SOURCES.has(word) || (word.indexOf(":") > 0 && !word.endsWith(":")))) {
      return true;
    }
  }
  const gh = words.indexOf("gh");
  return gh !== -1 && words[gh + 1] === "repo" && words[gh + 2] === "sync";
}

/** A `remote.<name>.url` config key, found without backtracking. */
function namesRemoteUrl(text: string): boolean {
  const at = text.indexOf("remote.");
  return at !== -1 && text.indexOf(".url", at + "remote.".length) !== -1;
}

/**
 * Shell text that can move a remote-tracking ref, which would make a local
 * commit look like pulled work. The words of `REMOTE_REF_WORDS`, a
 * `remote.<name>.url` key, `gh repo sync`, and a `git fetch` with a refspec or
 * a local source. Not a parser, and never truncated, since a miss would drop a
 * commit: false positives (`git stash push`, `echo push`) only keep one in
 * review. Every check is linear in the text.
 */
export function mayMoveRemoteRef(text: string): boolean {
  return (
    REMOTE_REF_WORDS.test(text) || namesRemoteUrl(text) || text.split(/[;&|\n]/u).some(mayMoveRemoteRefInCommand)
  );
}
