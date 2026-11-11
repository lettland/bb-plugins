import { randomBytes } from "node:crypto";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { writeNewFile } from "./files.js";

/** Names of the files in `dir`; none when it cannot be listed (a missing folder is made by the write). */
function namesIn(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/** True for a real backup of `text`: named `rules-*.txt`, a regular file (not a link, pipe or folder) of the same byte length. */
function couldHold(file: string, name: string, text: string): boolean {
  if (!/^rules-.*\.txt$/.test(name)) return false;
  const info = lstatSync(file);
  return info.isFile() && info.size === Buffer.byteLength(text);
}

/**
 * Keeps a copy of `text`, unchanged, as `rules-<YYYY-MM-DDTHH-MM-SS-mmm>-<4 hex>.txt` in `dir` (mode 0600; a new
 * folder is 0700) and returns its path. A backup in `dir` that already holds exactly this text is returned instead;
 * only entries named `rules-*.txt` that are regular files of the same size are read, and an entry that cannot be
 * read counts as different. Never replaces a file. Throws when no copy could be made.
 */
export function backupRules(
  dir: string,
  text: string,
  now: () => Date = () => new Date(),
  suffix: () => string = () => randomBytes(2).toString("hex"),
): string {
  for (const name of namesIn(dir)) {
    const file = path.join(dir, name);
    try {
      if (couldHold(file, name, text) && readFileSync(file, "utf8") === text) return file;
    } catch {
      // An unreadable entry is not an identical copy.
    }
  }
  const stamp = now().toISOString().slice(0, 23).replace(/[:.]/g, "-");
  const target = path.join(dir, `rules-${stamp}-${suffix()}.txt`);
  if (writeNewFile(target, "rules", text) === "exists") throw new Error(`${target} already exists`);
  return target;
}
