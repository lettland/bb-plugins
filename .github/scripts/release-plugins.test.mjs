import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scripts = dirname(fileURLToPath(import.meta.url));
const node = process.execPath;
const npm = join(dirname(node), "npm");
const git = execFileSync("which", ["git"], { encoding: "utf8" }).trim();

function exercise({ start = "0.3.1", commits = [], forced = "", expected, prerelease = false, canPublish = true }) {
  const cwd = mkdtempSync(join(tmpdir(), "release-test-"));
  try {
    const bin = join(cwd, "bin");
    const plugin = join(cwd, "plugins/a");
    mkdirSync(bin, { recursive: true });
    mkdirSync(plugin, { recursive: true });
    const log = join(cwd, "calls");
    const env = {
      PATH: `${bin}:${dirname(node)}:/usr/bin:/bin`, HOME: cwd,
      GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "test", GIT_AUTHOR_EMAIL: "test@example.invalid",
      GIT_COMMITTER_NAME: "test", GIT_COMMITTER_EMAIL: "test@example.invalid",
      npm_config_userconfig: join(cwd, "npmrc"), npm_config_globalconfig: join(cwd, "global-npmrc"),
      npm_config_ignore_scripts: "true", npm_config_update_notifier: "false",
      LOG: log, REAL_NPM: npm, NODE_AUTH_TOKEN: "fixture-token", GH_TOKEN: "fixture-token",
    };
    if (!canPublish) delete env.NODE_AUTH_TOKEN;
    const runGit = (...args) => execFileSync(git, args, { cwd, env, stdio: "pipe" });
    writeFileSync(join(plugin, "package.json"), JSON.stringify({ name: "fixture-a", version: start }));
    runGit("init", "-b", "master");
    runGit("add", ".");
    runGit("-c", "commit.gpgsign=false", "commit", "-m", "chore: init");
    runGit("-c", "tag.gpgsign=false", "tag", "-a", `a/v${start}`, "-m", "initial");
    for (const [index, subject] of commits.entries()) {
      writeFileSync(join(plugin, `change-${index}`), subject);
      runGit("add", ".");
      runGit("-c", "commit.gpgsign=false", "commit", "-m", subject);
    }
    const out = join(cwd, "output");
    const selected = spawnSync(node, [join(scripts, "select-plugins.mjs")], {
      cwd, env: { ...env, PATH: `${dirname(node)}:/usr/bin:/bin`, GITHUB_OUTPUT: out, ONLY_PLUGIN: "a", FORCED_BUMP: forced }, encoding: "utf8",
    });
    assert.equal(selected.status, 0, selected.stderr);
    const matrix = readFileSync(out, "utf8").match(/^matrix=(.*)$/m)[1];
    // Only npm version reaches the real npm. All other commands only record calls.
    const stub = `#!${node}\nconst fs = require('node:fs');\nconst { execFileSync } = require('node:child_process');\nconst name = require('node:path').basename(process.argv[1]);\nconst args = process.argv.slice(2);\nfs.appendFileSync(process.env.LOG, JSON.stringify([name, ...args, Boolean(process.env.GH_TOKEN), Boolean(process.env.NODE_AUTH_TOKEN)]) + '\\n');\nif (name === 'npm' && args[0] === 'version') execFileSync(process.env.REAL_NPM, args, { stdio: 'inherit', env: process.env });\n`;
    for (const name of ["npm", "git", "bb", "gh"]) {
      writeFileSync(join(bin, name), stub);
      chmodSync(join(bin, name), 0o755);
    }
    const result = spawnSync(node, [join(scripts, "release-plugins.mjs")], {
      cwd, env: { ...env, MATRIX: matrix }, encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(JSON.parse(readFileSync(join(plugin, "package.json"), "utf8")).version, expected);
    const calls = readFileSync(log, "utf8").trim().split("\n").map(JSON.parse);
    for (const [name, action] of [["npm", "install"], ["npm", "run"], ["bb", "plugin"], ["git", "tag"], ["gh", "release"]]) {
      assert.equal(calls.filter((c) => c[0] === name && c[1] === action).length, 1, `${name} ${action}`);
    }
    if (forced) assert.equal(calls.filter((c) => c[0] === "npm" && c[1] === "version").length, 1);
    for (const call of calls.filter((c) => (c[0] === "npm" && ["install", "run"].includes(c[1])) || c[0] === "bb")) {
      assert.deepEqual(call.slice(-2), [false, false]);
    }
    const publishes = calls.filter((c) => c[0] === "npm" && c[1] === "publish");
    assert.equal(publishes.length, canPublish ? 1 : 0);
    if (canPublish) {
      assert.equal(publishes[0].at(-1), true);
      assert.equal(publishes[0].includes("next"), prerelease);
    }
    assert.equal(calls.find((c) => c[0] === "gh").includes("--prerelease"), prerelease);
    assert.equal(calls.find((c) => c[0] === "git" && c[1] === "tag")[3], `a/v${expected}`);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

for (const [name, options] of [
  ["two patches", { commits: ["fix: one", "fix: two"], expected: "0.3.3" }],
  ["single patch", { commits: ["fix: one"], expected: "0.3.2" }],
  ["fix then feature", { commits: ["fix: one", "feat: two"], expected: "0.4.0" }],
  ["feature then fix", { commits: ["feat: one", "fix: two"], expected: "0.4.1" }],
  ["repeated features", { commits: ["feat: one", "feat: two"], expected: "0.5.0" }],
  ["breaking on zero", { commits: ["fix!: one"], expected: "0.4.0" }],
  ["breaking on one", { start: "1.2.3", commits: ["fix!: one"], expected: "2.0.0" }],
  ["unchanged fallback", { expected: "0.3.2" }],
  ["without publish token", { commits: ["fix: one"], expected: "0.3.2", canPublish: false }],
  ["forced patch", { commits: ["fix: one", "fix: two"], forced: "patch", expected: "0.3.2" }],
  ["forced minor", { commits: ["fix: one", "fix: two"], forced: "minor", expected: "0.4.0" }],
  ["forced major", { commits: ["fix: one", "fix: two"], forced: "major", expected: "1.0.0" }],
  ["forced prerelease", { commits: ["fix: one", "fix: two"], forced: "prerelease", expected: "0.3.2-beta.0", prerelease: true }],
  ["forced exact", { commits: ["fix: one", "fix: two"], forced: "0.8.0", expected: "0.8.0" }],
]) {
  test(`selector and executor: ${name}`, () => exercise(options));
}
