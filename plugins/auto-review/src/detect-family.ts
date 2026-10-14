/**
 * Whether the family's shell text and tool arguments name a path. This is the
 * generous side of the sibling check: it errs towards saying a path was named,
 * because a wrong "named" only keeps a file with this thread. It still judges
 * each simple command on its own, so a read-only command or an unrelated
 * `sort -u` in the same pipeline does not turn a directory into a write.
 */

import { commandOf, gitCommand, globMatcher, isGlob, lexCommands, MAX_GLOB_LENGTH } from "./detect-mentions.js";
import type { Command, Word } from "./detect-mentions.js";

/** Only this much of a family text is read; a longer one is taken to name every path. */
const FAMILY_TEXT_LIMIT = 65_536;
const FAMILY_TOKEN = /[^\s'"`;|&<>(){}=,:\\]+/gu;
const FIXER_FLAGS: ReadonlySet<string> = new Set(["--fix", "--write", "-w", "-u", "--update-snapshot"]);
const READERS: ReadonlySet<string> = new Set([
  "grep", "rg", "sort", "uniq", "head", "tail", "cat", "less", "wc", "ls", "awk", "cut", "tr", "diff", "jq",
]);
const READING_GIT: ReadonlySet<string> = new Set(["log", "show", "diff", "status", "grep", "blame"]);
/** Git that rewrites the whole tree whatever its arguments. */
const REWRITING_GIT: ReadonlySet<string> = new Set(["merge", "pull", "rebase", "cherry-pick", "revert", "am", "switch"]);
/** Git that changes only the paths it names. */
const PATH_WRITING_GIT: ReadonlySet<string> = new Set(["rm", "mv"]);
const PACKAGE_MANAGERS: ReadonlySet<string> = new Set(["npm", "pnpm", "yarn", "bun"]);
const PACKAGE_CHANGES: ReadonlySet<string> = new Set([
  "install", "i", "add", "remove", "rm", "update", "up", "upgrade", "uninstall",
]);

interface Parsed {
  name: string;
  args: Word[];
}

function isReader({ name, args }: Parsed): boolean {
  if (name === "find") {
    return !args.some(({ text }) => text === "-delete" || text === "-exec");
  }
  if (name === "git") {
    return READING_GIT.has(gitCommand(args)?.sub ?? "");
  }
  return READERS.has(name);
}

/** Whether `git <sub> <rest>` rewrites the working tree wholesale; one that names its paths, or only the index, does not. */
function gitRewritesTree(sub: string, rest: readonly Word[]): boolean {
  const flags = rest.map(({ text }) => text);
  switch (sub) {
    case "stash":
      return !["list", "show"].includes(flags.find((flag) => !flag.startsWith("-")) ?? "");
    case "checkout":
      return !flags.includes("--");
    case "apply":
      return !flags.includes("--cached") || flags.includes("--index");
    case "reset":
      return flags.some((flag) => ["--hard", "--merge", "--keep"].includes(flag));
    default:
      return REWRITING_GIT.has(sub);
  }
}

/** Whether a command rewrites the tree or changes dependencies, which names every path. */
function rewritesTree({ name, args }: Parsed): boolean {
  if (name === "git") {
    const git = gitCommand(args);
    return git !== null && gitRewritesTree(git.sub, git.rest);
  }
  return (
    PACKAGE_MANAGERS.has(name) && PACKAGE_CHANGES.has(args.find(({ text }) => !text.startsWith("-"))?.text ?? "")
  );
}

/**
 * Whether a command writes files, so the directories and basename globs it
 * names count. It does with a write target, or a fixer flag unless it is a
 * known reader; `rm` does only when recursive.
 */
function writesFiles(parsed: Parsed | null, hasTarget: boolean): boolean {
  if (parsed?.name === "rm") {
    return parsed.args.some(({ text }) => /^-[A-Za-z]*[rR]|^--recursive$/u.test(text));
  }
  if (hasTarget) {
    return true;
  }
  if (parsed === null) {
    return false;
  }
  if (parsed.name === "git" && PATH_WRITING_GIT.has(gitCommand(parsed.args)?.sub ?? "")) {
    return true;
  }
  return !isReader(parsed) && parsed.args.some(({ text }) => FIXER_FLAGS.has(text));
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

function addCommand(index: FamilyIndex, command: Command, root: string, targetsOf: (command: Command) => string[]): void {
  const parsed = commandOf(command.words);
  if (parsed !== null && rewritesTree(parsed)) {
    index.all = true;
    return;
  }
  const writing = writesFiles(parsed, targetsOf(command).length > 0);
  const words = [...command.words, ...command.redirects, ...command.inputs];
  for (const { text } of words) {
    text.match(FAMILY_TOKEN)?.forEach((token) => addToken(index, token, writing, root));
  }
  // A heredoc body, a script or a document, can name files but is not itself a write.
  for (const body of command.heredocs) {
    body.match(FAMILY_TOKEN)?.forEach((token) => addToken(index, token, false, root));
  }
}

function indexFamily(texts: readonly string[], root: string, targetsOf: (command: Command) => string[]): FamilyIndex {
  const index: FamilyIndex = { all: false, exact: new Set(), absolute: new Set(), dirs: new Set(), globs: new Set() };
  for (const text of texts) {
    if (text.length > FAMILY_TEXT_LIMIT) {
      index.all = true;
    }
    for (const command of index.all ? [] : lexCommands(text, FAMILY_TEXT_LIMIT)) {
      addCommand(index, command, root, targetsOf);
    }
    if (index.all) {
      break;
    }
  }
  return index;
}

/**
 * Whether the family names a path. A token names it when it equals it, is a
 * `/`-bounded suffix of it (relative to a cwd or a `cd`), is an absolute path
 * ending in `/<path>`, or is a glob that matches it. A glob counts only with a
 * literal in its last segment and either a `/` or a writing command. In a
 * command that writes, a directory prefixing the path names it too. A text over
 * 65,536 characters, git that rewrites the tree and a dependency change name
 * every path. `targetsOf` gives the write targets of a command.
 */
export function familyMatcher(
  texts: readonly string[],
  root: string,
  targetsOf: (command: Command) => string[],
): (path: string) => boolean {
  const index = indexFamily(texts, root, targetsOf);
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
