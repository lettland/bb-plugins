/**
 * Reads the inline programs of `sed`, `awk` and `perl -i` for what they can
 * write beyond the files they are given, the flags and package scripts of a
 * check run for whether it writes files, and which `ripwire`, `gh` and `bb`
 * commands only read. Each answer errs towards "writes": a
 * wrong one only sweeps the turn. Nothing here uses a regex that can backtrack
 * badly: the programs are walked a character at a time.
 */

import type { Word } from "./detect-mentions.js";
import { PERL_IN_PLACE, SED_IN_PLACE } from "./detect-sibling-writes.js";
import { packageWords } from "./detect-packages.js";
import { hasFixerFlag, PACKAGE_MANAGERS, positional } from "./detect-rewriters.js";
import type { Parsed } from "./detect-wrappers.js";

/** The sed commands that only print, delete, hold or branch on the pattern space. */
const SED_PLAIN_COMMANDS = "pPdDnNgGhHxqQl=";
/** Between commands: blanks, separators, braces, negation, address digits and punctuation. */
const SED_BETWEEN = " \t\n;{}!,+~$0123456789";
const SED_SUBSTITUTE_FLAGS = "gpiImM0123456789";

/** Where the part of a script that ends at the next unescaped `delimiter` stops, `count` parts in a row; -1 when unterminated. */
function skipParts(script: string, from: number, delimiter: string, count: number): number {
  let at = from;
  for (let part = 0; part < count; part += 1) {
    while (at < script.length && script[at] !== delimiter) {
      at += script[at] === "\\" ? 2 : 1;
    }
    if (at >= script.length) {
      return -1;
    }
    at += 1;
  }
  return at;
}

/** Past a `s` command's flags; -1 when a flag writes or runs something (`w`, `e`) or is unknown. */
function skipSubstituteFlags(script: string, from: number): number {
  let at = from;
  while (at < script.length && !";\n}".includes(script.charAt(at))) {
    if (!SED_SUBSTITUTE_FLAGS.includes(script.charAt(at)) && script[at] !== " ") {
      return -1;
    }
    at += 1;
  }
  return at;
}

/** Past an address: `/re/` or `\cREc`, and its `I` and `M` flags; -1 when unterminated. */
function skipRegexAddress(script: string, from: number): number {
  const custom = script[from] === "\\";
  const delimiter = custom ? script.charAt(from + 1) : "/";
  const end = skipParts(script, from + (custom ? 2 : 1), delimiter, 1);
  let at = end;
  while (end >= 0 && (script[at] === "I" || script[at] === "M")) {
    at += 1;
  }
  return at;
}

/** Past the text of an `a`, `i` or `c` command, which runs to the end of its line (a trailing backslash continues it). */
function skipText(script: string, from: number): number {
  let at = from;
  while (at < script.length && script[at] !== "\n") {
    at += script[at] === "\\" ? 2 : 1;
  }
  return at;
}

/** Past the command at `at`, or -1 when it can write, run something or is not understood. */
function skipSedCommand(script: string, at: number, text: boolean): number {
  const char = script.charAt(at);
  if (char === "/" || char === "\\") {
    return skipRegexAddress(script, at);
  }
  if (char === "s" || char === "y") {
    const end = skipParts(script, at + 2, script.charAt(at + 1), 2);
    return char === "s" && end >= 0 ? skipSubstituteFlags(script, end) : end;
  }
  if (text && "aic".includes(char)) {
    return skipText(script, at + 1);
  }
  return SED_PLAIN_COMMANDS.includes(char) ? at + 1 : -1;
}

/**
 * Whether a sed script writes nothing but its output: no `w`, `W`, `e`, `r`
 * (`R`), branch, label or comment, and no `w` or `e` flag on `s`. With
 * `text`, the `a`, `i` and `c` commands are allowed as well, for a script that
 * edits its file in place.
 */
export function sedScriptIsPure(script: string, text = false): boolean {
  let at = 0;
  while (at >= 0 && at < script.length) {
    at = SED_BETWEEN.includes(script.charAt(at)) ? at + 1 : skipSedCommand(script, at, text);
  }
  return at >= 0;
}

/** The programs of a `sed` command: its `-e` scripts, else the first plain argument; null when a script file is read. */
export function sedScripts(args: readonly Word[]): string[] | null {
  const scripts: string[] = [];
  const plain: string[] = [];
  for (let at = 0; at < args.length; at += 1) {
    const text = args[at]?.text ?? "";
    if (/^-[A-Za-z]*f$|^--file/u.test(text)) {
      return null;
    }
    if (/^-[A-Za-z]*e$|^--expression$/u.test(text)) {
      scripts.push(args[at + 1]?.text ?? "");
      at += 1;
    } else if (text.startsWith("--expression=")) {
      scripts.push(text.slice("--expression=".length));
    } else if (text !== "" && !text.startsWith("-")) {
      plain.push(text);
    }
  }
  return scripts.length > 0 ? scripts : plain.slice(0, 1);
}

/** What an awk program may contain and still only print to its standard output: no redirect, pipe or `system`. */
const AWK_WRITERS = [">", "|", "system"];
/** Options of awk that take the next word as their value. */
const AWK_VALUE_OPTIONS: ReadonlySet<string> = new Set(["-F", "-v", "--assign", "--field-separator"]);

/** Options that load or run code the program text does not show: `-i` (also attached, `-iinplace`), `-E`, `-f` (also attached) and their long forms. */
const AWK_CODE_OPTION = /^-[ifE]|^--(?:file|include|source|exec)/u;

/** Whether an awk command only reads: its program has no redirect, pipe or `system`, and no program file, include or `-E` exec is given. */
export function awkReadsOnly(args: readonly Word[]): boolean {
  for (let at = 0; at < args.length; at += 1) {
    const text = args[at]?.text ?? "";
    if (AWK_CODE_OPTION.test(text)) {
      return false;
    }
    if (AWK_VALUE_OPTIONS.has(text)) {
      at += 1;
    } else if (!text.startsWith("-")) {
      return !AWK_WRITERS.some((writer) => text.includes(writer));
    }
  }
  return true;
}

/** Perl code that can write or run something beyond the files `-i` edits. */
const PERL_WRITERS = [
  "system", "exec", "open", "unlink", "rename", "mkdir", "rmdir", "truncate", "symlink", "link", "chmod", "qx", "`", "fork",
  "require", "eval", "do ",
];
const PERL_CODE_FLAG = /^-[A-Za-z]*[eE]$/u;

/** Whether a `perl -i` command stays within the files it edits: its code is given inline with `-e` (a script file can do anything), it loads no module (`-M`, `-m`), and the code calls nothing that writes or runs something else. */
export function perlCodeIsPure(args: readonly Word[]): boolean {
  return (
    args.some(({ text }) => PERL_CODE_FLAG.test(text)) &&
    args.every(({ text }, at) => {
      const code = PERL_CODE_FLAG.test(args[at - 1]?.text ?? "") ? text : "";
      return !/^-[Mm]/u.test(text) && !PERL_WRITERS.some((writer) => code.includes(writer));
    })
  );
}

const CHECK_SCRIPTS: ReadonlySet<string> = new Set(["test", "t", "tst", "lint", "typecheck", "type-check"]);
/** Flags that make a check run write files: update and regenerate flags, an output file or a coverage report, a stub. */
const EMIT_FLAG_PREFIXES: readonly string[] = [
  "--update", "--snapshot-update", "--force-regen", "--output", "--junit", "--cov", "--createstub", "-update",
  "-coverprofile", "-cpuprofile", "-memprofile", "-blockprofile", "-mutexprofile", "-trace", "-outputdir", "--basetemp", "--html",
];
/** Runners whose `-o` is not an output file: `jest -o` is only-changed and `pytest -o` an ini override. */
const O_IS_NOT_OUTPUT: ReadonlySet<string> = new Set(["jest", "pytest", "py.test"]);

export function flagsOf(args: readonly Word[]): string[] {
  return args.map(({ text }) => text);
}

/** Whether a flag makes a check run write files: `-o`, an update or output flag, a coverage report, a stub. */
const emitsFiles = (flag: string, program: string) =>
  (/^-o(?:=|$)/u.test(flag) && !O_IS_NOT_OUTPUT.has(program)) || EMIT_FLAG_PREFIXES.some((prefix) => flag.startsWith(prefix));

/** Whether `tsc` is told not to emit: its last `--noEmit` is not `--noEmit false`. */
function noEmits(flags: readonly string[]): boolean {
  let emits = false;
  flags.forEach((flag, at) => {
    const lower = flag.toLowerCase();
    if (lower === "--noemit") {
      emits = flags[at + 1]?.toLowerCase() !== "false";
    } else if (lower.startsWith("--noemit=")) {
      emits = lower !== "--noemit=false";
    }
  });
  return emits;
}

/** The backup suffix of an in-place edit: `-i.bak`, `-pi.bak` (perl: everything after the first `i`), `--in-place=.bak`; empty when it makes none. */
export function inPlaceSuffix(name: string, args: readonly Word[]): string {
  for (const { text } of args) {
    if (name === "sed" && text.startsWith("--in-place=")) {
      return text.slice("--in-place=".length);
    }
    const cluster = (name === "sed" ? SED_IN_PLACE : PERL_IN_PLACE).test(text) && !text.startsWith("--") ? text.indexOf("i") : -1;
    if (cluster > 0 && /^[A-Za-z0-9]*$/u.test(text.slice(1, cluster))) {
      return text.slice(cluster + 1);
    }
  }
  return "";
}

/** A test, lint or typecheck run that is given no flag that makes it rewrite files or write a report. */
export function isCheckRun(parsed: Parsed): boolean {
  const { name, args } = parsed;
  if (hasFixerFlag(parsed) || flagsOf(args).some((flag) => emitsFiles(flag, name))) {
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
      return noEmits(flagsOf(args));
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

/** Whether a `ripwire` run is a read mode, given only read and shape options. */
export function ripwireReads({ args }: Parsed): boolean {
  const flags = flagsOf(args).filter((flag) => flag.startsWith("-"));
  const named = flags.map((flag) => flag.replace(/^--/u, "").split("=")[0] ?? "");
  const reads = flags.some((flag, at) => flag.startsWith("--") && RIPWIRE_READS.has(named[at] ?? ""));
  const known = flags.every((flag, at) => flag.startsWith("--") && (RIPWIRE_READS.has(named[at] ?? "") || RIPWIRE_SHAPES.has(named[at] ?? "")));
  return reads && known;
}

/** Whether a `gh` command only views or lists. */
export function ghReads({ args }: Parsed): boolean {
  const [topic, action] = positional(args);
  return GH_TOPICS.has(topic ?? "") && GH_READS.has(action ?? "");
}

/** Whether a `bb` command only shows or lists. */
export function bbReads({ args }: Parsed): boolean {
  const [topic, action] = positional(args);
  const reads = BB_READS[topic ?? ""];
  return BB_TOP_LEVEL.has(topic ?? "") || (reads !== undefined && reads.has(action ?? ""));
}
