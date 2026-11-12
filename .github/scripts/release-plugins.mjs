import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const matrix = JSON.parse(process.env.MATRIX ?? "[]");
if (matrix.length === 0) {
  console.log("No plugins to release.");
  process.exit(0);
}

// NPM_TOKEN gates ONLY the npm publish step. Without it we still bump the version,
// commit, tag, and cut the GitHub release for every changed plugin — only the
// publish to the npm registry is skipped.
const canPublish = Boolean((process.env.NODE_AUTH_TOKEN ?? "").trim());
if (!canPublish) {
  console.log(
    "NODE_AUTH_TOKEN (NPM_TOKEN secret) is not set — skipping the npm publish step only. " +
      "Version bump, commit, tags, and GitHub releases still run. Add the NPM_TOKEN " +
      "repository secret to publish to npm as well.",
  );
}

const run = (cmd, args, cwd, env = process.env) =>
  execFileSync(cmd, args, { cwd, stdio: "inherit", env });

// npm install / test / bb build run third-party plugin code (postinstall scripts,
// test and build tooling). Don't hand them the release credentials — they need
// neither, and this keeps a poisoned dependency away from the tokens.
const buildEnv = { ...process.env };
delete buildEnv.GH_TOKEN;
delete buildEnv.NODE_AUTH_TOKEN;

const released = [];
for (const { id, dir, bump } of matrix) {
  console.log(`\n=== ${id}: ${bump} ===`);
  run("npm", ["install", "--include=dev", "--legacy-peer-deps"], dir, buildEnv);
  run("npm", ["run", "test"], dir, buildEnv);
  run("bb", ["plugin", "build"], dir, buildEnv);

  const versionArgs = ["version", bump, "--no-git-tag-version"];
  if (bump === "prerelease") versionArgs.push("--preid", "beta");
  run("npm", versionArgs, dir);

  const version = JSON.parse(readFileSync(`${dir}/package.json`, "utf8")).version;
  const prerelease = version.includes("-");

  if (canPublish) {
    const publishArgs = ["publish", "--access", "public"];
    if (prerelease) publishArgs.push("--tag", "next");
    run("npm", publishArgs, dir);
  }

  const tag = `${id}/v${version}`;
  run("git", ["add", `${dir}/package.json`]);
  released.push({ id, version, tag, prerelease });
}

if (released.length === 0) process.exit(0);

const summary = released.map((r) => `${r.id} v${r.version}`).join(", ");
run("git", ["commit", "-m", `chore(release): ${summary} [skip ci]`]);
for (const r of released) run("git", ["tag", "-a", r.tag, "-m", `${r.id} v${r.version}`]);
run("git", ["push", "origin", "HEAD:master"]);
run("git", ["push", "origin", "--tags"]);

for (const r of released) {
  const notes = canPublish
    ? `Release ${r.id} v${r.version}.`
    : `Release ${r.id} v${r.version}.\n\n**Not published to npm** — NPM_TOKEN was not configured for this run, so this version has no npm package. It is not published retroactively: a later run publishes the next bumped version, not this one.`;
  const args = ["release", "create", r.tag, "--title", `${r.id} v${r.version}`, "--notes", notes];
  if (r.prerelease) args.push("--prerelease");
  run("gh", args);
}

console.log(
  canPublish
    ? `\nReleased (npm + tag + GitHub): ${summary}`
    : `\nTagged + GitHub-released, npm publish skipped: ${summary}`,
);
