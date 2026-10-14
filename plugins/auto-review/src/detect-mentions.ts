/**
 * Reads shell text for the paths it names. Two readings share it: the sibling
 * side is strict (only what a write target provably names), the family side
 * generous (anything that could name a path). Nothing here uses a regex that
 * can backtrack badly on input a command row carries; globs are matched by a
 * segment matcher instead.
 */

export interface Word {
  text: string;
  /** Any part of the word was quoted. */
  quoted: boolean;
}

export interface Command {
  /** The command word and its arguments, redirects and heredocs left out. */
  words: Word[];
  /** Targets of `>`, `>>` and their fd forms; `>&2` and `2>&1` name none. */
  redirects: Word[];
  /** Files an input redirect (`<`, `<<<`) reads. */
  inputs: Word[];
  /** Heredoc bodies the command reads. */
  heredocs: string[];
}

const HEREDOC = /(?<!<)<<(-?)\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\2/gu;
const HEREDOC_MARKER = /^\u0001(\d+)\u0001$/u;

/** A quoted string (an unterminated one runs to the end), an escaped character, an operator, blanks, or a run of plain characters. */
const SHELL_PIECE =
  /'[^']*(?:'|$)|"(?:\\[\s\S]|[^"\\])*(?:"|$)|\\[\s\S]|(?:\d+|&)?>[>|]?(?:&\d*-?)?|<+|&&|\|\||[;|\n&()]|[^\S\n]+|[^\s;|&()'"\\<>]+/gu;

const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/u;
/** Words that can open a command line before the command word. */
const LEADING_WORDS: ReadonlySet<string> = new Set([
  "{", "!", "if", "then", "elif", "else", "do", "while", "until", "time", "sudo", "command",
]);

/** Cuts every heredoc body out of the text, leaving a marker word where its operator was. */
function cutHeredocs(text: string): { text: string; bodies: string[] } {
  const lines = text.split("\n");
  const bodies: string[] = [];
  const kept: string[] = [];
  let at = 0;
  while (at < lines.length) {
    const found: Array<{ dash: boolean; tag: string }> = [];
    kept.push(
      (lines[at] ?? "").replace(HEREDOC, (_match, dash: string, _quote: string, tag: string) => {
        found.push({ dash: dash === "-", tag });
        return ` \u0001${bodies.length + found.length - 1}\u0001 `;
      }),
    );
    at += 1;
    for (const { dash, tag } of found) {
      const body: string[] = [];
      while (at < lines.length && (dash ? (lines[at] ?? "").replace(/^\t+/u, "") : lines[at]) !== tag) {
        body.push(lines[at] ?? "");
        at += 1;
      }
      at += 1;
      bodies.push(body.join("\n"));
    }
  }
  return { text: kept.join("\n"), bodies };
}

/** A word piece without its quotes or escaping backslash; an unterminated quote runs to the end. */
function pieceText(piece: string): string {
  const quote = piece.charAt(0);
  if (quote === "'" || quote === '"') {
    const closed = piece.length > 1 && piece.endsWith(quote);
    return piece.slice(1, closed ? piece.length - 1 : piece.length);
  }
  return quote === "\\" ? piece.slice(1) : piece;
}

type PieceKind = "separator" | "blank" | "input" | "redirect" | "duplicate" | "continuation" | "word";

function pieceKind(piece: string): PieceKind {
  if (/^(?:&&|\|\||[;|\n&()])$/u.test(piece)) {
    return "separator";
  }
  if (/^\s/u.test(piece)) {
    return "blank";
  }
  if (piece.startsWith("<")) {
    return "input";
  }
  if (/^(?:\d+|&)?>/u.test(piece)) {
    return /&\d*-?$/u.test(piece) ? "duplicate" : "redirect";
  }
  return piece === "\\\n" ? "continuation" : "word";
}

interface Lexing {
  commands: Command[];
  words: Word[];
  redirects: Word[];
  inputs: Word[];
  heredocs: string[];
  /** The word being built; null between words. */
  word: string | null;
  quoted: boolean;
  /** What the next word is: a redirect's target, or an input redirect's file to drop. */
  expecting: "target" | "skip" | null;
  bodies: readonly string[];
}

const EXPECTED_AFTER: Partial<Record<PieceKind, "target" | "skip">> = { input: "skip", redirect: "target" };

function endWord(lexing: Lexing): void {
  if (lexing.word === null) {
    return;
  }
  const done = { text: lexing.word, quoted: lexing.quoted };
  const wanted = lexing.expecting;
  lexing.word = null;
  lexing.quoted = false;
  lexing.expecting = null;
  const marker = HEREDOC_MARKER.exec(done.text);
  if (wanted === "target") {
    lexing.redirects.push(done);
  } else if (wanted === "skip") {
    lexing.inputs.push(done);
  } else if (wanted === null && marker !== null) {
    lexing.heredocs.push(lexing.bodies[Number(marker[1])] ?? "");
  } else if (wanted === null) {
    lexing.words.push(done);
  }
}

function endCommand(lexing: Lexing): void {
  endWord(lexing);
  lexing.expecting = null;
  const { words, redirects, inputs, heredocs } = lexing;
  if (words.length > 0 || redirects.length > 0 || heredocs.length > 0) {
    lexing.commands.push({ words, redirects, inputs, heredocs });
  }
  lexing.words = [];
  lexing.redirects = [];
  lexing.inputs = [];
  lexing.heredocs = [];
}

function lexPiece(lexing: Lexing, piece: string): void {
  const kind = pieceKind(piece);
  if (kind === "separator") {
    endCommand(lexing);
  } else if (kind === "word") {
    lexing.word = (lexing.word ?? "") + pieceText(piece);
    lexing.quoted ||= piece.startsWith("'") || piece.startsWith('"');
  } else if (kind !== "continuation") {
    endWord(lexing);
    if (kind !== "blank") {
      lexing.expecting = EXPECTED_AFTER[kind] ?? null;
    }
  }
}

/**
 * Splits the first `limit` characters of shell text into simple commands at
 * separators outside quotes, with heredocs cut out first. A quoted `>` is part
 * of its word, never a redirect.
 */
export function lexCommands(text: string, limit: number): Command[] {
  const { text: cut, bodies } = cutHeredocs(text.slice(0, limit));
  const lexing: Lexing = {
    commands: [],
    words: [],
    redirects: [],
    inputs: [],
    heredocs: [],
    word: null,
    quoted: false,
    expecting: null,
    bodies,
  };
  for (const [piece] of cut.matchAll(SHELL_PIECE)) {
    lexPiece(lexing, piece);
  }
  endCommand(lexing);
  return lexing.commands;
}

/** The command word as written and by its base name, and its arguments; null for a command of assignments alone. */
export function commandOf(words: readonly Word[]): { word: string; name: string; args: Word[] } | null {
  let at = 0;
  while (at < words.length && (ENV_ASSIGNMENT.test(words[at]?.text ?? "") || LEADING_WORDS.has(words[at]?.text ?? ""))) {
    at += 1;
  }
  const word = words[at];
  return word === undefined
    ? null
    : { word: word.text, name: word.text.replace(/^.*\//u, ""), args: words.slice(at + 1) };
}

/** A git subcommand and its arguments, past git's own options. */
export function gitCommand(args: readonly Word[]): { sub: string; rest: Word[] } | null {
  let at = 0;
  while ((args[at]?.text ?? "").startsWith("-")) {
    at += args[at]?.text === "-C" || args[at]?.text === "-c" ? 2 : 1;
  }
  const sub = args[at];
  return sub === undefined ? null : { sub: sub.text, rest: args.slice(at + 1) };
}

/** Longest glob taken at face value; a longer one is not matched. */
export const MAX_GLOB_LENGTH = 256;

export function isGlob(token: string): boolean {
  return /[*?[]/u.test(token);
}

/**
 * Whether a glob names files with enough certainty for the sibling side: it
 * contains `/`, starts with a literal directory, and its last segment has a
 * literal character other than `*`, `?` and `.`. A bare `*` or `**` never does.
 */
export function globQualifies(glob: string): boolean {
  const segments = glob.split("/");
  const first = segments[0] ?? "";
  return (
    glob.length <= MAX_GLOB_LENGTH &&
    segments.length >= 2 &&
    first !== "" &&
    !isGlob(first) &&
    /[^*?.]/u.test(segments[segments.length - 1] ?? "")
  );
}

function classMatches(body: string, char: string): boolean {
  const negated = body.startsWith("!") || body.startsWith("^");
  const set = negated ? body.slice(1) : body;
  let hit = false;
  for (let at = 0; at < set.length; at += 1) {
    if (set[at + 1] === "-" && at + 2 < set.length) {
      hit ||= char >= (set[at] ?? "") && char <= (set[at + 2] ?? "");
      at += 2;
    } else {
      hit ||= set[at] === char;
    }
  }
  return hit !== negated;
}

/**
 * Matches items against a pattern, where a star token spans any number of
 * items. One backtrack point keeps it polynomial, whatever the pattern.
 */
function wildcardMatch<P, T>(
  pattern: readonly P[],
  items: readonly T[],
  isStar: (token: P) => boolean,
  matches: (token: P, item: T) => boolean,
): boolean {
  let at = 0;
  let pos = 0;
  let star = -1;
  let starPos = 0;
  while (pos < items.length) {
    const token = pattern[at];
    if (token !== undefined && isStar(token)) {
      star = at;
      at += 1;
      starPos = pos;
    } else if (token !== undefined && matches(token, items[pos] as T)) {
      at += 1;
      pos += 1;
    } else if (star >= 0) {
      at = star + 1;
      starPos += 1;
      pos = starPos;
    } else {
      return false;
    }
  }
  while (at < pattern.length && isStar(pattern[at] as P)) {
    at += 1;
  }
  return at === pattern.length;
}

/** A segment pattern as tokens: `*`, `?`, a `[…]` class or a literal character. */
function patternTokens(pattern: string): string[] {
  const tokens: string[] = [];
  for (let at = 0; at < pattern.length; at += 1) {
    const end = pattern[at] === "[" ? pattern.indexOf("]", at + 2) : -1;
    tokens.push(pattern.slice(at, end > 0 ? end + 1 : at + 1));
    at = end > 0 ? end : at;
  }
  return tokens;
}

function charMatches(token: string, char: string): boolean {
  if (token.length > 2 && token.startsWith("[")) {
    return classMatches(token.slice(1, -1), char);
  }
  return token === "?" || token === char;
}

/** One path segment against one pattern segment. */
function segmentMatches(pattern: string, text: string): boolean {
  return wildcardMatch(patternTokens(pattern), text.split(""), (token) => token === "*", charMatches);
}

/** A matcher for a glob against a whole path. */
export function globMatcher(glob: string): (path: string) => boolean {
  const segments = glob.split("/");
  // A `**` segment spans any number of path segments, none included.
  return (path) => wildcardMatch(segments, path.split("/"), (segment) => segment === "**", segmentMatches);
}
