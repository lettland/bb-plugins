import { describe, expect, it } from "vitest";
import { globMatcher, globQualifies, isGlob, MAX_GLOB_LENGTH } from "./detect-globs.js";

describe("isGlob", () => {
  it("sees a glob in star, question mark and class", () => {
    expect(isGlob("src/*.ts")).toBe(true);
    expect(isGlob("file?.txt")).toBe(true);
    expect(isGlob("[ab].txt")).toBe(true);
    expect(isGlob("plain.txt")).toBe(false);
  });
});

describe("globQualifies", () => {
  it("accepts a rooted glob with a literal last segment", () => {
    expect(globQualifies("src/*.ts")).toBe(true);
    expect(globQualifies("docs/**/*.md")).toBe(true);
  });

  it("rejects a bare star, an unrooted pattern and a globbed first segment", () => {
    expect(globQualifies("*")).toBe(false);
    expect(globQualifies("*.ts")).toBe(false);
    expect(globQualifies("**/x.ts")).toBe(false);
    expect(globQualifies("docs/**")).toBe(false);
  });

  it("rejects a glob past the length cap", () => {
    const filler = "x".repeat(MAX_GLOB_LENGTH - "src/".length);
    expect(globQualifies(`src/${filler}`)).toBe(true);
    expect(globQualifies(`src/${filler}x`)).toBe(false);
  });
});

describe("globMatcher", () => {
  it("matches segment patterns with stars and classes", () => {
    const match = globMatcher("src/*.test.ts");
    expect(match("src/a.test.ts")).toBe(true);
    expect(match("src/a/b.test.ts")).toBe(false);
  });

  it("lets ** span any number of segments, none included", () => {
    const match = globMatcher("a/**/b");
    expect(match("a/b")).toBe(true);
    expect(match("a/x/y/b")).toBe(true);
    expect(match("a/x/b/c")).toBe(false);
  });

  it("supports character classes and negation", () => {
    const match = globMatcher("src/[a-c]?.txt");
    expect(match("src/b1.txt")).toBe(true);
    expect(match("src/d1.txt")).toBe(false);
    const negated = globMatcher("src/[!a]b.txt");
    expect(negated("src/xb.txt")).toBe(true);
    expect(negated("src/ab.txt")).toBe(false);
  });

  it("keeps a star spanning a whole segment without backtracking blowups", () => {
    const match = globMatcher("a*x*b");
    expect(match("a1x22b")).toBe(true);
    expect(match("a1x22c")).toBe(false);
  });
});

describe("globQualifies: a segment list always exists", () => {
  it("rejects an empty pattern", () => {
    expect(globQualifies("")).toBe(false);
  });
});
