/**
 * Looks through the words that run another command (`env`, `timeout`, `npx`,
 * `uv run`, …) to the command they run. The family side reads commands this
 * way, so `timeout 300 npm install` is judged as `npm install`.
 */

import { commandStart } from "./detect-mentions.js";
import type { Word } from "./detect-mentions.js";

export interface Parsed {
  /** The command word as written. */
  word: string;
  /** Its base name. */
  name: string;
  args: Word[];
  /** A wrapper stood in front of it. */
  wrapped: boolean;
}

interface Wrapper {
  /** Options that take the next word as their value. */
  values: ReadonlySet<string>;
  /** Words between the options and the wrapped command: `timeout`'s duration. */
  operands: number;
  /** For a tool that wraps through a subcommand (`pnpm exec`): those subcommands. */
  subs: readonly string[];
}

const wrapper = (values: string[] = [], operands = 0, subs: string[] = []): Wrapper => ({
  values: new Set(values),
  operands,
  subs,
});

const WRAPPERS: ReadonlyMap<string, Wrapper> = new Map([
  ["env", wrapper(["-u", "-C", "-S", "--unset", "--chdir", "--split-string"])],
  ["timeout", wrapper(["-s", "-k", "--signal", "--kill-after"], 1)],
  ["nohup", wrapper()],
  ["nice", wrapper(["-n", "--adjustment"])],
  ["exec", wrapper(["-a"])],
  ["command", wrapper()],
  ["sudo", wrapper(["-u", "-g", "-h", "-p", "-C", "-r", "-t", "-U", "-D", "-R"])],
  ["time", wrapper(["-f", "-o", "--format", "--output"])],
  ["stdbuf", wrapper(["-i", "-o", "-e"])],
  ["npx", wrapper(["-p", "--package"])],
  ["bunx", wrapper()],
  ["uvx", wrapper(["--from", "--with", "-w", "-p", "--python", "--directory", "--project", "--env-file"])],
  ["cross-env", wrapper()],
  ["pnpm", wrapper(["-C", "--dir", "-F", "--filter"], 0, ["exec", "dlx"])],
  ["yarn", wrapper(["-p", "--package"], 0, ["dlx"])],
  ["uv", wrapper(["--with", "-w", "-p", "--python", "--directory", "--project", "--package", "--extra", "--env-file", "--group"], 0, ["run"])],
  ["poetry", wrapper(["--directory", "-C"], 0, ["run"])],
  ["pipenv", wrapper([], 0, ["run"])],
  ["bundle", wrapper([], 0, ["exec"])],
  ["deno", wrapper(["--config", "-c", "--import-map", "--lock"], 0, ["run"])],
]);
const MAX_WRAPPERS = 8;
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/u;

const baseName = (word: string) => word.replace(/^.*\//u, "");

/** Where the first word that is not an option (or, for `env`, an assignment) is. */
function skipOptions(args: readonly Word[], values: ReadonlySet<string>, from: number, assignments: boolean): number {
  let at = from;
  while (at < args.length) {
    const text = args[at]?.text ?? "";
    if (text === "--") {
      return at + 1;
    }
    if (!text.startsWith("-") && !(assignments && ASSIGNMENT.test(text))) {
      break;
    }
    at += values.has(text) ? 2 : 1;
  }
  return at;
}

/** The words a wrapper runs, past its own options; null when the command is not a wrapper. */
function wrapped(name: string, args: readonly Word[]): readonly Word[] | null {
  const found = WRAPPERS.get(name);
  if (found === undefined) {
    return null;
  }
  const at = skipOptions(args, found.values, 0, name === "env" || name === "cross-env");
  if (found.subs.length === 0) {
    return args.slice(at + found.operands);
  }
  return found.subs.includes(args[at]?.text ?? "") ? args.slice(skipOptions(args, found.values, at + 1, false)) : null;
}

/**
 * The command a simple command runs once its wrappers are looked through, and
 * the words from its command word on; null for a command of assignments alone.
 */
export function unwrap(words: readonly Word[]): { parsed: Parsed; words: Word[] } | null {
  let inner = words.slice(commandStart(words, false));
  let through = false;
  for (let depth = 0; depth < MAX_WRAPPERS && inner.length > 0; depth += 1) {
    const rest = wrapped(baseName(inner[0]?.text ?? ""), inner.slice(1));
    const next = rest?.slice(commandStart(rest, false)) ?? [];
    if (next.length === 0) {
      break;
    }
    inner = next;
    through = true;
  }
  const head = inner[0];
  return head === undefined
    ? null
    : { words: inner, parsed: { word: head.text, name: baseName(head.text), args: inner.slice(1), wrapped: through } };
}
