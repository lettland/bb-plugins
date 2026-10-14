import { familyMatcher } from "./detect-family.js";
import type { FamilyText } from "./detect-family.js";
import { globMatcher, globQualifies, isGlob } from "./detect-globs.js";
import { commandOf, commandStart, gitCommand, lexCommands } from "./detect-mentions.js";
import type { Command, Word } from "./detect-mentions.js";
import { scriptTokens } from "./detect-script-writes.js";

/** Only this much of a sibling's shell text is read, so the cost stays linear in what a row carries. */
const SIBLING_TEXT_LIMIT = 8_192;
const DIRECTORY_CHANGERS: ReadonlySet<string> = new Set(["cd", "pushd", "popd"]);
const INTERPRETER = /^(?:python[\d.]*|node|ruby|perl)$/u;
/** `sed -i` and `--in-place`; for perl a short-flag cluster with `i` (`-pi`, `-i.bak`, `-0pi`) that does not start with `-M`, `-m`, `-I` or `-x`. */
const SED_IN_PLACE = /^-(?:[A-Za-z]*i|-in-place)/u;
const PERL_IN_PLACE = /^-(?![MmIx-])[A-Za-z0-9]*i/u;
/** An assignment that points git at another repository or index, so its paths no longer resolve against the shell's. */
const GIT_LOCATION = /^GIT_(?:DIR|WORK_TREE|INDEX_FILE)=/u;

/** A target that is not scratch space: `~`, `/dev` and `/tmp`. */
const checkoutBound = (token: string) => token !== "" && !/^(?:~|\/dev\/|\/tmp\/)/u.test(token);

/** A target the sibling side can resolve: no variables, expansions or braces. */
const usable = (token: string) => checkoutBound(token) && !/[$`{}]/u.test(token);

const plain = (args: readonly Word[]) => args.filter(({ text }) => !text.startsWith("-")).map(({ text }) => text);

/** The files `sed -i` or `perl -i` edits: the plain arguments left once the script is set aside. */
function inPlaceTargets(name: string, args: readonly Word[]): string[] {
  if (!args.some(({ text }) => (name === "sed" ? SED_IN_PLACE : PERL_IN_PLACE).test(text))) {
    return [];
  }
  const takesScript = name === "sed" ? /^-[A-Za-z]*[ef]$|^--(?:expression|file)$/u : /^-[A-Za-z]*e$/u;
  const files: string[] = [];
  let scripted = false;
  for (let at = 0; at < args.length; at += 1) {
    const text = args[at]?.text ?? "";
    if (text === "") {
      continue; // BSD sed's empty `-i` suffix
    }
    if (!text.startsWith("-")) {
      files.push(text);
    } else if (takesScript.test(text)) {
      scripted = true;
      at += 1;
    }
  }
  return scripted ? files : files.slice(1);
}

function gitTargets(args: readonly Word[]): string[] {
  const git = gitCommand(args);
  if (git === null || git.relocated) {
    return [];
  }
  if (git.sub === "checkout") {
    const dashes = git.rest.findIndex(({ text }) => text === "--");
    return dashes < 0 ? [] : git.rest.slice(dashes + 1).map(({ text }) => text);
  }
  if (git.sub === "restore") {
    const flags = git.rest.map(({ text }) => text);
    const staged = flags.some((flag) => flag === "--staged" || /^-[A-Za-z]*S[A-Za-z]*$/u.test(flag));
    const worktree = flags.some((flag) => flag === "--worktree" || /^-[A-Za-z]*W[A-Za-z]*$/u.test(flag));
    return staged && !worktree ? [] : plain(git.rest);
  }
  return [];
}

/** What a command's arguments write, by command; `touch` and anything that changes no content name nothing. */
function argumentTargets(name: string, args: readonly Word[], heredocs: readonly string[]): string[] {
  switch (name) {
    case "tee":
    case "rm":
      return plain(args);
    case "cp":
    case "mv":
    case "install": {
      const toDirectory = args.some(({ text }) => /^-[A-Za-z]*t|^--target-directory/u.test(text));
      const files = plain(args);
      return toDirectory || files.length < 2 ? [] : files.slice(-1);
    }
    case "sed":
      return inPlaceTargets(name, args);
    case "git":
      return gitTargets(args);
    default:
      return [
        ...(name === "perl" ? inPlaceTargets(name, args) : []),
        ...(INTERPRETER.test(name) ? scriptTokens(args, heredocs) : []),
      ];
  }
}

/** What one simple command writes to, as it names it: its redirect targets and what its arguments write. */
function rawTargets({ words, redirects, heredocs }: Command): string[] {
  const command = commandOf(words);
  const relocated = command?.name === "git" && words.slice(0, commandStart(words)).some(({ text }) => GIT_LOCATION.test(text));
  return [
    ...redirects.map(({ text }) => text),
    ...(command === null || relocated ? [] : argumentTargets(command.name, command.args, heredocs)),
  ];
}

const commandTargets = (command: Command) => rawTargets(command).filter(usable);
/** What a command writes outside scratch space, whether or not it can be resolved. */
const writtenTargets = (command: Command) => rawTargets(command).filter(checkoutBound);

/** A write target built from a variable, a command substitution or a backtick, which no one can resolve. */
const hasUnresolvedTarget = (command: Command) => rawTargets(command).some((token) => /[$`]/u.test(token));

/**
 * The tokens a shell text writes to, as it names them: redirect targets,
 * `tee`, `cp`/`mv`/`install` destinations, `rm`, `sed -i`, `git checkout --`
 * and `git restore` paths, and the paths an interpreter script that writes a
 * file mentions. A heredoc body is never credited unless an interpreter reads
 * it. Nothing after a `cd`, `pushd` or `popd` counts, since later tokens no
 * longer resolve against the row's cwd.
 */
export function writeTargets(text: string): string[] {
  const targets: string[] = [];
  for (const command of lexCommands(text, SIBLING_TEXT_LIMIT)) {
    const parsed = commandOf(command.words);
    if (parsed !== null && DIRECTORY_CHANGERS.has(parsed.name)) {
      break;
    }
    targets.push(...commandTargets(command));
  }
  return targets;
}

/** Collapses `.` and `..` in an absolute path into its segments. */
function segmentsOf(path: string): string[] {
  const segments: string[] = [];
  for (const segment of path.split("/")) {
    if (segment === "..") {
      segments.pop();
    } else if (segment !== "" && segment !== ".") {
      segments.push(segment);
    }
  }
  return segments;
}

/** A token as a path relative to the checkout, resolved against the shell's directory; null outside the checkout, or relative when that directory is unknown. */
function repoPath(token: string, base: string | null, root: string): string | null {
  if (base === null && !token.startsWith("/")) {
    return null;
  }
  const segments = segmentsOf(token.startsWith("/") ? token : `${base}/${token}`);
  const rootSegments = segmentsOf(root);
  if (!rootSegments.every((segment, at) => segments[at] === segment)) {
    return null;
  }
  const rest = segments.slice(rootSegments.length).join("/");
  return rest === "" ? null : rest;
}

export interface SiblingText {
  threadId: string;
  text: string;
  cwd: string | null;
}

/** The candidates a resolved token writes to: the path itself, or what a qualifying glob matches. */
function namedCandidates(path: string, candidates: readonly string[], wanted: ReadonlySet<string>): string[] {
  if (!isGlob(path)) {
    return wanted.has(path) ? [path] : [];
  }
  return globQualifies(path) ? candidates.filter(globMatcher(path)) : [];
}

/** Where a `cd` or `pushd` to `target` leaves a shell that was at `dir`: the checkout root, or null for anywhere else or anywhere unknown. */
function movedTo(dir: string | null, target: string | undefined, root: string): string | null {
  if (target === undefined || /^[-~]|[$`{}]/u.test(target) || (dir === null && !target.startsWith("/"))) {
    return null;
  }
  const to = `/${segmentsOf(target.startsWith("/") ? target : `${dir}/${target}`).join("/")}`;
  return to === `/${segmentsOf(root).join("/")}` ? root : null;
}

/**
 * Where the shell is after a text, when it changes directory: the checkout
 * root, or null for anywhere else (`cd src`, `cd ..`, `cd -`, `cd` alone, a
 * variable, `popd`), since a relative token no longer resolves there. A `cd`
 * inside a subshell or a command substitution does not move the shell.
 * Undefined when the text changes no directory.
 */
function directoryAfter(text: string, start: string | null, root: string): string | null | undefined {
  let dir = start;
  let changed = false;
  for (const { words, depth } of lexCommands(text, SIBLING_TEXT_LIMIT)) {
    const parsed = commandOf(words);
    if (parsed === null || depth > 0 || !DIRECTORY_CHANGERS.has(parsed.name)) {
      continue;
    }
    changed = true;
    dir = parsed.name === "popd" ? null : movedTo(dir, plain(parsed.args)[0], root);
  }
  return changed ? dir : undefined;
}

/** Where a row's relative tokens resolve: its own cwd, else where the sibling's earlier rows left the shell; null when that is unknown. */
function rowBase(cwd: string | null, left: string | null, root: string): string | null {
  if (cwd === null || cwd === "") {
    return left;
  }
  return cwd.startsWith("/") ? cwd : `${root}/${cwd}`;
}

/** The candidates one text writes to, resolved against `base`. */
function writtenBy(
  text: string,
  base: string | null,
  candidates: readonly string[],
  wanted: ReadonlySet<string>,
  root: string,
): string[] {
  return writeTargets(text).flatMap((token) => {
    const path = repoPath(token, base, root);
    return path === null ? [] : namedCandidates(path, candidates, wanted);
  });
}

/**
 * The candidates a sibling's shell texts write to, with the first sibling that
 * did. An empty or unknown `cwd` is the checkout root until that sibling's
 * earlier rows `cd` somewhere else, and again once one `cd`s to the root by an
 * absolute path; while it is elsewhere only absolute targets resolve.
 */
function writtenCandidates(
  candidates: readonly string[],
  siblingTexts: readonly SiblingText[],
  root: string,
): Map<string, string> {
  const wanted = new Set(candidates);
  const written = new Map<string, string>();
  const shellDirs = new Map<string, string | null>();
  for (const { threadId, text, cwd } of siblingTexts) {
    const left = shellDirs.get(threadId);
    const base = rowBase(cwd, left === undefined ? root : left, root);
    for (const candidate of writtenBy(text, base, candidates, wanted, root)) {
      if (!written.has(candidate)) {
        written.set(candidate, threadId);
      }
    }
    const after = directoryAfter(text, base, root);
    if (after !== undefined) {
      shellDirs.set(threadId, after);
    }
  }
  return written;
}

/**
 * The candidate paths a sibling wrote, with the sibling that wrote each. A
 * candidate counts when a sibling's shell text writes to it by a literal path
 * or a qualifying glob (see `writeTargets`) and the family's texts do not name
 * it in any way. Asymmetric on purpose: strict about what a sibling wrote,
 * generous about what the family might have touched.
 */
export function siblingWrittenPaths(
  candidates: readonly string[],
  siblingTexts: readonly SiblingText[],
  familyTexts: readonly FamilyText[],
  root: string,
): Map<string, string> {
  const base = root.replace(/\/+$/u, "");
  const written = writtenCandidates(candidates, siblingTexts, base);
  if (written.size > 0) {
    const named = familyMatcher(familyTexts, base, { targets: writtenTargets, unresolved: hasUnresolvedTarget });
    for (const path of [...written.keys()].filter(named)) {
      written.delete(path);
    }
  }
  return written;
}
