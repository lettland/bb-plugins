/**
 * Reads the inline programs of `sed`, `awk` and `perl -i` for what they can
 * write beyond the files they are given. Each answer errs towards "writes": a
 * wrong one only sweeps the turn. Nothing here uses a regex that can backtrack
 * badly: the programs are walked a character at a time.
 */

import type { Word } from "./detect-mentions.js";

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

/** Whether an awk command only reads: its program has no redirect, pipe or `system`, and no program file or `-i` include is given. */
export function awkReadsOnly(args: readonly Word[]): boolean {
  for (let at = 0; at < args.length; at += 1) {
    const text = args[at]?.text ?? "";
    if (text === "-f" || text === "-i" || text.startsWith("--file") || text.startsWith("--include") || text.startsWith("--source")) {
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
const PERL_WRITERS = ["system", "exec", "open", "unlink", "rename", "qx", "`", "fork", "require", "eval", "do "];

/** Whether the `-e` code of a `perl -i` command stays within the files it edits. */
export function perlCodeIsPure(args: readonly Word[]): boolean {
  return args.every(({ text }, at) => {
    const code = /^-[A-Za-z]*[eE]$/u.test(args[at - 1]?.text ?? "") ? text : "";
    return !PERL_WRITERS.some((writer) => code.includes(writer));
  });
}
