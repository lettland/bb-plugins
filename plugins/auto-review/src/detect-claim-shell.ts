/**
 * Classifies the shell text the thread's family ran by what it writes: nothing
 * (inert), files it names (targeted), or files it cannot list (opaque). The
 * lists are closed on purpose, apart from the shared lexer: a command that is
 * not on one is opaque, which only sweeps the turn.
 */

import {
  awkReadsOnly, bbReads, flagsOf, ghReads, inPlaceSuffix, isCheckRun, perlCodeIsPure, ripwireReads, sedScriptIsPure, sedScripts,
} from "./detect-claim-scripts.js";
import { commandStart, gitCommand, lexText } from "./detect-mentions.js";
import type { Command, Word } from "./detect-mentions.js";
import { PACKAGE_MANAGERS, positional, rewritesTree, shellScript } from "./detect-rewriters.js";
import { DIRECTORY_CHANGERS, gitTargets, inPlaceTargets, PERL_IN_PLACE, plain, SED_IN_PLACE } from "./detect-sibling-writes.js";
import { unwrap } from "./detect-wrappers.js";
import type { Parsed } from "./detect-wrappers.js";

/** A text longer than this is not read; it is taken to write anything. */
const CLAIM_TEXT_LIMIT = 65_536;
/** How deep a shell's `-c` string inside another is read. */
const MAX_SHELL_DEPTH = 8;

/** A directory change a text made, in order. */
export interface DirectoryStep {
  name: string;
  /** Where it went, as written; undefined for a bare `cd`. */
  target: string | undefined;
  /** It moved the shell itself, not a subshell or a `-c` string, so the shell's next command starts there. */
  lasting: boolean;
}

/** The paths a command writes, as it names them. */
interface Names {
  /** Each is claimed as the path itself: what the command names, and where a directory destination puts each source (`<dest>/<basename>`). */
  tokens: string[];
  /** The tokens that are claimed with everything beneath them: what `rm` removes, a `mv` source, a `git checkout --` path. */
  trees: string[];
  /** A move: unless every tree is a changed file itself, what it moved is a directory and its files are at the destination, so every token is a tree. */
  moves: boolean;
}

/** What one command writes by name, and the directory changes the text made before it. */
export interface NamedWrite extends Names {
  steps: DirectoryStep[];
}

/** What a shell text writes. */
export interface TextClaims {
  writes: NamedWrite[];
  /** What it writes to scratch space (`/tmp`, `/dev`, `$TMPDIR`), which is not the checkout unless the checkout lies there. */
  scratch: NamedWrite[];
  /** The program (its basename, never an argument) of the first command whose writes cannot be listed; undefined when there is none. */
  opaque: string | undefined;
  /** The text runs git that writes history. */
  history: boolean;
  /** The directory changes that moved the shell itself, which the next command row starts after. */
  left: DirectoryStep[];
}

type Verdict = { kind: "inert" } | { kind: "opaque" } | ({ kind: "write" } & Names);

const INERT: Verdict = { kind: "inert" };
const OPAQUE: Verdict = { kind: "opaque" };

/** A command that writes the files it names; one that names none writes files nobody can list. */
const writes = (tokens: readonly string[], trees: readonly string[] = [], moves = false): Verdict =>
  tokens.length === 0 ? OPAQUE : { kind: "write", tokens: [...tokens], trees: [...trees], moves };

/** A path without its trailing slashes. */
function trimSlashes(token: string): string {
  let end = token.length;
  while (end > 0 && token[end - 1] === "/") {
    end -= 1;
  }
  return token.slice(0, end);
}

/** The last segment of a path, or undefined when it has none (`.`, `..`, `/`). */
function baseName(token: string): string | undefined {
  const name = trimSlashes(token).split("/").pop();
  return name === undefined || name === "" || name === "." || name === ".." ? undefined : name;
}

/** Builtins and shell syntax words that write nothing; the commands inside a loop or a condition are read on their own. */
const INERT_WORDS: ReadonlySet<string> = new Set([
  "echo", "printf", "pwd", "true", "false", "test", "[", "[[", "sleep", "which", "type", "export", "set", "date", "read",
  "for", "case", "select", "in", "fi", "done", "esac", "}",
]);
const READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
  "cat", "head", "tail", "less", "wc", "ls", "grep", "rg", "cut", "tr", "sort", "uniq", "diff", "jq",
]);
const READING_GIT: ReadonlySet<string> = new Set(["log", "show", "diff", "status", "grep", "blame", "rev-parse", "ls-files", "fetch"]);
/** Git that changes the index, the history or a remote, never a file of the working tree (when it does not match `rewritesTree`). */
const INDEX_GIT: ReadonlySet<string> = new Set(["add", "commit", "push", "tag", "reset"]);
const HISTORY_GIT: ReadonlySet<string> = new Set([
  "commit", "merge", "revert", "pull", "rebase", "cherry-pick", "am", "filter-branch", "reset",
]);
const BRANCH_READS: ReadonlySet<string> = new Set(["--show-current", "-a", "-v", "-vv", "-r", "--list"]);
const CONFIG_READS: ReadonlySet<string> = new Set(["--get", "--get-all", "--get-regexp", "--list", "-l"]);
const WRITERS: ReadonlySet<string> = new Set(["tee", "rm", "rmdir", "touch", "mkdir", "mv", "cp", "install"]);
const FIND_WRITING: ReadonlySet<string> = new Set(["-exec", "-execdir", "-ok", "-okdir", "-delete", "-fls"]);

/** Where a write is not the checkout's: `/tmp`, `/dev` and the macOS temporary directories, or `$TMPDIR`. */
export function isScratch(token: string): boolean {
  return (
    /^(?:\/private)?\/(?:tmp|var\/folders)(?:\/|$)/u.test(token) ||
    token.startsWith("/dev/") ||
    /^\$(?:TMPDIR|\{TMPDIR\})(?:\/|$)/u.test(token)
  );
}

/** A write target no one can resolve: built from a variable, a substitution or a brace, or the home directory. */
export const isUnresolved = (token: string) => /[$`{}]|^~/u.test(token);

/** A tool that only reads, unless a flag makes it write a file or a second file operand names one. */
function readsOnly({ name, args }: Parsed): boolean {
  const flags = flagsOf(args);
  switch (name) {
    case "sort":
      return !flags.some((flag) => /^-[A-Za-z]*o|^--output/u.test(flag));
    case "uniq":
      return plain(args).length < 2;
    case "rg":
      return !flags.some((flag) => flag.startsWith("--pre"));
    default:
      return true;
  }
}

/** Whether `git <sub> <flags>` only reads, or changes the index, the history or a remote. */
function gitLeavesTree(sub: string, flags: readonly string[]): boolean {
  const first = flags.find((flag) => !flag.startsWith("-"));
  switch (sub) {
    case "branch":
      return flags.every((flag) => BRANCH_READS.has(flag));
    case "config":
      return flags.some((flag) => CONFIG_READS.has(flag));
    case "stash":
      return first === "list" || first === "show";
    case "remote":
      return flags.every((flag) => flag === "-v" || flag === "--verbose");
    default:
      return READING_GIT.has(sub) ? !flags.some((flag) => flag.startsWith("--output")) : INDEX_GIT.has(sub);
  }
}

/** `git`: reads, index and history changes are inert; `rm` (not `--cached`), `mv`, `checkout --` and `restore` write the paths they name; the rest is opaque. */
function gitVerdict({ args }: Parsed): Verdict {
  const git = gitCommand(args);
  if (git === null) {
    return OPAQUE;
  }
  const { sub, rest, relocated } = git;
  if (sub === "rm" || sub === "mv" || sub === "checkout" || sub === "restore") {
    return relocated ? OPAQUE : gitWrites(sub, rest, args);
  }
  return gitLeavesTree(sub, flagsOf(rest)) ? INERT : OPAQUE;
}

function gitWrites(sub: string, rest: readonly Word[], args: readonly Word[]): Verdict {
  if (sub === "mv") {
    return movedVerdict(plain(rest), flagsOf(rest));
  }
  const paths = sub === "rm" ? plain(rest) : gitTargets(args);
  return sub === "rm" && flagsOf(rest).includes("--cached") ? INERT : writes(paths, paths);
}

/** Whether a command is git that writes history: commit, merge, revert, pull, rebase, cherry-pick, am, filter-branch, reset, or stash pop or apply. */
function writesHistory({ name, args }: Parsed): boolean {
  const git = name === "git" ? gitCommand(args) : null;
  if (git === null) {
    return false;
  }
  const action = positional(git.rest)[0];
  return HISTORY_GIT.has(git.sub) || (git.sub === "stash" && (action === "pop" || action === "apply"));
}

/** `-t dir` and `--target-directory` name the destination first, which the plain arguments cannot tell apart. */
const targetsDirectory = (flags: readonly string[]) => flags.some((flag) => /^-[A-Za-z]*t|^--target-directory/u.test(flag));

/** The destination of a copy or move, and where it puts each source if it is a directory: `<dest>/<basename>`. Null when the arguments do not say. */
function destinationOf(files: readonly string[], flags: readonly string[]): { dest: string; into: string[]; sources: string[] } | null {
  const dest = trimSlashes(files.at(-1) ?? "");
  if (targetsDirectory(flags) || files.length < 2 || dest === "") {
    return null;
  }
  const sources = files.slice(0, -1);
  return { dest, sources, into: sources.flatMap((source) => baseName(source) ?? []).map((name) => `${dest}/${name}`) };
}

/** `mv`: each source is gone, with what is beneath it, and the destination holds it, as itself or as a directory of its sources. */
function movedVerdict(files: readonly string[], flags: readonly string[]): Verdict {
  const to = destinationOf(files, flags);
  return to === null ? OPAQUE : writes([...to.sources, to.dest, ...to.into], to.sources, true);
}

/** `cp` and `install`: the destination and, if it is a directory, each source inside it; with `-r` all of it, with what is beneath. `install -d` makes the directories it names. */
function copiedVerdict(name: string, args: readonly Word[]): Verdict {
  const files = plain(args);
  const flags = flagsOf(args);
  if (name === "install" && flags.includes("-d")) {
    return writes(files);
  }
  const to = destinationOf(files, flags);
  if (to === null) {
    return OPAQUE;
  }
  const tokens = [to.dest, ...to.into];
  return writes(tokens, flags.some((flag) => /^-[A-Za-z]*[rRa]|^--(?:recursive|archive)$/u.test(flag)) ? tokens : []);
}

/** `rm` and `rmdir` remove what they name and what is beneath it; `mv`, `cp` and `install` as above; `tee`, `touch` and `mkdir` write exactly the paths they name. */
function writerVerdict({ name, args }: Parsed): Verdict {
  switch (name) {
    case "rm":
    case "rmdir":
      return writes(plain(args), plain(args));
    case "mv":
      return movedVerdict(plain(args), flagsOf(args));
    case "cp":
    case "install":
      return copiedVerdict(name, args);
    default:
      return writes(plain(args));
  }
}

/** The files an in-place edit writes, and with a backup suffix (`-i.bak`) the backup of each. */
const withBackups = (files: readonly string[], suffix: string): string[] => [...files, ...(suffix === "" ? [] : files.map((file) => `${file}${suffix}`))];

/** `sed` and `perl`: in place they write the files they edit; otherwise `sed` only reads, if its script writes nothing, and `perl` runs code. */
function inPlaceVerdict({ name, args }: Parsed): Verdict {
  const inPlace = args.some(({ text }) => (name === "sed" ? SED_IN_PLACE : PERL_IN_PLACE).test(text));
  if (name === "perl") {
    return writes(inPlace && perlCodeIsPure(args) ? withBackups(inPlaceTargets(name, args), inPlaceSuffix(name, args)) : []);
  }
  const scripts = sedScripts(args);
  if (scripts === null || !scripts.every((script) => sedScriptIsPure(script, inPlace))) {
    return OPAQUE;
  }
  return inPlace ? writes(withBackups(inPlaceTargets(name, args), inPlaceSuffix(name, args))) : INERT;
}

/** The programs that are inert only in a read mode, and what says whether a run is one. */
const READ_MODES: Readonly<Record<string, (parsed: Parsed) => boolean>> = { gh: ghReads, bb: bbReads, ripwire: ripwireReads };

function classify(parsed: Parsed): Verdict {
  const { name, args } = parsed;
  if (INERT_WORDS.has(name)) {
    return INERT;
  }
  if (READ_ONLY_TOOLS.has(name)) {
    return readsOnly(parsed) ? INERT : OPAQUE;
  }
  if (WRITERS.has(name)) {
    return writerVerdict(parsed);
  }
  switch (name) {
    case "sed":
    case "perl":
      return inPlaceVerdict(parsed);
    case "awk":
      return awkReadsOnly(args) ? INERT : OPAQUE;
    case "find":
      return flagsOf(args).some((flag) => FIND_WRITING.has(flag) || flag.startsWith("-fprint")) ? OPAQUE : INERT;
    case "git":
      return gitVerdict(parsed);
    default:
      return (READ_MODES[name] ?? isCheckRun)(parsed) ? INERT : OPAQUE;
  }
}

interface Reading {
  claims: TextClaims;
  /** The directory changes made so far. */
  steps: DirectoryStep[];
}

const markOpaque = (reading: Reading, program: string) => {
  reading.claims.opaque ??= program;
};

const redirected = (redirects: readonly string[]): Names => ({ tokens: [...redirects], trees: [], moves: false });

/** Records the write targets of a command; a target built from a variable or a substitution makes the command opaque, and scratch space is kept apart, since the checkout may lie there. */
function addWrite(reading: Reading, names: Names, program: string): void {
  const checkout = names.tokens.filter((token) => !isScratch(token));
  if (checkout.some(isUnresolved)) {
    markOpaque(reading, program);
    return;
  }
  const part = (tokens: readonly string[]): NamedWrite => ({
    tokens: [...tokens],
    trees: names.trees.filter((tree) => tokens.includes(tree)),
    moves: names.moves,
    steps: [...reading.steps],
  });
  if (checkout.length > 0) {
    reading.claims.writes.push(part(checkout));
  }
  const scratch = names.tokens.filter(isScratch);
  if (scratch.length > 0) {
    reading.claims.scratch.push(part(scratch));
  }
}

/** `command -v name` and `command -V name`, which look a command up and run nothing. */
function isLookup(words: readonly Word[]): boolean {
  const head = words.slice(commandStart(words, false));
  return head[0]?.text === "command" && /^-[vV]$/u.test(head[1]?.text ?? "");
}

/** A process substitution, `<(…)` or `>(…)`: the lexer reads what follows its `)` as a command of its own, so a file argument would be taken for a program and logged as one. */
const PROCESS_SUBSTITUTION = /[<>]\(/u;

/** A word that runs a command inside it: a backtick or a `$(` the lexer left in a quoted word. */
const runsSubstitution = ({ text }: Word) => text.includes("`") || text.includes("$(");

/** Notes a `cd`, `pushd` or `popd`; it moved the shell itself only outside a subshell and a `-c` string. */
function noteDirectoryChange(reading: Reading, { name, args }: Parsed, command: Command, depth: number): void {
  reading.steps.push({ name, target: plain(args)[0], lasting: depth === 0 && command.depth === 0 });
}

function readCommand(command: Command, reading: Reading, depth: number): void {
  const redirects = command.redirects.map(({ text }) => text);
  const inner = unwrap(command.words);
  if ([...command.words, ...command.redirects].some(runsSubstitution)) {
    markOpaque(reading, inner?.parsed.name ?? "(substitution)");
    return;
  }
  if (inner === null) {
    addWrite(reading, redirected(redirects), "(redirect)");
    return;
  }
  const { parsed } = inner;
  if (writesHistory(parsed)) {
    reading.claims.history = true;
  }
  if (DIRECTORY_CHANGERS.has(parsed.name)) {
    noteDirectoryChange(reading, parsed, command, depth);
    addWrite(reading, redirected(redirects), parsed.name);
    return;
  }
  const rewrites = rewritesTree(parsed);
  const script = rewrites ? null : shellScript(parsed);
  if (script !== null && depth < MAX_SHELL_DEPTH) {
    readText(script, reading, depth + 1);
    addWrite(reading, redirected(redirects), parsed.name);
    return;
  }
  const verdict = isLookup(command.words) ? INERT : rewrites || script !== null ? OPAQUE : classify(parsed);
  if (verdict.kind === "opaque") {
    markOpaque(reading, parsed.name);
  } else {
    const names = verdict.kind === "write" ? verdict : redirected([]);
    addWrite(reading, { ...names, tokens: [...redirects, ...names.tokens] }, parsed.name);
  }
}

function readText(text: string, reading: Reading, depth: number): void {
  if (text.length > CLAIM_TEXT_LIMIT) {
    markOpaque(reading, "(text over the limit)");
    return;
  }
  if (PROCESS_SUBSTITUTION.test(text)) {
    markOpaque(reading, "(process substitution)");
  }
  const lexed = lexText(text, CLAIM_TEXT_LIMIT);
  if (lexed.unterminated) {
    markOpaque(reading, "(unterminated heredoc)");
  }
  for (const command of lexed.commands) {
    readCommand(command, reading, depth);
  }
}

/** Programs that run code or other programs, whose first word marks a string as a command that cannot be listed. */
const OPAQUE_PROGRAMS: ReadonlySet<string> = new Set([
  "npx", "pnpx", "bunx", "node", "deno", "tsx", "ts-node", "ruby", "perl", "php", "make", "cmake", "bash", "sh", "zsh", "dash", "ksh",
  "go", "cargo", "gradle", "mvn", "docker", "ripwire",
]);

/**
 * For a string that is not a shell field of a tool's arguments: the program of
 * its command when it starts with one that is opaque by name (a package
 * manager that is not running a check, an interpreter, `make`, a rewriter), and
 * undefined for any other word, so prose and file content do not read as one.
 */
export function opaqueProgram(text: string): string | undefined {
  const first = lexText(text, CLAIM_TEXT_LIMIT).commands[0];
  const parsed = first === undefined ? undefined : unwrap(first.words)?.parsed;
  const word = first?.words[commandStart(first.words)]?.text ?? "";
  // A path (`src/a.ts is broken`) is not a program: only a bare name counts, also as an `npx` wrapper's.
  const named = [word, parsed?.name ?? ""].some(
    (name) => PACKAGE_MANAGERS.has(name) || OPAQUE_PROGRAMS.has(name) || /^python[\d.]*$/u.test(name),
  );
  return named || (parsed !== undefined && !parsed.word.includes("/") && rewritesTree(parsed)) ? classifyText(text).opaque : undefined;
}

/**
 * What a shell text writes: the files its targeted commands name (redirects,
 * `tee`, `sed -i`, `perl -i`, `cp`, `install`, `mv`, `rm`, `rmdir`, `touch`,
 * `mkdir`, `git rm`, `git mv`, `git checkout --`, `git restore`), and
 * the program of the first command whose writes cannot be listed. Commands
 * inside `bash -c`, `eval`, subshells and `$( )` are read too, and so are the
 * wrappers in front of a command.
 */
export function classifyText(text: string): TextClaims {
  const reading: Reading = { claims: { writes: [], scratch: [], opaque: undefined, history: false, left: [] }, steps: [] };
  readText(text, reading, 0);
  return { ...reading.claims, left: reading.steps.filter(({ lasting }) => lasting) };
}
