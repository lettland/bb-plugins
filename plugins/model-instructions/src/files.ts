import { randomBytes } from "node:crypto";
import { linkSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * Writes `content` to `target` without replacing a file that is already there:
 * a private temp file in the same directory, then a hard link. Throws on any
 * failure other than the target existing.
 */
export function writeNewFile(
  target: string,
  tempPrefix: string,
  content: string,
  validate?: (temp: string) => void,
): "wrote" | "exists" {
  const dir = path.dirname(target);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const temp = path.join(dir, `${tempPrefix}-${randomBytes(8).toString("hex")}.tmp`);
  try {
    writeFileSync(temp, content, { flag: "wx", mode: 0o600 });
    validate?.(temp);
    try {
      linkSync(temp, target);
      return "wrote";
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return "exists";
      throw error;
    }
  } finally {
    rmSync(temp, { force: true });
  }
}
