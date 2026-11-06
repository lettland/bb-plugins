#!/usr/bin/env node
// Author-time script: vendors the GRC framework skills from a local clone of
// Sushegaad/Claude-Skills-Governance-Risk-and-Compliance, pinned to one full commit SHA.
//
//   node scripts/sync-grc.mjs <path-to-clone> <40-hex-commit-sha>
//
// The script makes no network calls. Two phases: phase 1 computes every output and runs every
// gate in memory; phase 2 deletes the files the previous manifest lists and writes the new ones.
// A failing gate therefore leaves the tree untouched. Run `node scripts/build-index.mjs` after it.
import { execFile } from "node:child_process";
import { mkdir, lstat, readFile, rm, rmdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { REFERENCE_RE, SLUG_RE } from "../src/loader.mjs";

const execFileAsync = promisify(execFile);

export const UPSTREAM_REPO = "Sushegaad/Claude-Skills-Governance-Risk-and-Compliance";
export const NOTICES_HEADING = "## Sushegaad Claude-Skills-Governance-Risk-and-Compliance (MIT)";
export const MANIFEST_FILE = "grc-upstream.json";

const SHA_RE = /^[0-9a-f]{40}$/u;
const REGULAR_FILE_MODES = new Set(["100644", "100755"]);

/**
 * Frameworks the compliance reviewer already checks. The description replaces the upstream one:
 * upstream descriptions are written to trigger as often as possible and would outrank devkit's own
 * skills in `devkit_find_skills`. Keep the slug list in sync with `reviewer-compliance.md` (a test
 * enforces it).
 */
export const FRAMEWORKS = [
  {
    upstream: "gdpr-compliance",
    slug: "grc-gdpr",
    description:
      "GDPR knowledge pack (vendored, MIT): lawful basis, data subject rights, DPIA, controller and processor duties, cross-border transfers, breach notification. Loaded by the compliance reviewer when the framework applies; use for GDPR-specific questions.",
  },
  {
    upstream: "soc2",
    slug: "grc-soc2",
    description:
      "SOC 2 knowledge pack (vendored, MIT): Trust Services Criteria, control matrix, evidence catalog, policy templates, vendor risk questionnaires. Loaded by the compliance reviewer when the framework applies; use for SOC 2-specific questions.",
  },
  {
    upstream: "nis2",
    slug: "grc-nis2",
    description:
      "NIS2 knowledge pack (vendored, MIT): entity classification, Art. 21 risk-management measures, Art. 23 incident reporting, supply chain, management accountability. Loaded by the compliance reviewer when the framework applies; use for NIS2-specific questions.",
  },
  {
    upstream: "eu-ai-act",
    slug: "grc-eu-ai-act",
    description:
      "EU AI Act knowledge pack (vendored, MIT): risk classification, prohibited practices, high-risk provider and deployer obligations, GPAI models, transparency, penalties. Loaded by the compliance reviewer when the framework applies; use for EU AI Act-specific questions.",
  },
  {
    upstream: "eu-cra",
    slug: "grc-eu-cra",
    description:
      "EU Cyber Resilience Act knowledge pack (vendored, MIT): essential requirements, vulnerability handling, SBOM, conformity assessment, CE marking, reporting duties. Loaded by the compliance reviewer when the framework applies; use for CRA-specific questions.",
  },
  {
    upstream: "dora",
    slug: "grc-dora",
    description:
      "DORA knowledge pack (vendored, MIT): ICT risk management, ICT incident classification and reporting, resilience testing, ICT third-party risk, RTS and ITS. Loaded by the compliance reviewer when the framework applies; use for DORA-specific questions.",
  },
  {
    upstream: "pci-compliance",
    slug: "grc-pci-dss",
    description:
      "PCI DSS knowledge pack (vendored, MIT): the 12 requirements, SAQ selection, cardholder data scoping, v4.0 changes. Loaded by the compliance reviewer when the framework applies; use for PCI DSS-specific questions.",
  },
  {
    upstream: "hipaa-compliance",
    slug: "grc-hipaa",
    description:
      "HIPAA knowledge pack (vendored, MIT): Privacy Rule, Security Rule safeguards, breach notification, business associates, PHI. Loaded by the compliance reviewer when the framework applies; use for HIPAA-specific questions.",
  },
  {
    upstream: "ccpa",
    slug: "grc-ccpa",
    description:
      "CCPA and CPRA knowledge pack (vendored, MIT): business thresholds, consumer rights, sensitive personal information, service provider contracts, opt-out of sale or sharing. Loaded by the compliance reviewer when the framework applies; use for CCPA-specific questions.",
  },
];

/** Invisible or direction-changing code points. U+FE0F (emoji variation selector) is allowed on purpose. */
const INVISIBLE_RE =
  /[\u00AD\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF\u{E0000}-\u{E007F}\u{E0100}-\u{E01EF}]/u;
/** `references/<name>.md` as upstream cites it (inline code, bold, table cell, bullet, prose). */
const PATH_CITATION_RE = /references\/([a-z0-9][a-z0-9-]*)\.md/gu;
/** A bare `<name>.md` that no letter, digit, `_`, `-`, `/` or `.` precedes. */
const BARE_CITATION_RE = /(?<![A-Za-z0-9_\-/.])([a-z0-9][a-z0-9-]*)\.md/gu;
/** Same shape, but a `/` or `.` before the name still counts: the final gate is stricter than the rewrite. */
const BARE_LEFTOVER_RE = /(?<![A-Za-z0-9_-])([a-z0-9][a-z0-9-]*)\.md/gu;

class GrcSyncError extends Error {}

function fail(message) {
  throw new GrcSyncError(message);
}

function assertName(value, re, what) {
  if (typeof value !== "string" || !re.test(value)) fail(`${what} ${JSON.stringify(value)} violates the name pattern`);
}

function assertGrcSlug(value, what) {
  assertName(value, SLUG_RE, what);
  if (!value.startsWith("grc-")) fail(`${what} ${JSON.stringify(value)} must start with "grc-"`);
}

/** Run git without a shell, with every GIT_* variable removed so an inherited GIT_DIR cannot redirect it. */
async function git(cloneDir, args) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith("GIT_")) env[key] = value;
  }
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", cloneDir, "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", ...args],
      { env, encoding: "buffer", maxBuffer: 256 * 1024 * 1024 },
    );
    return stdout;
  } catch (error) {
    return fail(`git ${args[0]} failed: ${String(error.stderr).trim()}`);
  }
}

function decodeUtf8(buffer, label) {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buffer);
  } catch {
    return fail(`${label}: not valid UTF-8`);
  }
}

/** Reject any copied text that hides content from a human reader. */
export function assertVisibleContent(text, label) {
  if (text.includes("<!--")) fail(`${label}: contains an HTML comment`);
  const hit = INVISIBLE_RE.exec(text);
  if (hit) fail(`${label}: contains invisible character U+${hit[0].codePointAt(0).toString(16).toUpperCase().padStart(4, "0")}`);
}

/**
 * Rewrite upstream reference citations to `devkit_load_skill` calls: first `references/<name>.md`,
 * then bare `<name>.md` for the framework's own reference files. Fails on a cited name with no file.
 */
export function rewriteCitations(text, slug, names, label) {
  const known = new Set(names);
  const call = (name) => `devkit_load_skill({ reference: "${slug}-${name}" })`;
  const pathPass = text.replace(PATH_CITATION_RE, (_match, name) => {
    if (!known.has(name)) fail(`${label}: cites references/${name}.md, which does not exist upstream`);
    return call(name);
  });
  return pathPass.replace(BARE_CITATION_RE, (match, name) => (known.has(name) ? call(name) : match));
}

function assertNoLeftoverCitations(text, names, label) {
  if (text.includes("references/")) fail(`${label}: still contains "references/" after the citation rewrite`);
  const known = new Set(names);
  for (const match of text.matchAll(BARE_LEFTOVER_RE)) {
    if (known.has(match[1])) fail(`${label}: still contains the bare reference name "${match[1]}.md" after the citation rewrite`);
  }
}

/**
 * Edit the frontmatter as text (never re-dumped through YAML, so the output is byte-deterministic):
 * new name, devkit description as one single-quoted line, `metadata.type: grc`, then the header line.
 */
function rewriteSkill(text, framework, names, sha, label) {
  const parts = /^---\n([\s\S]*?)\n---(?:\n|$)/u.exec(text);
  if (parts === null) fail(`${label}: no frontmatter block`);
  const keys = [];
  for (const line of parts[1].split("\n")) {
    if (line === "" || /^[ \t]/u.test(line)) {
      if (keys.length === 0) fail(`${label}: frontmatter does not start with a key`);
      continue;
    }
    const key = /^([A-Za-z0-9_-]+):/u.exec(line);
    if (key === null) fail(`${label}: unparseable frontmatter line ${JSON.stringify(line)}`);
    keys.push(key[1]);
  }
  if (keys.length !== 2 || !keys.includes("name") || !keys.includes("description")) {
    fail(`${label}: frontmatter keys must be exactly name and description, found [${keys.join(", ")}]`);
  }
  const body = rewriteCitations(text.slice(parts[0].length), framework.slug, names, label);
  const description = framework.description.replaceAll("'", "''");
  const header = `> Vendored from ${UPSTREAM_REPO}@${sha} (MIT); not legal advice. Do not edit; re-run scripts/sync-grc.mjs.`;
  const out = [
    "---",
    `name: ${framework.slug}`,
    `description: '${description}'`,
    "metadata:",
    "  type: grc",
    "---",
    "",
    header,
    body.startsWith("\n") ? body : `\n${body}`,
  ].join("\n");
  assertNoLeftoverCitations(out, names, label);
  return out;
}

/** Read the framework's file list from the commit object. Returns { skill, references: Map<name, text> }. */
async function readFramework(cloneDir, sha, framework) {
  const prefix = `plugins/${framework.upstream}/skills/${framework.upstream}/`;
  const listing = decodeUtf8(await git(cloneDir, ["ls-tree", "-r", "-z", sha, "--", prefix]), `${framework.upstream}: ls-tree`);
  const files = new Map();
  for (const entry of listing.split("\0").filter((e) => e !== "")) {
    const tab = entry.indexOf("\t");
    const mode = entry.slice(0, tab).split(" ")[0];
    const file = entry.slice(tab + 1);
    if (!REGULAR_FILE_MODES.has(mode)) fail(`${file}: unsupported tree entry mode ${mode} (only regular files are accepted)`);
    const rel = file.slice(prefix.length);
    const ref = /^references\/([^/]+)\.md$/u.exec(rel);
    if (rel !== "SKILL.md" && ref === null) fail(`${file}: unexpected file under the skill directory (only SKILL.md and references/*.md are vendored)`);
    files.set(rel, ref === null ? null : ref[1]);
  }
  if (!files.has("SKILL.md")) fail(`${framework.upstream}: no SKILL.md in the upstream commit`);

  const read = async (rel) => {
    const label = `${prefix}${rel}`;
    const text = decodeUtf8(await git(cloneDir, ["cat-file", "blob", `${sha}:${label}`]), label);
    assertVisibleContent(text, label);
    return text;
  };
  const references = new Map();
  // ls-tree emits paths in byte order, so the Map (and the manifest) is already sorted.
  for (const [rel, name] of [...files].filter(([, n]) => n !== null)) {
    assertName(name, REFERENCE_RE, `${framework.upstream} reference name`);
    assertName(`${framework.slug}-${name}`, REFERENCE_RE, `${framework.upstream} reference file name`);
    references.set(name, await read(rel));
  }
  return { skill: await read("SKILL.md"), references };
}

/** The files a manifest lists, relative to the content dir. Throws before anything is deleted if it is malformed. */
export function listedFiles(manifestText) {
  let manifest;
  try {
    manifest = JSON.parse(manifestText);
  } catch {
    return fail(`previous ${MANIFEST_FILE} is not valid JSON`);
  }
  if (!Array.isArray(manifest?.frameworks)) fail(`previous ${MANIFEST_FILE} has no frameworks array`);
  const skills = [];
  const references = [];
  for (const fw of manifest.frameworks) {
    assertGrcSlug(fw?.slug, `previous ${MANIFEST_FILE} slug`);
    if (!Array.isArray(fw.references)) fail(`previous ${MANIFEST_FILE}: ${fw.slug} has no references array`);
    skills.push(fw.slug);
    for (const name of fw.references) {
      assertName(name, REFERENCE_RE, `previous ${MANIFEST_FILE} reference name`);
      assertName(`${fw.slug}-${name}`, REFERENCE_RE, `previous ${MANIFEST_FILE} reference file name`);
      references.push(`references/${fw.slug}-${name}.md`);
    }
  }
  return { skills, references };
}

async function pathExists(file) {
  return lstat(file).then(
    () => true,
    () => false,
  );
}

/**
 * Vendor the allowlisted frameworks from `cloneDir` at `sha` into `contentDir`.
 * @param {{ cloneDir: string, sha: string, contentDir: string, noticesFile: string, frameworks?: typeof FRAMEWORKS }} options
 */
export async function syncGrc({ cloneDir, sha, contentDir, noticesFile, frameworks = FRAMEWORKS }) {
  // ---- Phase 1: compute every output and run every gate in memory. ----
  if (!SHA_RE.test(String(sha))) fail(`commit must be the full 40-hex SHA, got ${JSON.stringify(sha)}`);
  const resolved = decodeUtf8(await git(cloneDir, ["rev-parse", "--verify", `${sha}^{commit}`]), "rev-parse").trim();
  if (resolved !== sha) fail(`${sha} is not a commit object (it peels to ${resolved})`);
  const commitDate = decodeUtf8(await git(cloneDir, ["log", "-1", "--format=%cI", sha]), "log").trim();

  const outputs = new Map();
  const manifestFrameworks = [];
  let referenceCount = 0;
  for (const framework of frameworks) {
    assertGrcSlug(framework.slug, `framework ${framework.upstream} slug`);
    const { skill, references } = await readFramework(cloneDir, sha, framework);
    const names = [...references.keys()];
    outputs.set(`skills/${framework.slug}/SKILL.md`, rewriteSkill(skill, framework, names, sha, `${framework.upstream}/SKILL.md`));
    for (const [name, text] of references) {
      const label = `${framework.upstream}/references/${name}.md`;
      const rewritten = rewriteCitations(text, framework.slug, names, label);
      assertNoLeftoverCitations(rewritten, names, label);
      outputs.set(`references/${framework.slug}-${name}.md`, rewritten);
      referenceCount += 1;
    }
    manifestFrameworks.push({ upstream: framework.upstream, slug: framework.slug, references: names });
  }
  const manifest = { repo: UPSTREAM_REPO, commit: sha, commitDate, frameworks: manifestFrameworks };

  const notices = await readFile(noticesFile, "utf8");
  const noticeLines = notices.split("\n");
  const headingAt = noticeLines.indexOf(NOTICES_HEADING);
  if (headingAt < 0) fail(`${noticesFile} has no section headed exactly "${NOTICES_HEADING}"`);
  const rest = noticeLines.slice(headingAt + 1);
  const nextHeading = rest.findIndex((line) => line.startsWith("## "));
  const section = (nextHeading < 0 ? rest : rest.slice(0, nextHeading)).join("\n");
  if (!section.includes(sha)) fail(`the notices section "${NOTICES_HEADING}" does not contain the commit ${sha}; update it first`);

  const manifestPath = path.join(contentDir, MANIFEST_FILE);
  const previousText = await readFile(manifestPath, "utf8").catch(() => null);
  const previous = previousText === null ? { skills: [], references: [] } : listedFiles(previousText);
  const listed = new Set([...previous.skills.map((slug) => `skills/${slug}/SKILL.md`), ...previous.references]);
  for (const target of outputs.keys()) {
    if (!listed.has(target) && (await pathExists(path.join(contentDir, target)))) {
      fail(`${target} already exists and the previous ${MANIFEST_FILE} does not list it; refusing to overwrite`);
    }
  }

  // ---- Phase 2: delete exactly what the previous manifest lists, then write. ----
  for (const rel of previous.references) await rm(path.join(contentDir, rel), { force: true });
  for (const slug of previous.skills) {
    await rm(path.join(contentDir, "skills", slug, "SKILL.md"), { force: true });
    await rmdir(path.join(contentDir, "skills", slug)).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
  for (const [rel, text] of outputs) {
    await mkdir(path.dirname(path.join(contentDir, rel)), { recursive: true });
    await writeFile(path.join(contentDir, rel), text, "utf8");
  }
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return { commit: sha, commitDate, skills: frameworks.length, references: referenceCount };
}

/**
 * CLI body. Returns the process exit code: 0 ok, 1 sync failure, 2 usage error.
 * @param {string[]} args
 * @param {{ pluginRoot: string, log: (line: string) => void, error: (line: string) => void }} io
 */
export async function runCli(args, { pluginRoot, log, error }) {
  if (args.length !== 2) {
    error("usage: node scripts/sync-grc.mjs <path-to-upstream-clone> <40-hex-commit-sha>");
    return 2;
  }
  try {
    const result = await syncGrc({
      cloneDir: path.resolve(args[0]),
      sha: args[1],
      contentDir: path.join(pluginRoot, "content"),
      noticesFile: path.join(pluginRoot, "THIRD_PARTY_NOTICES.md"),
    });
    log(
      `devkit sync-grc: wrote ${result.skills} skills + ${result.references} references at ${result.commit} (${result.commitDate}). Now run: node scripts/build-index.mjs`,
    );
    return 0;
  } catch (e) {
    error(`devkit sync-grc failed: ${e instanceof GrcSyncError ? e.message : e.stack}`);
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  process.exit(await runCli(process.argv.slice(2), { pluginRoot, log: console.log, error: console.error }));
}
