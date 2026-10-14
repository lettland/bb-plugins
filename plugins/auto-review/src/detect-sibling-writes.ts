import { familyMatcher } from "./detect-family.js";
import {
  commandOf,
  gitCommand,
  globMatcher,
  globQualifies,
  isGlob,
  lexCommands,
} from "./detect-mentions.js";
import type { Command, Word } from "./detect-mentions.js";

/** Only this much of a sibling's shell text is read, so the cost stays linear in what a row carries. */
const SIBLING_TEXT_LIMIT = 8_192;
const DIRECTORY_CHANGERS: ReadonlySet<string> = new Set(["cd", "pushd", "popd"]);
const INTERPRETER = /^(?:python[\d.]*|node|ruby|perl)$/u;
/** A script body that writes a file: Python's `open(…, 'w')`, `.write(`, `write_text`, Node's `writeFile`. */
const SCRIPT_WRITE =
  /\bopen\s*\([^\n]{0,200}?['"][wax][bt+]*['"]|\.write\(|\bwrite_text\b|\bwriteFile(?:Sync)?\b/u;
const SCRIPT_TOKEN = /[\w@.+\-/*?]+/gu;

/** A target the sibling side cannot resolve or that is scratch space: variables, expansions, `~`, `/dev` and `/tmp`. */
function usable(token: string): boolean {
  return token !== "" && !/[$`{}]/u.test(token) && !/^(?:~|\/dev\/|\/tmp\/)/u.test(token);
}

const plain = (args: readonly Word[]) => args.filter(({ text }) => !text.startsWith("-")).map(({ text }) => text);

/** The files `sed -i` or `perl -i` edits: the plain arguments left once the script is set aside. */
function inPlaceTargets(name: string, args: readonly Word[]): string[] {
  if (!args.some(({ text }) => /^-(?:[A-Za-z]*i|-in-place)/u.test(text))) {
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

/** Every path-like token in an interpreter body that writes a file. */
function scriptTokens(args: readonly Word[], heredocs: readonly string[]): string[] {
  const flag = args.findIndex(({ text }) => /^-[A-Za-z]*[ce]$/u.test(text));
  const inline = flag >= 0 ? [args[flag + 1]?.text ?? ""] : [];
  return [...heredocs, ...inline]
    .filter((body) => SCRIPT_WRITE.test(body))
    .flatMap((body) => body.match(SCRIPT_TOKEN) ?? []);
}

function gitTargets(args: readonly Word[]): string[] {
  const git = gitCommand(args);
  if (git?.sub === "checkout") {
    const dashes = git.rest.findIndex(({ text }) => text === "--");
    return dashes < 0 ? [] : git.rest.slice(dashes + 1).map(({ text }) => text);
  }
  if (git?.sub === "restore") {
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
function commandTargets({ words, redirects, heredocs }: Command): string[] {
  const command = commandOf(words);
  return [
    ...redirects.map(({ text }) => text),
    ...(command === null ? [] : argumentTargets(command.name, command.args, heredocs)),
  ].filter(usable);
}

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

/** A token as a path relative to the checkout, resolved against the row's cwd; null outside the checkout. */
function repoPath(token: string, cwd: string | null, root: string): string | null {
  const base = cwd === null ? root : cwd.startsWith("/") ? cwd : `${root}/${cwd}`;
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

/** The candidates a sibling's shell texts write to, with the first sibling that did. */
function writtenCandidates(
  candidates: readonly string[],
  siblingTexts: readonly SiblingText[],
  root: string,
): Map<string, string> {
  const wanted = new Set(candidates);
  const written = new Map<string, string>();
  for (const { threadId, text, cwd } of siblingTexts) {
    for (const token of writeTargets(text)) {
      const path = repoPath(token, cwd, root);
      for (const candidate of path === null ? [] : namedCandidates(path, candidates, wanted)) {
        if (!written.has(candidate)) {
          written.set(candidate, threadId);
        }
      }
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
  familyTexts: readonly string[],
  root: string,
): Map<string, string> {
  const base = root.replace(/\/+$/u, "");
  const written = writtenCandidates(candidates, siblingTexts, base);
  if (written.size > 0) {
    const named = familyMatcher(familyTexts, base, commandTargets);
    for (const path of [...written.keys()].filter(named)) {
      written.delete(path);
    }
  }
  return written;
}
