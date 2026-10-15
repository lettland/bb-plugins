/**
 * Classifies the shell text the thread's family ran by what it writes: nothing
 * (inert), files it names (targeted), or files it cannot list (opaque). The
 * lists are closed on purpose, apart from the shared lexer: a command that is
 * not on one is opaque, which only sweeps the turn.
 */

import { awkReadsOnly, perlCodeIsPure, sedScriptIsPure, sedScripts } from "./detect-claim-scripts.js";
import { commandStart, gitCommand, lexText } from "./detect-mentions.js";
import type { Command, Word } from "./detect-mentions.js";
import { hasFixerFlag, PACKAGE_MANAGERS, positional, rewritesTree, shellScript } from "./detect-rewriters.js";
import { DIRECTORY_CHANGERS, gitTargets, inPlaceTargets, PERL_IN_PLACE, plain, SED_IN_PLACE } from "./detect-sibling-writes.js";
import { packageWords } from "./detect-packages.js";
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
}

/** What one command writes by name, and the directory changes the text made before it. */
export interface NamedWrite {
  tokens: string[];
  steps: DirectoryStep[];
}

/** What a shell text writes. */
export interface TextClaims {
  writes: NamedWrite[];
  /** The program (its basename, never an argument) of the first command whose writes cannot be listed; undefined when there is none. */
  opaque: string | undefined;
  /** The text runs git that writes history. */
  history: boolean;
}

type Verdict = { kind: "inert" } | { kind: "opaque" } | { kind: "write"; tokens: string[] };

const INERT: Verdict = { kind: "inert" };
const OPAQUE: Verdict = { kind: "opaque" };

/** A command that writes the files it names; one that names none writes files nobody can list. */
const writes = (tokens: readonly string[]): Verdict => (tokens.length === 0 ? OPAQUE : { kind: "write", tokens: [...tokens] });

/** Builtins and shell syntax words that write nothing; the commands inside a loop or a condition are read on their own. */
const INERT_WORDS: ReadonlySet<string> = new Set([
  "echo", "printf", "pwd", "true", "false", "test", "[", "[[", "sleep", "which", "type", "export", "set", "date",
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
const GH_READS: ReadonlySet<string> = new Set(["view", "list", "diff", "checks"]);
const GH_TOPICS: ReadonlySet<string> = new Set(["pr", "issue", "run"]);
const BB_READS: Readonly<Record<string, ReadonlySet<string>>> = {
  thread: new Set(["show", "log", "output", "wait", "list", "tell"]),
  "auto-review": new Set(["status", "show"]),
};
const BB_TOP_LEVEL: ReadonlySet<string> = new Set(["status", "guide"]);
const RIPWIRE_READS: ReadonlySet<string> = new Set([
  "for", "grep", "expand", "callers", "impact", "uses", "exemplar", "pack-task", "plan-lanes", "from-trace", "quality-delta",
]);
/** Options that shape what a ripwire read prints. */
const RIPWIRE_SHAPES: ReadonlySet<string> = new Set(["task", "json", "top-k", "max-tokens", "token-budget", "pack-top-n", "format"]);
const CHECK_SCRIPTS: ReadonlySet<string> = new Set(["test", "t", "tst", "lint", "typecheck", "type-check", "tsc"]);
const FIND_WRITING: ReadonlySet<string> = new Set(["-exec", "-execdir", "-ok", "-okdir", "-delete", "-fls"]);

/** Where a write is not the checkout's: `/tmp`, `/dev` and the macOS temporary directories, or `$TMPDIR`. */
function isScratch(token: string): boolean {
  return (
    /^(?:\/private)?\/(?:tmp|var\/folders)(?:\/|$)/u.test(token) ||
    token.startsWith("/dev/") ||
    /^\$(?:TMPDIR|\{TMPDIR\})(?:\/|$)/u.test(token)
  );
}

/** A write target no one can resolve: built from a variable, a substitution or a brace, or the home directory. */
const isUnresolved = (token: string) => /[$`{}]|^~/u.test(token);

function flagsOf(args: readonly Word[]): string[] {
  return args.map(({ text }) => text);
}

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

/** A test, lint or typecheck run that is given no flag that makes it rewrite files. */
function isCheckRun(parsed: Parsed): boolean {
  const { name, args } = parsed;
  if (hasFixerFlag(parsed)) {
    return false;
  }
  const first = positional(args)[0];
  switch (name) {
    case "vitest":
    case "jest":
    case "pytest":
    case "py.test":
    case "eslint":
    case "mypy":
    case "pyright":
      return true;
    case "tsc":
      return flagsOf(args).some((flag) => flag.toLowerCase() === "--noemit");
    case "go":
      return first === "test" || first === "vet";
    case "cargo":
      return first === "test" || first === "check" || first === "clippy" || first === "nextest";
    default:
      return PACKAGE_MANAGERS.has(name) && isPackageCheck(name, args);
  }
}

/** `npm test`, `pnpm lint`, `yarn run typecheck`, `npm run test:unit`: a package script that tests, lints or typechecks. */
function isPackageCheck(name: string, args: readonly Word[]): boolean {
  const words = packageWords(name, args);
  const script = words[0] === "run" || words[0] === "run-script" ? words[1] : words[0];
  return script !== undefined && CHECK_SCRIPTS.has(script.split(":")[0] ?? "");
}

function ripwireVerdict({ args }: Parsed): Verdict {
  const flags = flagsOf(args).filter((flag) => flag.startsWith("-"));
  const named = flags.map((flag) => flag.replace(/^--/u, "").split("=")[0] ?? "");
  const reads = flags.some((flag, at) => flag.startsWith("--") && RIPWIRE_READS.has(named[at] ?? ""));
  const known = flags.every((flag, at) => flag.startsWith("--") && (RIPWIRE_READS.has(named[at] ?? "") || RIPWIRE_SHAPES.has(named[at] ?? "")));
  return reads && known ? INERT : OPAQUE;
}

function ghVerdict({ args }: Parsed): Verdict {
  const [topic, action] = positional(args);
  return GH_TOPICS.has(topic ?? "") && GH_READS.has(action ?? "") ? INERT : OPAQUE;
}

function bbVerdict({ args }: Parsed): Verdict {
  const [topic, action] = positional(args);
  const reads = BB_READS[topic ?? ""];
  return BB_TOP_LEVEL.has(topic ?? "") || (reads !== undefined && reads.has(action ?? "")) ? INERT : OPAQUE;
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

/** `git`: reads, index and history changes are inert; `rm`, `mv`, `checkout --` and `restore` write the paths they name; the rest is opaque. */
function gitVerdict({ args }: Parsed): Verdict {
  const git = gitCommand(args);
  if (git === null) {
    return OPAQUE;
  }
  const { sub, rest, relocated } = git;
  if (sub === "rm" || sub === "mv" || sub === "checkout" || sub === "restore") {
    return relocated ? OPAQUE : writes(sub === "rm" || sub === "mv" ? plain(rest) : gitTargets(args));
  }
  return gitLeavesTree(sub, flagsOf(rest)) ? INERT : OPAQUE;
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

/** The files `cp`, `install` and `mv` write when they name them: a directory destination, which hides the file names, is opaque. */
function copyTokens(name: string, args: readonly Word[]): string[] {
  const files = plain(args);
  if (name === "mv" || (name === "install" && flagsOf(args).includes("-d"))) {
    return files;
  }
  const toDirectory = flagsOf(args).some((flag) => /^-[A-Za-z]*t|^--target-directory/u.test(flag));
  const last = files.at(-1) ?? "";
  return toDirectory || files.length !== 2 || last.endsWith("/") ? [] : [last];
}

function writerVerdict({ name, args }: Parsed): Verdict {
  return writes(name === "cp" || name === "install" || name === "mv" ? copyTokens(name, args) : plain(args));
}

/** `sed` and `perl`: in place they write the files they edit; otherwise `sed` only reads, if its script writes nothing, and `perl` runs code. */
function inPlaceVerdict({ name, args }: Parsed): Verdict {
  const inPlace = args.some(({ text }) => (name === "sed" ? SED_IN_PLACE : PERL_IN_PLACE).test(text));
  if (name === "perl") {
    return writes(inPlace && perlCodeIsPure(args) ? inPlaceTargets(name, args) : []);
  }
  const scripts = sedScripts(args);
  if (scripts === null || !scripts.every((script) => sedScriptIsPure(script, inPlace))) {
    return OPAQUE;
  }
  return inPlace ? writes(inPlaceTargets(name, args)) : INERT;
}

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
    case "gh":
      return ghVerdict(parsed);
    case "bb":
      return bbVerdict(parsed);
    case "ripwire":
      return ripwireVerdict(parsed);
    default:
      return isCheckRun(parsed) ? INERT : OPAQUE;
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

/** Records the write targets of a command; a target built from a variable or a substitution makes the command opaque, and scratch space is skipped. */
function addWrite(reading: Reading, tokens: readonly string[], program: string): void {
  const checkout = tokens.filter((token) => !isScratch(token));
  if (checkout.some(isUnresolved)) {
    markOpaque(reading, program);
  } else if (checkout.length > 0) {
    reading.claims.writes.push({ tokens: checkout, steps: [...reading.steps] });
  }
}

/** `command -v name` and `command -V name`, which look a command up and run nothing. */
function isLookup(words: readonly Word[]): boolean {
  const head = words.slice(commandStart(words, false));
  return head[0]?.text === "command" && /^-[vV]$/u.test(head[1]?.text ?? "");
}

/** A word that runs a command inside it: a backtick or a `$(` the lexer left in a quoted word. */
const runsSubstitution = ({ text }: Word) => text.includes("`") || text.includes("$(");

function readCommand(command: Command, reading: Reading, depth: number): void {
  const redirects = command.redirects.map(({ text }) => text);
  const inner = unwrap(command.words);
  if ([...command.words, ...command.redirects].some(runsSubstitution)) {
    markOpaque(reading, inner?.parsed.name ?? "(substitution)");
    return;
  }
  if (inner === null) {
    addWrite(reading, redirects, "(redirect)");
    return;
  }
  const { parsed } = inner;
  if (writesHistory(parsed)) {
    reading.claims.history = true;
  }
  if (DIRECTORY_CHANGERS.has(parsed.name)) {
    reading.steps.push({ name: parsed.name, target: plain(parsed.args)[0] });
    addWrite(reading, redirects, parsed.name);
    return;
  }
  const rewrites = rewritesTree(parsed);
  const script = rewrites ? null : shellScript(parsed);
  if (script !== null && depth < MAX_SHELL_DEPTH) {
    readText(script, reading, depth + 1);
    addWrite(reading, redirects, parsed.name);
    return;
  }
  const verdict = isLookup(command.words) ? INERT : rewrites || script !== null ? OPAQUE : classify(parsed);
  if (verdict.kind === "opaque") {
    markOpaque(reading, parsed.name);
  } else {
    addWrite(reading, [...redirects, ...(verdict.kind === "write" ? verdict.tokens : [])], parsed.name);
  }
}

function readText(text: string, reading: Reading, depth: number): void {
  if (text.length > CLAIM_TEXT_LIMIT) {
    markOpaque(reading, "(text over the limit)");
    return;
  }
  const lexed = lexText(text, CLAIM_TEXT_LIMIT);
  if (lexed.unterminated) {
    markOpaque(reading, "(unterminated heredoc)");
  }
  for (const command of lexed.commands) {
    readCommand(command, reading, depth);
  }
}

/**
 * What a shell text writes: the files its targeted commands name (redirects,
 * `tee`, `sed -i`, `perl -i`, `cp` and `install` to a file, `mv`, `rm`,
 * `touch`, `mkdir`, `git rm`, `git mv`, `git checkout --`, `git restore`), and
 * the program of the first command whose writes cannot be listed. Commands
 * inside `bash -c`, `eval`, subshells and `$( )` are read too, and so are the
 * wrappers in front of a command.
 */
export function classifyText(text: string): TextClaims {
  const reading: Reading = { claims: { writes: [], opaque: undefined, history: false }, steps: [] };
  readText(text, reading, 0);
  return reading.claims;
}
