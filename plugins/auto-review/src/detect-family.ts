/**
 * Whether the family's shell text and tool arguments name a path. This is the
 * generous side of the sibling check: it errs towards saying a path was named,
 * because a wrong "named" only keeps a file with this thread. It still judges
 * each simple command on its own, so a read-only command or an unrelated
 * `sort -u` in the same pipeline does not turn a directory into a write.
 */

import { globMatcher, isGlob, MAX_GLOB_LENGTH } from "./detect-globs.js";
import { lexText } from "./detect-mentions.js";
import type { Command } from "./detect-mentions.js";
import { rewritesTree, shellScript, writesFiles } from "./detect-rewriters.js";
import { unwrap } from "./detect-wrappers.js";

/** Only this much of a family text is read; a longer one is taken to name every path. */
const FAMILY_TEXT_LIMIT = 65_536;
const FAMILY_TOKEN = /[^\s'"`;|&<>(){}=,:\\]+/gu;
/** How deep a shell's `-c` string inside another is read. */
const MAX_SHELL_DEPTH = 8;
/** The longest quoted word with blanks that is also taken whole as a path. */
const MAX_QUOTED_PATH = 512;

/** What the family side asks of the sibling side's write reader. */
export interface CommandWrites {
  /** The paths a command writes to outside scratch space (`/tmp`, `/dev`, `~`), resolvable or not. */
  targets: (command: Command) => string[];
  /** Whether a write target is built from a variable, a command substitution or a backtick. */
  unresolved: (command: Command) => boolean;
}

/** A token without the leading `./` and `../` of a relative path, and without a trailing `/`. */
function bare(token: string): string {
  let rest = token === "." || token === ".." ? "" : token;
  while (rest.startsWith("./") || rest.startsWith("../")) {
    rest = rest.slice(rest.startsWith("./") ? 2 : 3);
  }
  return rest.replace(/\/+$/u, "");
}

function suffixesOf(segments: readonly string[]): string[] {
  return segments.map((_segment, at) => segments.slice(at).join("/"));
}

/** A glob names files only with a literal in its last segment, and a `/` or a writing command around it. */
function globCounts(glob: string, writing: boolean): boolean {
  return /[^*?.]/u.test(glob.slice(glob.lastIndexOf("/") + 1)) && (glob.includes("/") || writing);
}

/**
 * The directory before the first `*` or `{` of a word, for a brace word or a
 * glob that names no file by itself (`dir/*`, `src/{a,b}.ts`); null otherwise.
 */
function patternDirectory(text: string): string | null {
  const at = text.search(/[*{]/u);
  if (at < 0 || (!text.includes("{") && globCounts(text, true))) {
    return null;
  }
  const directory = text.slice(0, text.slice(0, at).lastIndexOf("/") + 1);
  return directory === "" ? null : directory;
}

interface FamilyIndex {
  /** Something the family ran names every path. */
  all: boolean;
  exact: Set<string>;
  /** The `/`-suffixes of the absolute paths it named. */
  absolute: Set<string>;
  /** Directories named in a command that writes. */
  dirs: Set<string>;
  globs: Set<string>;
}

function addToken(index: FamilyIndex, raw: string, writing: boolean, root: string): void {
  let token = raw;
  if (token.startsWith("/")) {
    if (!isGlob(token)) {
      suffixesOf(token.split("/").slice(1)).forEach((suffix) => index.absolute.add(suffix));
    }
    if (!token.startsWith(`${root}/`)) {
      return;
    }
    token = token.slice(root.length + 1);
    index.all ||= writing && token === "";
  }
  const rest = bare(token);
  if (rest === "") {
    index.all ||= writing && /^\.{1,2}\/?$/u.test(token);
  } else if (!isGlob(rest)) {
    index.exact.add(rest);
    if (writing) {
      index.dirs.add(rest);
    }
  } else if (globCounts(rest, writing)) {
    // A glob too long to match is taken to name everything.
    index.all ||= rest.length > MAX_GLOB_LENGTH;
    index.globs.add(rest);
  }
}

function addTokens(index: FamilyIndex, text: string, writing: boolean, root: string): void {
  text.match(FAMILY_TOKEN)?.forEach((token) => addToken(index, token, writing, root));
}

function addCommand(
  index: FamilyIndex,
  command: Command,
  inner: ReturnType<typeof unwrap>,
  root: string,
  writes: CommandWrites,
): void {
  if (inner !== null && rewritesTree(inner.parsed)) {
    index.all = true;
    return;
  }
  const own = inner === null ? command : { ...command, words: inner.words };
  if (writes.unresolved(own)) {
    index.all = true;
    return;
  }
  const writing = writesFiles(inner?.parsed ?? null, writes.targets(own).length > 0);
  for (const { text, quoted } of [...command.words, ...command.redirects, ...command.inputs]) {
    addTokens(index, text, writing, root);
    // A quoted word with a blank is a whole path too, such as "dir/my file.ts".
    if (quoted && /[ \t]/u.test(text) && !text.includes("\n") && text.length <= MAX_QUOTED_PATH) {
      addToken(index, text, writing, root);
    }
    const directory = writing ? patternDirectory(text) : null;
    if (directory !== null) {
      addToken(index, directory, true, root);
    }
  }
  // A heredoc body, a script or a document, can name files but is not itself a write.
  command.heredocs.forEach((body) => addTokens(index, body, false, root));
}

/** Reads a text, and the strings a shell runs with `-c` inside it. */
function addText(index: FamilyIndex, text: string, root: string, writes: CommandWrites, depth: number): void {
  const lexed = lexText(text, FAMILY_TEXT_LIMIT);
  // A heredoc with no terminator line may run on into anything.
  index.all ||= lexed.unterminated;
  lexed.comments.forEach((comment) => addTokens(index, comment, false, root));
  for (const command of lexed.commands) {
    if (index.all) {
      return;
    }
    const inner = unwrap(command.words);
    addCommand(index, command, inner, root, writes);
    const script = inner === null || depth >= MAX_SHELL_DEPTH ? null : shellScript(inner.parsed);
    if (script !== null) {
      addText(index, script, root, writes, depth + 1);
    }
  }
}

function indexFamily(texts: readonly string[], root: string, writes: CommandWrites): FamilyIndex {
  const index: FamilyIndex = { all: false, exact: new Set(), absolute: new Set(), dirs: new Set(), globs: new Set() };
  for (const text of texts) {
    index.all ||= text.length > FAMILY_TEXT_LIMIT;
    if (index.all) {
      break;
    }
    addText(index, text, root, writes, 0);
  }
  return index;
}

/**
 * Whether the family names a path. A token names it when it equals it, is a
 * `/`-bounded suffix of it (relative to a cwd or a `cd`), is an absolute path
 * ending in `/<path>`, or is a glob that matches it. A glob counts only with a
 * literal in its last segment and either a `/` or a writing command. In a
 * command that writes, a directory prefixing the path names it too, and so does
 * the directory before a `*` or `{` of one of its words. A text over 65,536
 * characters, a heredoc with no terminator, a write target built from a
 * variable and a command that rewrites files without naming them (see
 * `rewritesTree`) name every path. `writes` reads the write targets of a command.
 */
export function familyMatcher(
  texts: readonly string[],
  root: string,
  writes: CommandWrites,
): (path: string) => boolean {
  const index = indexFamily(texts, root, writes);
  if (index.all) {
    return () => true;
  }
  const globMatchers = [...index.globs].map(globMatcher);
  const namesDirectory = (segments: readonly string[], from: number) =>
    segments.slice(from + 1).some((_segment, at) => index.dirs.has(segments.slice(from, from + 1 + at).join("/")));
  return (path) => {
    const segments = path.split("/");
    return (
      index.absolute.has(path) ||
      segments.some((_segment, from) => {
        const suffix = segments.slice(from).join("/");
        return index.exact.has(suffix) || globMatchers.some((matches) => matches(suffix)) || namesDirectory(segments, from);
      })
    );
  };
}
