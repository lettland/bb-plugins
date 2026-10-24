/**
 * Cuts comments and heredoc bodies out of shell text before it is split into
 * words, so a body is never read as commands.
 */

/** A heredoc operator and its tag: `<<EOF`, `<<-EOF`, `<<'EOF'`, `<<"EOF"` and `<<\EOF`; a tag may hold `-`, `.` and digits and may start with a digit (`END-X`, `EOF.1`, `1EOF`), and a quoted one may hold blanks (`'END TEXT'`). */
const HEREDOC_TAG = /<<(-?)[ \t]*(?:'([^'\n]+)'|"([^"\n]+)"|\\?(\w[\w.-]*))/uy;

export interface Prepared {
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
  /** The `$(` command substitutions open inside double quotes, each with the parentheses open in it. */
  subs: number[];
}

interface Step {
  /** What the step keeps of the text it read. */
  keep: string;
  /** How much text it read. */
  width: number;
}

function scanQuoted(char: string, following: string, scan: Scan): Step {
  if (scan.quote === '"' && char === "$" && following === "(") {
    // A command substitution inside double quotes holds commands, so a `<<` in it is a heredoc.
    scan.subs.push(0);
    scan.quote = "";
    scan.blank = true;
    return { keep: "$(", width: 2 };
  }
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

/** A parenthesis inside a `$(` that was opened in double quotes: the closing one returns to the quotes. */
function scanSubstitutionParen(char: string, scan: Scan): Step {
  const open = scan.subs.length - 1;
  scan.blank = true;
  if (char === "(") {
    scan.subs[open] += 1;
  } else if (scan.subs[open] === 0) {
    scan.subs.pop();
    scan.quote = '"';
    scan.blank = false;
  } else {
    scan.subs[open] -= 1;
  }
  return { keep: char, width: 1 };
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
  // v8 ignore next -- @preserve the tag alternative that matched always fills one of the three tag groups.
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
  if ((char === "(" || char === ")") && scan.subs.length > 0) {
    return scanSubstitutionParen(char, scan);
  }
  scan.blank = /[\s;|&()<>]/u.test(char);
  return { keep: char, width: 1 };
}

/**
 * Cuts comments and heredoc bodies out of the text, leaving a marker word where
 * a heredoc operator was. A `<<` or `#` inside quotes is plain text, unless the
 * `<<` is in a `$(` command substitution, where it is a heredoc even inside
 * double quotes.
 */
export function prepare(text: string): Prepared {
  const prepared: Prepared = { text: "", bodies: [], comments: [], unterminated: false, midBody: false };
  const scan: Scan = { quote: "", blank: true, pending: [], subs: [] };
  let at = 0;
  while (at < text.length) {
    const { keep, width } = scanStep(text, at, scan, prepared);
    prepared.text += keep;
    at += width;
  }
  prepared.unterminated = prepared.midBody || scan.pending.length > 0;
  return prepared;
}
