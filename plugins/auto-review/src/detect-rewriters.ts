/**
 * Which commands rewrite files without naming them, which the family side
 * takes to name every path, and which write the files they name. It errs
 * towards "rewrites": a wrong answer only keeps a file with the reviewing thread.
 */

import { gitCommand } from "./detect-mentions.js";
import type { Word } from "./detect-mentions.js";
import type { Parsed } from "./detect-wrappers.js";

export const FIXER_FLAGS: ReadonlySet<string> = new Set([
  "--fix", "--write", "-w", "-u", "--update", "--update-snapshot", "--updateSnapshot",
]);
const READERS: ReadonlySet<string> = new Set([
  "grep", "rg", "sort", "uniq", "head", "tail", "cat", "less", "wc", "ls", "awk", "cut", "tr", "diff", "jq",
]);
const READING_GIT: ReadonlySet<string> = new Set(["log", "show", "diff", "status", "grep", "blame"]);
/** Git that rewrites the whole tree whatever its arguments. */
const REWRITING_GIT: ReadonlySet<string> = new Set([
  "merge", "pull", "rebase", "cherry-pick", "revert", "am", "switch", "clean",
]);
/** Git that changes only the paths it names. */
const PATH_WRITING_GIT: ReadonlySet<string> = new Set(["rm", "mv"]);
const PACKAGE_MANAGERS: ReadonlySet<string> = new Set(["npm", "pnpm", "yarn", "bun"]);
const PACKAGE_CHANGES: ReadonlySet<string> = new Set([
  "install", "i", "add", "remove", "rm", "update", "up", "upgrade", "uninstall",
]);
/** Commands that run other commands over a list, or sync and unpack files in bulk. */
const BULK_TOOLS: ReadonlySet<string> = new Set(["xargs", "parallel", "patch", "rsync", "unzip", "jscodeshift"]);
const FIND_WRITING: ReadonlySet<string> = new Set(["-exec", "-execdir", "-ok", "-okdir", "-delete"]);
const FD_WRITING: ReadonlySet<string> = new Set(["-x", "-X", "--exec", "--exec-batch"]);

/**
 * Scripts and make targets that rewrite files without naming them. A bare
 * `lint` is left out: it reads, and `lint:fix` or `lint-fix` still match `fix`.
 */
const REWRITING_SCRIPT = /fix|format|fmt|codemod|generate|gen|update|sync|prettier/iu;
/** Programs that run the script file they are given. */
const SCRIPT_RUNNER = /^(?:python[\d.]*|node|ruby|perl|bash|sh|zsh|tsx|ts-node|bun|deno|php|lua|Rscript)$/u;
const SHELL = /^(?:bash|sh|zsh)$/u;
/** A script file by its name: a relative path, or a name with a script extension. */
const SCRIPT_WORD = /^[\w.@-]+(?:\/[\w.@-]+)+$|\.(?:[cm]?[jt]sx?|py|rb|pl|php|sh|bash|zsh|lua)$/u;

export const positional = (args: readonly Word[]) => args.filter(({ text }) => !text.startsWith("-")).map(({ text }) => text);

/** A path as an argument: it has a `/`, is `.` or `..`, or is a file name with an extension. */
export function isPathLike(text: string): boolean {
  return text.includes("/") || /^\.{1,2}$/u.test(text) || /^[\w@-][\w.@-]*\.[A-Za-z0-9]+$/u.test(text);
}

const pathArgs = (args: readonly Word[]) => positional(args).filter(isPathLike);

/** No path arguments, or `.`: the command works on the whole tree. */
function wholeTree(args: readonly Word[]): boolean {
  const paths = pathArgs(args);
  return paths.length === 0 || paths.some((path) => path === "." || path === "./");
}

export function isReader({ name, args }: Parsed): boolean {
  if (name === "find") {
    return true; // with -delete or -exec it is an indirect writer, caught before
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

/** A fixer flag with no path to apply it to, outside a reader and git: it fixes the whole tree. */
function fixesTree(parsed: Parsed): boolean {
  return (
    parsed.name !== "git" &&
    !isReader(parsed) &&
    parsed.args.some(({ text }) => FIXER_FLAGS.has(text)) &&
    pathArgs(parsed.args).length === 0
  );
}

/** A formatter run on the whole tree: no path argument, or `.`. */
function formatsTree({ name, args }: Parsed): boolean {
  const first = positional(args)[0];
  switch (name) {
    case "go":
    case "cargo":
      return first === "fmt";
    case "gofmt":
      return args.some(({ text }) => text === "-w") && wholeTree(args);
    case "black":
    case "isort":
      return wholeTree(args);
    case "ruff":
      return (first === "format" || (first === "check" && args.some(({ text }) => text === "--fix"))) && wholeTree(args);
    default:
      return false;
  }
}

/** A package script or make target that rewrites files, or `make` with no target. */
function runsRewritingScript({ name, args }: Parsed): boolean {
  if (name === "make") {
    const targets: string[] = [];
    for (let at = 0; at < args.length; at += 1) {
      const text = args[at]?.text ?? "";
      if (text === "-C" || text === "-f") {
        at += 1;
      } else if (!text.startsWith("-") && !text.includes("=")) {
        targets.push(text);
      }
    }
    return targets.length === 0 || targets.some((target) => REWRITING_SCRIPT.test(target));
  }
  if (!PACKAGE_MANAGERS.has(name)) {
    return false;
  }
  const words = positional(args);
  const script = words[0] === "run" ? words[1] : name === "pnpm" || name === "yarn" ? words[0] : undefined;
  return script !== undefined && REWRITING_SCRIPT.test(script);
}

/** The string a `sh -c`, `bash -lc` or `zsh -c` runs; null for any other command. */
export function shellScript({ name, args }: Parsed): string | null {
  const flag = SHELL.test(name) ? args.findIndex(({ text }) => /^-[A-Za-z]*c$/u.test(text)) : -1;
  return flag < 0 ? null : (args[flag + 1]?.text ?? null);
}

/** A script file, which can do anything: a program given a file, a script named through a wrapper, or a relative path run directly. */
function runsScriptFile({ word, name, args, wrapped }: Parsed): boolean {
  if (/^[\w.@-]+(?:\/[\w.@-]+)+$/u.test(word) || (wrapped && SCRIPT_WORD.test(word))) {
    return true;
  }
  if (!SCRIPT_RUNNER.test(name) || args.some(({ text }) => /^-[A-Za-z]*[ce]$/u.test(text))) {
    return false;
  }
  const file = positional(args)[0];
  return file !== undefined && isPathLike(file);
}

/** `tar` that unpacks: `x` in its mode (`xf`, `-xzf`) or `--extract`. */
function extractsArchive(args: readonly Word[]): boolean {
  return args.some(({ text }, at) =>
    text === "--extract" || text === "--get" || (at === 0 ? /^-?[A-Za-z]*x[A-Za-z]*$/u : /^-[A-Za-z]*x[A-Za-z]*$/u).test(text),
  );
}

/** A command that runs others over a list or writes files in bulk: `xargs`, `find -exec`, `fd -x`, `rsync`, `tar x`, … */
function writesInBulk(parsed: Parsed): boolean {
  const flags = parsed.args.map(({ text }) => text);
  switch (parsed.name) {
    case "find":
      return flags.some((flag) => FIND_WRITING.has(flag));
    case "fd":
    case "fdfind":
      return flags.some((flag) => FD_WRITING.has(flag) || flag.startsWith("--exec"));
    case "tar":
      return extractsArchive(parsed.args);
    case "go":
      return positional(parsed.args)[0] === "generate";
    default:
      return BULK_TOOLS.has(parsed.name);
  }
}

/**
 * Whether a command rewrites files without naming them, which names every
 * path: git that rewrites the tree, a dependency change, a fixer or formatter
 * with no path, a script that likely rewrites, a script file, or a command that
 * runs others or writes files in bulk.
 */
export function rewritesTree(parsed: Parsed): boolean {
  if (parsed.name === "git") {
    const git = gitCommand(parsed.args);
    return git !== null && gitRewritesTree(git.sub, git.rest);
  }
  const changesPackages =
    PACKAGE_MANAGERS.has(parsed.name) && PACKAGE_CHANGES.has(positional(parsed.args)[0] ?? "");
  return (
    changesPackages ||
    writesInBulk(parsed) ||
    fixesTree(parsed) ||
    formatsTree(parsed) ||
    runsRewritingScript(parsed) ||
    runsScriptFile(parsed)
  );
}

/**
 * Whether a command writes files, so the directories and basename globs it
 * names count. It does with a write target, or a fixer flag unless it is a
 * known reader; `rm` does only when recursive.
 */
export function writesFiles(parsed: Parsed | null, hasTarget: boolean): boolean {
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
