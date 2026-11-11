import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
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

/**
 * Keeps a copy of `text`, unchanged, as `rules-<YYYY-MM-DDTHH-MM-SS-mmm>-<4 hex>.txt` in `dir` (mode 0600; a new
 * folder is 0700) and returns its path. A file in `dir` that already holds exactly this text is returned instead;
 * a file that cannot be read counts as different. Never replaces a file. Throws when no copy could be made.
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
      if (readFileSync(file, "utf8") === text) return file;
    } catch {
      // An unreadable entry is not an identical copy.
    }
  }
  const stamp = now().toISOString().slice(0, 23).replace(/[:.]/g, "-");
  const target = path.join(dir, `rules-${stamp}-${suffix()}.txt`);
  if (writeNewFile(target, "rules", text) === "exists") throw new Error(`${target} already exists`);
  return target;
}
