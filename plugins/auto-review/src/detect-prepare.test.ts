import { describe, expect, it } from "vitest";
import { prepare } from "./detect-prepare.js";

describe("prepare", () => {
  it("cuts comments and keeps heredoc bodies behind markers", () => {
    const prepared = prepare("npm ci # install\ncat <<EOF\nbody\nEOF\necho done");
    expect(prepared.comments).toEqual([" install"]);
    expect(prepared.text).not.toContain("install");
    expect(prepared.text).toContain("\u00010\u0001");
    expect(prepared.bodies).toEqual(["body"]);
    expect(prepared.text).toContain("echo done");
    expect(prepared.unterminated).toBe(false);
  });

  it("reads commands inside a double-quoted command substitution, nesting parentheses", () => {
    const prepared = prepare('echo "one $( (echo a) && echo b ) two"');
    expect(prepared.text).toBe('echo "one $( (echo a) && echo b ) two"');
    expect(prepared.comments).toEqual([]);
    const preparedHeredoc = prepare('x="$(cat <<EOF\nin quotes\nEOF\n)"');
    expect(preparedHeredoc.bodies).toEqual(["in quotes"]);
  });

  it("leaves a heredoc operator with no tag as plain text", () => {
    const prepared = prepare("cat <<\necho next");
    expect(prepared.bodies).toEqual([]);
    expect(prepared.text).toContain("<<");
    expect(prepared.text).toContain("echo next");
    expect(prepared.unterminated).toBe(false);
  });

  it("a body that never ends marks the text unterminated", () => {
    const prepared = prepare("cat <<EOF\nno end");
    expect(prepared.bodies).toEqual(["no end"]);
    expect(prepared.unterminated).toBe(true);
    expect(prepared.midBody).toBe(true);
  });
});

describe("prepare: an escaped quote inside double quotes", () => {
  it("keeps the escaped quote in the word", () => {
    const prepared = prepare('"a\\"b"');
    expect(prepared.text).toBe('"a\\"b"');
    expect(prepared.comments).toEqual([]);
  });
});
