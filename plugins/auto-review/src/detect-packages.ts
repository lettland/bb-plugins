/**
 * Reads a package manager's command line past its global options, which may
 * come before the subcommand: `pnpm --filter web run format`, `yarn workspace
 * web fix`, `npm --prefix web install`.
 */

import type { Word } from "./detect-mentions.js";

/** Global options that take the next word as their value, by package manager. */
const VALUE_OPTIONS: Readonly<Record<string, ReadonlySet<string>>> = {
  npm: new Set(["--prefix", "-w", "--workspace", "--cache", "--registry", "--userconfig", "--loglevel"]),
  pnpm: new Set(["-C", "--dir", "-F", "--filter", "--filter-prod", "--loglevel", "--reporter", "--workspace-concurrency"]),
  yarn: new Set(["--cwd", "--cache-folder", "--include", "--exclude", "-j", "--jobs", "--from"]),
  bun: new Set(["--cwd", "-F", "--filter", "--config", "-c"]),
};

/**
 * The words of a package manager's command from its subcommand on: the global
 * options and their values are skipped, and so are `yarn workspace <name>` and
 * `yarn workspaces foreach`. Words after a bare `--` belong to the script.
 */
export function packageWords(name: string, args: readonly Word[]): string[] {
  const values = VALUE_OPTIONS[name];
  const words: string[] = [];
  for (let at = 0; at < args.length; at += 1) {
    const text = args[at]?.text ??
      // v8 ignore start -- @preserve the loop bound (detect-packages.ts:25) proves args[at] is present, a value skip stays inside it, and the empty fallback cannot run.
      "";
    // v8 ignore stop
    if (text === "--") {
      break;
    }
    if (!text.startsWith("-")) {
      words.push(text);
    } else if (values?.has(text) === true) {
      at += 1;
    }
  }
  if (name === "yarn" && words[0] === "workspace") {
    return words.slice(2);
  }
  return name === "yarn" && words[0] === "workspaces" && words[1] === "foreach" ? words.slice(2) : words;
}
