import { execFileSync } from "node:child_process";
import { appendFileSync, readdirSync, readFileSync, existsSync } from "node:fs";
import { bumpFor, effectiveBump, highestBump, parseSubject } from "./conventional.mjs";

const NAMED_BUMPS = new Set(["patch", "minor", "major", "prerelease"]);
const EXACT_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

const onlyPlugin = (process.env.ONLY_PLUGIN ?? "").trim();
const forcedBump = (process.env.FORCED_BUMP ?? "").trim();
if (forcedBump && !NAMED_BUMPS.has(forcedBump) && !EXACT_VERSION.test(forcedBump)) {
  console.error(
    `Invalid release_type "${forcedBump}" (expected ${[...NAMED_BUMPS].join(", ")}, or an exact version X.Y.Z).`,
  );
  process.exit(1);
}

const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();

function latestTag(id) {
  const tags = git("tag", "--list", `${id}/v*`, "--sort=-v:refname")
    .split("\n")
    .map((t) => t.trim())
    .filter(Boolean);
  return tags[0] ?? null;
}

function pluginChangedSince(id, tag) {
  if (!tag) return true;
  try {
    execFileSync("git", ["diff", "--quiet", tag, "HEAD", "--", `plugins/${id}`]);
    return false;
  } catch {
    return true;
  }
}

// True when `target` (X.Y.Z) is strictly above `current` by semver precedence.
// On a numeric tie the target is above only when current carries a prerelease.
function isAbove(target, current) {
  const t = target.split(".").map(Number);
  // Build metadata (`+…`) has no precedence in semver.
  const [core, ...pre] = current.split("+")[0].split("-");
  const c = core.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if (t[i] !== c[i]) return t[i] > c[i];
  }
  return pre.length > 0;
}

function inferBump(id, tag, currentVersion) {
  if (forcedBump) return forcedBump;
  const range = tag ? `${tag}..HEAD` : "HEAD";
  const records = execFileSync(
    "git",
    ["log", "--no-merges", "--format=%H%x1f%s%x1f%b%x1e", range, "--", `plugins/${id}`],
    { encoding: "utf8" },
  )
    .split("\x1e")
    .map((r) => r.replace(/^\n/, ""))
    .filter((r) => r.trim() !== "");

  const bumps = [];
  let malformed = 0;
  for (const record of records) {
    const [sha, subject = "", body = ""] = record.split("\x1f");
    bumps.push(bumpFor(subject, body));
    if (parseSubject(subject) === null) {
      malformed++;
      console.log(`malformed subject ${sha}: ${subject}`);
    }
  }

  if (bumps.length === 0) {
    console.log(`warning ${id}: changed but no non-merge commits in range; using patch`);
    return "patch";
  }
  const bump = effectiveBump(highestBump(bumps), currentVersion);
  console.log(`${id}: ${bump} (${bumps.length} commits${malformed ? `, ${malformed} malformed` : ""})`);
  return bump;
}

const pluginsDir = "plugins";
const selected = [];
const currentVersions = new Map();
for (const entry of readdirSync(pluginsDir, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const id = entry.name;
  if (onlyPlugin && id !== onlyPlugin) continue;
  const pkgPath = `${pluginsDir}/${id}/package.json`;
  if (!existsSync(pkgPath)) continue;
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));

  const tag = latestTag(id);
  const forced = onlyPlugin === id || Boolean(forcedBump);
  if (!forced && !pluginChangedSince(id, tag)) continue;

  currentVersions.set(id, pkg.version);
  selected.push({ id, dir: `${pluginsDir}/${id}`, name: pkg.name, bump: inferBump(id, tag, pkg.version) });
}

if (EXACT_VERSION.test(forcedBump)) {
  const blocking = selected.filter((p) => !isAbove(forcedBump, currentVersions.get(p.id)));
  if (blocking.length > 0) {
    for (const p of blocking) {
      console.error(`release_type ${forcedBump} is not above ${p.id} ${currentVersions.get(p.id)}`);
    }
    process.exit(1);
  }
}

const matrix = JSON.stringify(selected);
const any = selected.length > 0 ? "true" : "false";
console.log(`Selected ${selected.length} plugin(s): ${selected.map((p) => `${p.id}(${p.bump})`).join(", ") || "none"}`);

const out = process.env.GITHUB_OUTPUT;
if (out) {
  appendFileSync(out, `matrix=${matrix}\n`);
  appendFileSync(out, `any=${any}\n`);
}
