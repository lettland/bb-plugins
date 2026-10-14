/**
 * Reads shell text for the paths it names. Two readings share it: the sibling
 * side is strict (only what a write target provably names), the family side
 * generous (anything that could name a path). Nothing here uses a regex that
 * can backtrack badly on input a command row carries.
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

/** A heredoc operator and its tag: `<<EOF`, `<<-EOF`, `<<'EOF'`, `<<"EOF"` and `<<\EOF`. */
const HEREDOC_TAG = /<<(-?)[ \t]*(?:'([A-Za-z_]\w*)'|"([A-Za-z_]\w*)"|\\?([A-Za-z_]\w*))/uy;
const HEREDOC_MARKER = /^\u0001(\d+)\u0001$/u;

/** A quoted string (an unterminated one runs to the end), an escaped character, an operator, blanks, or a run of plain characters. */
const SHELL_PIECE =
  /'[^']*(?:'|$)|"(?:\\[\s\S]|[^"\\])*(?:"|$)|\\[\s\S]|(?:\d+|&)?>[>|]?(?:&\d*-?)?|<+|&&|\|\||[;|\n&()]|[^\S\n]+|[^\s;|&()'"\\<>]+/gu;

const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/u;
/** Shell keywords that can open a command line before the command word. */
const KEYWORDS: ReadonlySet<string> = new Set(["{", "!", "if", "then", "elif", "else", "do", "while", "until"]);
/** Plain wrappers the sibling side looks through; the family side reads their options as well. */
const PLAIN_WRAPPERS: ReadonlySet<string> = new Set(["time", "sudo", "command"]);

interface Prepared {
  /** The text without comments and heredoc bodies, with a marker word where each heredoc operator was. */
  text: string;
  /** The heredoc bodies by marker; null for one whose body never began. */
  bodies: Array<string | null>;
  comments: string[];
  /** A heredoc has no terminator line. */
  unterminated: boolean;
  /** The text ends inside a heredoc body. */
  midBody: boolean;
}

interface PendingHeredoc {
  dash: boolean;
  tag: string;
  index: number;
}

function readBody(text: string, from: number, { dash, tag }: PendingHeredoc): { body: string; at: number; closed: boolean } {
  const body: string[] = [];
  let at = from;
  while (at < text.length) {
    const end = text.indexOf("\n", at);
    const line = text.slice(at, end < 0 ? text.length : end);
    at = end < 0 ? text.length : end + 1;
    if ((dash ? line.replace(/^\t+/u, "") : line) === tag) {
      return { body: body.join("\n"), at, closed: true };
    }
    body.push(line);
  }
  return { body: body.join("\n"), at, closed: false };
}

interface Scan {
  /** The quote character the scan is inside, or an empty string. */
  quote: string;
  /** The scan is where a word could begin, so a `#` here starts a comment. */
  blank: boolean;
  /** Heredocs whose body starts at the next line. */
  pending: PendingHeredoc[];
}

interface Step {
  /** What the step keeps of the text it read. */
  keep: string;
  /** How much text it read. */
  width: number;
}

function scanQuoted(char: string, following: string, scan: Scan): Step {
  const escaped = char === "\\" && scan.quote === '"';
  scan.quote = char === scan.quote ? "" : scan.quote;
  scan.blank = false;
  return escaped ? { keep: char + following, width: 2 } : { keep: char, width: 1 };
}

function scanComment(text: string, at: number, prepared: Prepared): Step {
  const end = text.indexOf("\n", at);
  const stop = end < 0 ? text.length : end;
  prepared.comments.push(text.slice(at + 1, stop));
  return { keep: "", width: stop - at };
}

/** A heredoc operator and tag at `at`, kept as a marker word; null when the `<<` is something else. */
function scanHeredoc(text: string, at: number, scan: Scan, prepared: Prepared): Step | null {
  if (text.charAt(at - 1) === "<" || text.charAt(at + 2) === "<") {
    return null;
  }
  HEREDOC_TAG.lastIndex = at;
  const found = HEREDOC_TAG.exec(text);
  if (found === null) {
    return null;
  }
  scan.pending.push({ dash: found[1] === "-", tag: found[2] ?? found[3] ?? found[4] ?? "", index: prepared.bodies.length });
  prepared.bodies.push(null);
  scan.blank = true;
  return { keep: ` \u0001${prepared.bodies.length - 1}\u0001 `, width: found[0].length };
}

/** The newline that ends a line with heredocs, with the bodies after it. */
function scanBodies(text: string, at: number, scan: Scan, prepared: Prepared): Step {
  let end = at + 1;
  for (const heredoc of scan.pending.splice(0)) {
    const read = readBody(text, end, heredoc);
    end = read.at;
    prepared.bodies[heredoc.index] = read.body;
    prepared.midBody ||= !read.closed;
  }
  scan.blank = true;
  return { keep: "\n", width: end - at };
}

function scanStep(text: string, at: number, scan: Scan, prepared: Prepared): Step {
  const char = text.charAt(at);
  const following = text.charAt(at + 1);
  if (scan.quote !== "") {
    return scanQuoted(char, following, scan);
  }
  const wordStart = scan.blank;
  scan.blank = false;
  if (char === "\\") {
    return { keep: char + following, width: 2 };
  }
  if (char === "'" || char === '"') {
    scan.quote = char;
    return { keep: char, width: 1 };
  }
  if (char === "#" && wordStart) {
    return scanComment(text, at, prepared);
  }
  const heredoc = char === "<" && following === "<" ? scanHeredoc(text, at, scan, prepared) : null;
  if (heredoc !== null) {
    return heredoc;
  }
  if (char === "\n" && scan.pending.length > 0) {
    return scanBodies(text, at, scan, prepared);
  }
  scan.blank = /[\s;|&()<>]/u.test(char);
  return { keep: char, width: 1 };
}

/**
 * Cuts comments and heredoc bodies out of the text, leaving a marker word where
 * a heredoc operator was. A `<<` or `#` inside quotes is plain text.
 */
function prepare(text: string): Prepared {
  const prepared: Prepared = { text: "", bodies: [], comments: [], unterminated: false, midBody: false };
  const scan: Scan = { quote: "", blank: true, pending: [] };
  let at = 0;
  while (at < text.length) {
    const { keep, width } = scanStep(text, at, scan, prepared);
    prepared.text += keep;
    at += width;
  }
  prepared.unterminated = prepared.midBody || scan.pending.length > 0;
  return prepared;
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
  bodies: ReadonlyArray<string | null>;
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
    const body = lexing.bodies[Number(marker[1])];
    if (body !== undefined && body !== null) {
      lexing.heredocs.push(body);
    }
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

export interface Lexed {
  commands: Command[];
  /** Comment text, without the `#`. */
  comments: string[];
  /** A heredoc has no terminator line. */
  unterminated: boolean;
}

/** Whether the text ends with a command begun but not finished, so a cut there can have cut a word. */
function endsInCommand(text: string): boolean {
  let at = text.length - 1;
  while (at >= 0 && (text[at] === " " || text[at] === "\t")) {
    at -= 1;
  }
  return at >= 0 && !";|&\n()".includes(text.charAt(at));
}

/**
 * Splits the first `limit` characters of shell text into simple commands at
 * separators outside quotes, with comments and heredoc bodies cut out first. A
 * quoted `>` is part of its word, never a redirect. When the text is longer
 * than `limit`, the command the cut touched is dropped, since a cut word can
 * name a different path than the whole one did, and so is a heredoc body cut
 * mid-way.
 */
export function lexText(text: string, limit: number): Lexed {
  const head = text.slice(0, limit);
  const { text: cut, bodies, comments, unterminated, midBody } = prepare(head);
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
  const finished = lexing.commands.length;
  endCommand(lexing);
  const cutShort = text.length > limit;
  if (cutShort && midBody) {
    lexing.commands.at(-1)?.heredocs.pop();
  } else if (cutShort && endsInCommand(head) && lexing.commands.length > finished) {
    lexing.commands.pop();
  }
  return { commands: lexing.commands, comments, unterminated };
}

export const lexCommands = (text: string, limit: number): Command[] => lexText(text, limit).commands;

/** Where the command word of a simple command is: past assignments, shell keywords and, unless asked not to, `time`, `sudo` and `command`. */
export function commandStart(words: readonly Word[], wrappers = true): number {
  let at = 0;
  while (at < words.length) {
    const text = words[at]?.text ?? "";
    if (!ENV_ASSIGNMENT.test(text) && !KEYWORDS.has(text) && !(wrappers && PLAIN_WRAPPERS.has(text))) {
      break;
    }
    at += 1;
  }
  return at;
}

/** The command word as written and by its base name, and its arguments; null for a command of assignments alone. */
export function commandOf(words: readonly Word[]): { word: string; name: string; args: Word[] } | null {
  const at = commandStart(words);
  const word = words[at];
  return word === undefined
    ? null
    : { word: word.text, name: word.text.replace(/^.*\//u, ""), args: words.slice(at + 1) };
}

/** Options before git's subcommand that take a value in the next word. */
const GIT_VALUE_OPTIONS: ReadonlySet<string> = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--super-prefix"]);
/** Options that point git at another directory, so its paths no longer resolve against the shell's. */
const GIT_RELOCATING = /^(?:-C|--git-dir|--work-tree)(?:=|$)/u;

/** A git subcommand and its arguments, past git's own options; `relocated` when an option moved git to another directory. */
export function gitCommand(args: readonly Word[]): { sub: string; rest: Word[]; relocated: boolean } | null {
  let at = 0;
  let relocated = false;
  while ((args[at]?.text ?? "").startsWith("-")) {
    const option = args[at]?.text ?? "";
    relocated ||= GIT_RELOCATING.test(option);
    at += GIT_VALUE_OPTIONS.has(option) ? 2 : 1;
  }
  const sub = args[at];
  return sub === undefined ? null : { sub: sub.text, rest: args.slice(at + 1), relocated };
}
