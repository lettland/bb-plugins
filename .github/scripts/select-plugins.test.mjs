import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const script = join(dirname(fileURLToPath(import.meta.url)), "select-plugins.mjs");
const baseEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.invalid",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.invalid",
};
delete baseEnv.ONLY_PLUGIN;
delete baseEnv.FORCED_BUMP;
delete baseEnv.GITHUB_OUTPUT;

const dirs = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true });
});

// Temp repo with plugins a and b (tagged at their current versions) and c
// (a directory without package.json).
function makeRepo({ a = "0.1.0", b = "0.2.4" } = {}) {
  const cwd = mkdtempSync(join(tmpdir(), "select-"));
  dirs.push(cwd);
  const git = (...args) => execFileSync("git", args, { cwd, env: baseEnv, encoding: "utf8" }).trim();
  const write = (path, content) => {
    mkdirSync(dirname(join(cwd, path)), { recursive: true });
    writeFileSync(join(cwd, path), content);
  };
  const pkg = (id, version) => write(`plugins/${id}/package.json`, JSON.stringify({ name: `@x/${id}`, version }));
  const commit = (message) => git("-c", "commit.gpgsign=false", "commit", "-m", message);
  // Change a file under the given path and commit it with a full message.
  const change = (path, message) => {
    write(path, `${Math.random()}\n`);
    git("add", "-A");
    commit(message);
  };

  git("init", "-b", "master");
  pkg("a", a);
  pkg("b", b);
  write("plugins/c/README.md", "c\n");
  git("add", "-A");
  commit("chore: init");
  git("-c", "tag.gpgSign=false", "tag", "-a", "a/v" + a, "-m", "a");
  git("-c", "tag.gpgSign=false", "tag", "-a", "b/v" + b, "-m", "b");
  return { cwd, git, write, pkg, commit, change };
}

function select(repo, env = {}) {
  const output = join(repo.cwd, "..", `out-${Math.random().toString(36).slice(2)}`);
  writeFileSync(output, "");
  dirs.push(output);
  const r = spawnSync("node", [script], {
    cwd: repo.cwd,
    env: { ...baseEnv, GITHUB_OUTPUT: output, ...env },
    encoding: "utf8",
  });
  const text = readFileSync(output, "utf8");
  const m = text.match(/^matrix=(.*)$/m);
  return {
    status: r.status,
    stdout: r.stdout,
    stderr: r.stderr,
    all: r.stdout + r.stderr,
    matrix: m ? JSON.parse(m[1]) : null,
    any: text.match(/^any=(.*)$/m)?.[1] ?? null,
  };
}

const bumps = (res) => Object.fromEntries(res.matrix.map((p) => [p.id, p.bump]));

test("nothing changed selects nothing", () => {
  const repo = makeRepo();
  const res = select(repo);
  assert.equal(res.status, 0);
  assert.deepEqual(res.matrix, []);
  assert.equal(res.any, "false");
});

test("feat is a minor and matrix entries keep their keys", () => {
  const repo = makeRepo();
  repo.change("plugins/a/x.txt", "feat(a): add x");
  const res = select(repo);
  assert.equal(res.status, 0, res.all);
  assert.deepEqual(res.matrix, [{ id: "a", dir: "plugins/a", name: "@x/a", bump: "minor" }]);
  assert.equal(res.any, "true");
  assert.match(res.stdout, /^a: minor \(1 commits\)$/m);
});

test("a breaking change is a minor on a 0.x plugin", () => {
  const repo = makeRepo();
  repo.change("plugins/a/x.txt", "feat!: drop x");
  assert.deepEqual(bumps(select(repo)), { a: "minor" });
});

test("a breaking change is a major on a plugin at 1.0.0", () => {
  const repo = makeRepo({ a: "1.0.0" });
  repo.change("plugins/a/x.txt", "feat!: drop x");
  assert.deepEqual(bumps(select(repo)), { a: "major" });
});

test("a BREAKING CHANGE footer in a multi-line body is breaking", () => {
  const repo = makeRepo({ a: "1.0.0" });
  repo.change("plugins/a/x.txt", "fix: tweak x\n\nlong explanation\nsecond line\n\nBREAKING CHANGE: x is gone");
  assert.deepEqual(bumps(select(repo)), { a: "major" });
});

test("a manual major on a 0.x plugin stays major", () => {
  const repo = makeRepo();
  repo.change("plugins/a/x.txt", "fix: x");
  const res = select(repo, { FORCED_BUMP: "major" });
  assert.deepEqual(bumps(res), { a: "major", b: "major" });
});

test("docs-only changes are a patch", () => {
  const repo = makeRepo();
  repo.change("plugins/a/x.txt", "docs(a): explain x");
  assert.deepEqual(bumps(select(repo)), { a: "patch" });
});

test("the highest bump over the range wins", () => {
  const repo = makeRepo();
  repo.change("plugins/a/x.txt", "fix: one");
  repo.change("plugins/a/y.txt", "feat: two");
  repo.change("plugins/a/z.txt", "docs: three");
  const res = select(repo);
  assert.deepEqual(bumps(res), { a: "minor" });
  assert.match(res.stdout, /^a: minor \(3 commits\)$/m);
});

test("one commit touching a and b bumps both", () => {
  const repo = makeRepo();
  repo.write("plugins/a/x.txt", "1\n");
  repo.write("plugins/b/x.txt", "1\n");
  repo.git("add", "-A");
  repo.commit("feat(a,b): shared");
  assert.deepEqual(bumps(select(repo)), { a: "minor", b: "minor" });
});

test("a legacy subject is a patch and logs a malformed line at the start of the line", () => {
  const repo = makeRepo();
  repo.change("plugins/a/x.txt", "a: thing");
  const res = select(repo);
  assert.deepEqual(bumps(res), { a: "patch" });
  const line = res.stdout.split("\n").find((l) => l.startsWith("malformed subject "));
  assert.ok(line, res.stdout);
  assert.match(line, /^malformed subject [0-9a-f]{40}: a: thing$/);
  assert.match(res.stdout, /^a: patch \(1 commits, 1 malformed\)$/m);
});

test("a malformed subject that looks like a workflow command never starts a line", () => {
  const repo = makeRepo();
  repo.change("plugins/a/x.txt", "::warning::x");
  const res = select(repo);
  assert.ok(!res.stdout.split("\n").some((l) => l.startsWith("::")), res.stdout);
});

test("empty and multi-line bodies split into separate commits", () => {
  const repo = makeRepo();
  repo.change("plugins/a/x.txt", "fix: no body");
  repo.change("plugins/a/y.txt", "fix: body\n\nline one\nline two\nline three");
  repo.change("plugins/a/z.txt", "feat: last");
  const res = select(repo);
  assert.deepEqual(bumps(res), { a: "minor" });
  assert.match(res.stdout, /^a: minor \(3 commits\)$/m);
  assert.ok(!res.stdout.includes("malformed"), res.stdout);
});

test("merge commits are ignored", () => {
  const repo = makeRepo();
  repo.git("checkout", "-b", "side");
  repo.change("plugins/a/x.txt", "feat(a): from side");
  repo.git("checkout", "master");
  repo.change("README.md", "docs: root readme");
  repo.git("-c", "commit.gpgsign=false", "merge", "--no-ff", "-m", "Merge branch side", "side");
  const res = select(repo);
  assert.deepEqual(bumps(res), { a: "minor" });
  assert.match(res.stdout, /^a: minor \(1 commits\)$/m);
  assert.ok(!res.stdout.includes("malformed"), res.stdout);
});

test("a change that arrives only through a merge commit is a patch with a warning", () => {
  const repo = makeRepo();
  repo.git("checkout", "-b", "side");
  repo.change("other.txt", "feat: elsewhere");
  repo.git("checkout", "master");
  repo.change("README.md", "docs: root readme");
  repo.git("-c", "commit.gpgsign=false", "merge", "--no-ff", "--no-commit", "side");
  repo.write("plugins/a/merged.txt", "only in the merge\n");
  repo.git("add", "-A");
  repo.commit("Merge branch side");
  const res = select(repo);
  assert.deepEqual(bumps(res), { a: "patch" });
  assert.match(res.stdout, /^warning a: changed but no non-merge commits in range; using patch$/m);
});

test("a forced bump selects a and b even without changes, never c", () => {
  const repo = makeRepo();
  const res = select(repo, { FORCED_BUMP: "minor" });
  assert.deepEqual(bumps(res), { a: "minor", b: "minor" });
});

test("ONLY_PLUGIN without FORCED_BUMP uses the inferred bump", () => {
  const repo = makeRepo();
  repo.change("plugins/a/x.txt", "feat: x");
  const res = select(repo, { ONLY_PLUGIN: "a" });
  assert.deepEqual(bumps(res), { a: "minor" });
});

test("ONLY_PLUGIN on an unchanged plugin is still selected, with a patch", () => {
  const repo = makeRepo();
  const res = select(repo, { ONLY_PLUGIN: "b" });
  assert.deepEqual(bumps(res), { b: "patch" });
});

test("a directory without package.json is never selected", () => {
  const repo = makeRepo();
  repo.change("plugins/c/x.txt", "feat(c): x");
  assert.deepEqual(select(repo, { ONLY_PLUGIN: "c" }).matrix, []);
  assert.deepEqual(select(repo, { FORCED_BUMP: "patch" }).matrix.map((p) => p.id), ["a", "b"]);
});

test("an unknown release_type is rejected", () => {
  const repo = makeRepo();
  const res = select(repo, { FORCED_BUMP: "huge" });
  assert.equal(res.status, 1);
  assert.equal(res.matrix, null);
});

test("an exact version above every selected plugin selects all with that bump", () => {
  const repo = makeRepo();
  const res = select(repo, { FORCED_BUMP: "0.3.0" });
  assert.equal(res.status, 0, res.all);
  assert.deepEqual(bumps(res), { a: "0.3.0", b: "0.3.0" });
});

test("an exact version equal to a selected plugin's version exits 1 naming it", () => {
  const repo = makeRepo();
  const res = select(repo, { FORCED_BUMP: "0.2.4" });
  assert.equal(res.status, 1);
  assert.match(res.all, /release_type 0\.2\.4 is not above b 0\.2\.4/);
  assert.ok(!res.all.includes("above a "), res.all);
  assert.equal(res.matrix, null);
});

test("an exact version below a selected plugin's version exits 1", () => {
  const repo = makeRepo();
  const res = select(repo, { FORCED_BUMP: "0.1.9" });
  assert.equal(res.status, 1);
  assert.match(res.all, /not above b 0\.2\.4/);
});

for (const bad of ["0.3", "v0.3.0", "00.3.0", "0.3.0.1", "0.03.0"]) {
  test(`a malformed exact version ${bad} exits 1`, () => {
    const repo = makeRepo();
    const res = select(repo, { FORCED_BUMP: bad });
    assert.equal(res.status, 1);
    assert.equal(res.matrix, null);
  });
}

test("a current prerelease is below its release version", () => {
  const repo = makeRepo({ a: "0.3.0-beta.1" });
  const res = select(repo, { FORCED_BUMP: "0.3.0", ONLY_PLUGIN: "a" });
  assert.equal(res.status, 0, res.all);
  assert.deepEqual(bumps(res), { a: "0.3.0" });
});

test("build metadata on the current version is ignored by the exact-version guard", () => {
  // Only a patch-decided comparison tells the metadata apart: "0+abc" read as a
  // number is NaN, which made 0.3.1 look not above 0.3.0+abc.
  const above = select(makeRepo({ a: "0.3.0+abc" }), { FORCED_BUMP: "0.3.1", ONLY_PLUGIN: "a" });
  assert.equal(above.status, 0, above.all);
  assert.deepEqual(bumps(above), { a: "0.3.1" });
  const equal = select(makeRepo({ a: "0.3.0+abc" }), { FORCED_BUMP: "0.3.0", ONLY_PLUGIN: "a" });
  assert.equal(equal.status, 1, equal.all);
});

test("the guard applies only to selected plugins", () => {
  const repo = makeRepo();
  const res = select(repo, { ONLY_PLUGIN: "a", FORCED_BUMP: "0.2.0" });
  assert.equal(res.status, 0, res.all);
  assert.deepEqual(bumps(res), { a: "0.2.0" });
});
