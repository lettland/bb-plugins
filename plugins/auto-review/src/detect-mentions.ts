/**
 * Reads shell text for the paths it names. Two readings share it: the sibling
 * side is strict (only what a write target provably names), the family side
 * generous (anything that could name a path). Nothing here uses a regex that
 * can backtrack badly on input a command row carries.
 */

import { prepare } from "./detect-prepare.js";

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
  /** How many parentheses were open around it; above zero it runs in a subshell or a command substitution. */
  depth: number;
}

const HEREDOC_MARKER = /^\u0001(\d+)\u0001$/u;
const EMBEDDED_MARKER = /\u0001(\d+)\u0001/gu;

/** A quoted string (an unterminated one runs to the end), an escaped character, an operator, blanks, or a run of plain characters. */
const SHELL_PIECE =
  /'[^']*(?:'|$)|"(?:\\[\s\S]|[^"\\])*(?:"|$)|\\[\s\S]|(?:\d+|&)?>[>|]?(?:&\d*-?)?|<+|&&|\|\||[;|\n&()]|[^\S\n]+|[^\s;|&()'"\\<>]+/gu;

const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/u;
/** Shell keywords that can open a command line before the command word. */
const KEYWORDS: ReadonlySet<string> = new Set(["{", "!", "if", "then", "elif", "else", "do", "while", "until"]);
/** Plain wrappers the sibling side looks through; the family side reads their options as well. */
const PLAIN_WRAPPERS: ReadonlySet<string> = new Set(["time", "sudo", "command", "builtin"]);

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
  /** Parentheses open now. */
  depth: number;
  /** The `$(` substitutions open, each with the command it sits in and the depth it opened at. */
  subs: Array<{ outer: Outer; depth: number }>;
}

/** The command a `$(` substitution sits in, set aside while the commands inside it are read. */
type Outer = Pick<Lexing, "words" | "redirects" | "inputs" | "heredocs" | "word" | "quoted" | "expecting">;

const EXPECTED_AFTER: Partial<Record<PieceKind, "target" | "skip">> = { input: "skip", redirect: "target" };

/** The longest command a quoted `$(…)` is read from, to find which command a heredoc inside it belongs to. */
const SUBSTITUTION_LIMIT = 8_192;

/**
 * A word without the heredoc markers inside it: a heredoc in a quoted `$(…)`.
 * Its body belongs to the command inside the substitution (`cat` in `"$(cat <<EOF`),
 * so it is set aside as a command of its own and never reaches the outer one.
 */
function withoutMarkers(lexing: Lexing, text: string): string {
  if (!text.includes("\u0001")) {
    return text;
  }
  return text.replace(EMBEDDED_MARKER, (_marker, index: string, offset: number) => {
    const body = lexing.bodies[Number(index)];
    if (body !== undefined && body !== null) {
      const before = text.slice(0, offset);
      const open = before.lastIndexOf("$(");
      const inner = lexCommands(open < 0 ? before : before.slice(open + 2), SUBSTITUTION_LIMIT).at(-1)?.words ?? [];
      lexing.commands.push({ words: inner, redirects: [], inputs: [], heredocs: [body], depth: lexing.depth + 1 });
    }
    return "";
  });
}

function endWord(lexing: Lexing): void {
  if (lexing.word === null) {
    return;
  }
  const done = { text: HEREDOC_MARKER.test(lexing.word) ? lexing.word : withoutMarkers(lexing, lexing.word), quoted: lexing.quoted };
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
    lexing.commands.push({ words, redirects, inputs, heredocs, depth: lexing.depth });
  }
  lexing.words = [];
  lexing.redirects = [];
  lexing.inputs = [];
  lexing.heredocs = [];
}

/** A `(` right after a `$`: the commands inside are read on their own, and the outer command goes on after the `)`. */
function openSubstitution(lexing: Lexing): void {
  const { words, redirects, inputs, heredocs, word, quoted, expecting } = lexing;
  lexing.subs.push({ outer: { words, redirects, inputs, heredocs, word, quoted, expecting }, depth: lexing.depth });
  lexing.words = [];
  lexing.redirects = [];
  lexing.inputs = [];
  lexing.heredocs = [];
  lexing.word = null;
  lexing.quoted = false;
  lexing.expecting = null;
}

/** The `)` that closes a substitution: the outer command carries on with `$()` as the word. */
function closeSubstitution(lexing: Lexing): void {
  endCommand(lexing);
  const open = lexing.subs.pop();
  if (open !== undefined) {
    Object.assign(lexing, open.outer, { word: `${open.outer.word ?? ""}()` });
  }
}

function lexParenthesis(lexing: Lexing, piece: string): void {
  if (piece === "(") {
    lexing.depth += 1;
    if (lexing.word?.endsWith("$") === true) {
      openSubstitution(lexing);
    } else {
      endCommand(lexing);
    }
    return;
  }
  if (lexing.subs.at(-1)?.depth === lexing.depth) {
    closeSubstitution(lexing);
  } else {
    endCommand(lexing);
  }
  lexing.depth = Math.max(0, lexing.depth - 1);
}

function lexPiece(lexing: Lexing, piece: string): void {
  const kind = pieceKind(piece);
  if (kind === "separator") {
    if (piece === "(" || piece === ")") {
      lexParenthesis(lexing, piece);
    } else {
      endCommand(lexing);
    }
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
    depth: 0,
    subs: [],
  };
  for (const [piece] of cut.matchAll(SHELL_PIECE)) {
    lexPiece(lexing, piece);
  }
  const finished = lexing.commands.length;
  while (lexing.subs.length > 0) {
    closeSubstitution(lexing);
  }
  endCommand(lexing);
  const cutShort = text.length > limit;
  if (cutShort && midBody) {
    [...lexing.commands].reverse().find(({ heredocs }) => heredocs.length > 0)?.heredocs.pop();
  } else if (cutShort && endsInCommand(head)) {
    lexing.commands.splice(finished);
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
