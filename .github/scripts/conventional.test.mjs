import { test } from "node:test";
import assert from "node:assert/strict";
import { bumpFor, effectiveBump, highestBump, parseSubject } from "./conventional.mjs";

const TYPES = ["feat", "fix", "perf", "refactor", "revert", "docs", "test", "chore", "ci", "build", "style"];

for (const type of TYPES) {
  test(`type ${type} parses and maps to its bump`, () => {
    assert.deepEqual(parseSubject(`${type}: do a thing`), { type, scope: null, breaking: false });
    assert.equal(bumpFor(`${type}: do a thing`, ""), type === "feat" ? "minor" : "patch");
  });
}

test("breaking marker on the subject is major", () => {
  assert.equal(bumpFor("feat!: x", ""), "major");
  assert.equal(bumpFor("fix(x)!: y", ""), "major");
  assert.deepEqual(parseSubject("fix(x)!: y"), { type: "fix", scope: "x", breaking: true });
});

test("BREAKING CHANGE footer on its own line is major", () => {
  assert.equal(bumpFor("fix: x", "BREAKING CHANGE: gone"), "major");
  assert.equal(bumpFor("fix: x", "BREAKING-CHANGE: gone"), "major");
  assert.equal(bumpFor("fix: x", "details\n\nBREAKING CHANGE: gone\nmore"), "major");
});

test("BREAKING CHANGE mid-line is not major", () => {
  assert.equal(bumpFor("fix: x", "this is no BREAKING CHANGE: here"), "patch");
});

test("scopes", () => {
  assert.deepEqual(parseSubject("feat(a,b): x"), { type: "feat", scope: "a,b", breaking: false });
  assert.deepEqual(parseSubject("feat: x"), { type: "feat", scope: null, breaking: false });
  assert.equal(parseSubject("feat(): x"), null);
  assert.equal(parseSubject("feat( a): x"), null);
});

test("git default revert subjects are valid and patch", () => {
  for (const s of ['Revert "fix(a): x"', 'Reapply "fix(a): x"']) {
    assert.deepEqual(parseSubject(s), { type: "revert", scope: null, breaking: false });
    assert.equal(bumpFor(s, ""), "patch");
  }
});

test("fixup and other forms are invalid", () => {
  assert.equal(parseSubject("fixup! fix(a): x"), null);
  assert.equal(parseSubject("squash! fix(a): x"), null);
  assert.equal(parseSubject("amend! fix(a): x"), null);
  assert.equal(parseSubject("random words"), null);
  assert.equal(parseSubject("feat:x"), null);
  assert.equal(parseSubject("feat: "), null);
  assert.equal(bumpFor("random words", ""), "patch");
});

test("highestBump", () => {
  assert.equal(highestBump(["patch", "minor", "patch"]), "minor");
  assert.equal(highestBump(["patch", "major", "minor"]), "major");
  assert.equal(highestBump(["patch"]), "patch");
  assert.equal(highestBump([]), "patch");
});

test("effectiveBump downgrades major only on a 0.x plugin", () => {
  assert.equal(effectiveBump("major", "0.3.0"), "minor");
  assert.equal(effectiveBump("major", "0.4.0-beta.0"), "minor");
  assert.equal(effectiveBump("major", "1.2.0"), "major");
  for (const v of ["0.3.0", "1.2.0"]) {
    assert.equal(effectiveBump("minor", v), "minor");
    assert.equal(effectiveBump("patch", v), "patch");
  }
});

test("the release bot subject parses", () => {
  assert.ok(parseSubject("chore(release): a v0.3.0 [skip ci]"));
  assert.ok(parseSubject("chore(release): a v0.3.0, b v0.3.0 [skip ci]"));
});
