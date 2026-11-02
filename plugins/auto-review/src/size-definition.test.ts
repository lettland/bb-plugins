import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { TRIVIAL_CHANGE } from "./size-definition.js";

/** The raw captured string literal of `TRIVIAL_CHANGE` in a file's source, or null when the file names none. */
function rawLiteral(source: string): string | null {
  return source.match(/export const TRIVIAL_CHANGE =\s*"((?:[^"\\]|\\.)*)";/)?.[1] ?? null;
}

describe("TRIVIAL_CHANGE sync with the typesafe plugin", () => {
  it("is a byte-identical copy of the original in plugins/typesafe/src/size.ts", () => {
    const local = rawLiteral(readFileSync(fileURLToPath(new URL("./size-definition.ts", import.meta.url)), "utf8"));
    const original = rawLiteral(
      readFileSync(fileURLToPath(new URL("../../typesafe/src/size.ts", import.meta.url)), "utf8"),
    );
    expect(local).not.toBeNull();
    expect(original).not.toBeNull();
    expect(original).toBe(local);
    expect(JSON.parse(`"${original}"`)).toBe(TRIVIAL_CHANGE);
  });
});
