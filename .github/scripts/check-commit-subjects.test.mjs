import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const script = join(dirname(fileURLToPath(import.meta.url)), "check-commit-subjects.mjs");
const env = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.invalid",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.invalid",
};

let cwd;
const git = (...args) => execFileSync("git", args, { cwd, env, encoding: "utf8" }).trim();
const commit = (subject, file = "f.txt") => {
  writeFileSync(join(cwd, file), `${subject}\n${Math.random()}\n`);
  git("add", file);
  git("-c", "commit.gpgsign=false", "commit", "-m", subject);
  return git("rev-parse", "HEAD");
};
const check = (...args) => spawnSync("node", [script, ...args], { cwd, env, encoding: "utf8" });

before(() => {
  cwd = mkdtempSync(join(tmpdir(), "subjects-"));
  git("init", "-b", "master");
  commit("chore: root");
  git("tag", "base");
});
after(() => rmSync(cwd, { recursive: true, force: true }));

test("a bad subject among good ones fails and is reported with the fixed prefix", () => {
  commit("fix(a): good");
  const bad = commit("a: legacy subject");
  const r = check("base..HEAD");
  assert.equal(r.status, 1);
  assert.ok(r.stdout.split("\n").includes(`bad subject ${bad}: a: legacy subject`), r.stdout);
  git("reset", "--hard", "base");
});

test("a subject that looks like a workflow command still starts with the prefix", () => {
  const bad = commit("::warning::x");
  const r = check("base..HEAD");
  assert.equal(r.status, 1);
  const lines = r.stdout.split("\n").filter((l) => l.includes("::warning::x"));
  assert.deepEqual(lines, [`bad subject ${bad}: ::warning::x`]);
  git("reset", "--hard", "base");
});

test("an all-good range passes", () => {
  commit("feat(a): one");
  commit("chore(release): a v0.3.0 [skip ci]");
  const r = check("base..HEAD");
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /^all 2 commit subjects ok$/m);
  git("reset", "--hard", "base");
});

test("merge commits are not checked", () => {
  git("checkout", "-b", "side");
  commit("fix: side", "side.txt");
  git("checkout", "master");
  commit("fix: main");
  git("-c", "commit.gpgsign=false", "merge", "--no-ff", "-m", "Merge branch side", "side");
  const r = check("base..HEAD");
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /all 2 commit subjects ok/);
});

test("a missing argument prints usage and exits 2", () => {
  const r = check();
  assert.equal(r.status, 2);
  assert.match(r.stderr, /Usage/);
});
