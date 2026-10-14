/**
 * What an interpreter script writes. A script that writes files names the
 * paths it writes by a literal, or builds them; only the first can be read
 * exactly, so the second keeps every path-like word the script mentions.
 */

import type { Word } from "./detect-mentions.js";

/** A script body that writes a file: Python's `open(…, 'w')`, `.write(`, `write_text`, Node's `writeFile`. */
const SCRIPT_WRITE =
  /\bopen\s*\([^\n]{0,200}?['"][wax][bt+]*['"]|\.write\(|\bwrite_text\b|\bwriteFile(?:Sync)?\b/u;
const SCRIPT_TOKEN = /[\w@.+\-/*?]+/gu;
/** `open(<first argument>, …'w')`: group 2 is the first argument when it is a string literal on its own. */
const OPEN_WRITE = /\bopen\s*\(\s*(?:(['"])([^'"\n]{1,200})\1|[^,)\n]{0,200})\s*,[^\n]{0,200}?['"][wax][bt+]*['"]/gu;
const WRITE_FILE = /\bwriteFile(?:Sync)?\s*\(\s*(?:(['"`])([^'"`$\n]{1,200})\1(?=\s*[,)])|[^,)\n]{0,200})/gu;
const WRITE_TEXT = /\bwrite_text\b/gu;
const LITERAL_WRITE_TEXT = /\bPath\s*\(\s*(['"])([^'"\n]{1,200})\1\s*\)\s*\.write_text\b/gu;

/**
 * The paths a script body writes when every write call in it (`open` for
 * writing, `writeFile*`, `write_text`) names its path as a string literal; null
 * when one builds its path, or the body has no such call.
 */
export function literalWriteTargets(body: string): string[] | null {
  const calls = [...body.matchAll(OPEN_WRITE), ...body.matchAll(WRITE_FILE)];
  const total = calls.length + [...body.matchAll(WRITE_TEXT)].length;
  const literals = [...calls, ...body.matchAll(LITERAL_WRITE_TEXT)].flatMap((call) => (call[2] === undefined ? [] : [call[2]]));
  return total > 0 && literals.length === total ? literals : null;
}

/**
 * The path-like words in an interpreter body that writes a file: the literal
 * targets when they are all there is, else every word the script mentions.
 */
export function scriptTokens(args: readonly Word[], heredocs: readonly string[]): string[] {
  const flag = args.findIndex(({ text }) => /^-[A-Za-z]*[ce]$/u.test(text));
  const inline = flag >= 0 ? [args[flag + 1]?.text ?? ""] : [];
  return [...heredocs, ...inline]
    .filter((body) => SCRIPT_WRITE.test(body))
    .flatMap((body) => literalWriteTargets(body) ?? body.match(SCRIPT_TOKEN) ?? []);
}
