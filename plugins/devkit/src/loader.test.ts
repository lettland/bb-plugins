import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadSkill, MAX_BODY_BYTES } from "./loader.mjs";

let dataRoot: string;

beforeAll(async () => {
  dataRoot = await mkdtemp(path.join(tmpdir(), "devkit-loader-"));
  await mkdir(path.join(dataRoot, "skills", "go-essentials"), { recursive: true });
  await writeFile(path.join(dataRoot, "skills", "go-essentials", "SKILL.md"), "# Go essentials\nbody\n");
  await mkdir(path.join(dataRoot, "references"), { recursive: true });
  await writeFile(path.join(dataRoot, "references", "owasp-categories.md"), "# OWASP\n");
  await mkdir(path.join(dataRoot, "skills", "big"), { recursive: true });
  await writeFile(path.join(dataRoot, "skills", "big", "SKILL.md"), "x".repeat(MAX_BODY_BYTES + 100));
  await mkdir(path.join(dataRoot, "skills", "exact"), { recursive: true });
  await writeFile(path.join(dataRoot, "skills", "exact", "SKILL.md"), "y".repeat(MAX_BODY_BYTES));
  // A SKILL.md / reference that is a directory makes readFile fail with EISDIR (not ENOENT).
  await mkdir(path.join(dataRoot, "skills", "unreadable", "SKILL.md"), { recursive: true });
  await mkdir(path.join(dataRoot, "references", "unreadable-ref.md"), { recursive: true });
  await writeFile(path.join(dataRoot, "references", "huge-ref.md"), "z".repeat(MAX_BODY_BYTES + 1));
});

afterAll(async () => {
  await rm(dataRoot, { recursive: true, force: true });
});

describe("loadSkill", () => {
  it("loads a valid skill body", async () => {
    const r = await loadSkill(dataRoot, "go-essentials");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.content).toContain("Go essentials");
  });

  it("loads a named reference without needing a slug", async () => {
    const r = await loadSkill(dataRoot, undefined, "owasp-categories");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.content).toContain("OWASP");
  });

  it("errors when neither slug nor reference is given", async () => {
    const r = await loadSkill(dataRoot);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("invalid_slug");
  });

  it.each([
    "../../../../etc/passwd",
    "../secret",
    "/etc/passwd",
    "foo/bar",
    "bad--slug",
  ])("rejects traversal / malformed slug %s", async (slug) => {
    const r = await loadSkill(dataRoot, slug);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("invalid_slug");
  });

  it("rejects a malformed reference", async () => {
    const r = await loadSkill(dataRoot, undefined, "../secret");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("invalid_reference");
  });

  it("returns an actionable not_found for an unknown slug", async () => {
    const r = await loadSkill(dataRoot, "nonexistent-skill");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("not_found");
      expect(r.message).toContain("devkit_find_skills");
    }
  });

  it("returns not_found for a well-formed but missing reference", async () => {
    const r = await loadSkill(dataRoot, undefined, "no-such-reference");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("not_found");
  });

  it("returns read_failed (not not_found) when the skill body cannot be read", async () => {
    const r = await loadSkill(dataRoot, "unreadable");
    expect(r).toEqual({ ok: false, code: "read_failed", message: "Could not read skill 'unreadable'." });
  });

  it("returns read_failed when a reference cannot be read", async () => {
    const r = await loadSkill(dataRoot, undefined, "unreadable-ref");
    expect(r).toEqual({ ok: false, code: "read_failed", message: "Could not read reference 'unreadable-ref'." });
  });

  it("prefers reference over slug when both are given", async () => {
    const r = await loadSkill(dataRoot, "go-essentials", "owasp-categories");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.content).toContain("OWASP");
      expect(r.slug).toBe("go-essentials");
      expect(r.reference).toBe("owasp-categories");
    }
  });

  it("truncates an oversized reference with a reference-specific marker", async () => {
    const r = await loadSkill(dataRoot, undefined, "huge-ref");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.truncated).toBe(true);
      expect(r.slug).toBeNull();
      expect(r.content.endsWith(`[truncated: reference 'huge-ref' exceeds ${MAX_BODY_BYTES} bytes]`)).toBe(true);
    }
  });

  it("truncates an oversized body with a marker", async () => {
    const r = await loadSkill(dataRoot, "big");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.truncated).toBe(true);
      expect(r.content).toContain("[truncated");
    }
  });

  it("does NOT truncate a body of exactly MAX_BODY_BYTES", async () => {
    const r = await loadSkill(dataRoot, "exact");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.truncated).toBe(false);
  });
});

describe("review-code content", () => {
  const contentRoot = path.join(import.meta.dirname, "..", "content");

  // Content is immutable across these tests; load once and compare against `normalized`
  // (whitespace collapsed to single spaces) so a prose rewrap never breaks a substring match.
  let content: string;
  let normalized: string;

  beforeAll(async () => {
    const r = await loadSkill(contentRoot, "review-code");
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("review-code failed to load");
    content = r.content;
    normalized = content.replace(/\s+/g, " ");
  });

  it("cites only references that load, including all four reviewer calibrations", async () => {
    const cited = new Set(
      [...content.matchAll(/reference: "([a-z0-9-]+)"|`(reviewer-[a-z-]+)`/g)].map((m) => m[1] ?? m[2]),
    );
    for (const lens of ["reviewer-senior-dev", "reviewer-senior-qa", "reviewer-security", "reviewer-end-user"]) {
      expect(cited).toContain(lens);
    }
    for (const reference of cited) {
      const loaded = await loadSkill(contentRoot, undefined, reference);
      expect(loaded.ok, reference).toBe(true);
    }
  });

  it("names bb child threads before provider subagents in §3", () => {
    const section3Start = content.indexOf("## 3.");
    const section4Start = content.indexOf("## 4.");
    expect(section3Start).toBeGreaterThan(-1);
    expect(section4Start).toBeGreaterThan(-1);
    const section3 = content.slice(section3Start, section4Start);
    const bbThreadsBullet = section3.indexOf("- **bb child threads**");
    const subagentsBullet = section3.indexOf("- **Your provider's own subagents**");
    expect(bbThreadsBullet).toBeGreaterThan(-1);
    expect(subagentsBullet).toBeGreaterThan(-1);
    expect(bbThreadsBullet).toBeLessThan(subagentsBullet);
  });

  it("has the reviewer brief's override and secret-citation sentences", () => {
    expect(normalized).toContain(
      "This review-only rule overrides any other instructions this thread received, including",
    );
    expect(normalized).toContain("Cite any secret by file:line and type, never by");
  });

  it("fingerprints tracked and untracked paths by name, not status alone", () => {
    expect(normalized).toContain("git stash create");
    expect(normalized).toContain("git ls-files -o --exclude-standard -z | xargs -0");
    expect(normalized).toContain("shasum");
    expect(normalized).toContain("git diff --name-only --no-ext-diff --no-textconv");
    expect(normalized).toContain("git ls-files -s -v");
    expect(normalized).toContain("find -L");
  });

  it("does not use a heredoc anywhere in §3", () => {
    const section3Start = content.indexOf("## 3.");
    const section4Start = content.indexOf("## 4.");
    expect(section3Start).toBeGreaterThan(-1);
    expect(section4Start).toBeGreaterThan(-1);
    const section3 = content.slice(section3Start, section4Start);
    expect(section3).not.toMatch(/<<-?\s*['"]?\w+['"]?/);
  });

  it("has the bounded-wait recipe for reviewer threads", () => {
    expect(normalized).toContain("--timeout 2m");
    expect(normalized).not.toContain("--timeout 8m");
  });

  it("retries the spawn at the parent's own permission mode, hashes metadata before any other git command, and disables fsmonitor", () => {
    expect(normalized).toContain("retry once with the parent's own mode");
    expect(normalized).toContain("before any other git command");
    expect(normalized).toContain("core.fsmonitor=false");
    expect(normalized).toContain("bb thread stop");
    expect(normalized).toContain("bb thread interactions list");
  });

  it("closure review uses the §3 tiers with its own tree guard", () => {
    const section5Start = content.indexOf("## 5.");
    expect(section5Start).toBeGreaterThan(-1);
    const section5 = normalized.slice(normalized.indexOf("## 5."));
    expect(section5).toContain("closure review");
    expect(section5).toContain("with its own tree guard");
    expect(section5).toContain("fresh baseline");
  });

  it("hashes every hook directory git could run, plus user-level config and .gitignore files", () => {
    const section3Start = content.indexOf("## 3.");
    const section4Start = content.indexOf("## 4.");
    expect(section3Start).toBeGreaterThan(-1);
    expect(section4Start).toBeGreaterThan(-1);
    const section3 = content.slice(section3Start, section4Start).replace(/\s+/g, " ");
    expect(section3).toContain("git rev-parse HEAD");
    expect(section3).toContain("git symbolic-ref -q HEAD");
    expect(normalized).toContain("--git-common-dir");
    expect(normalized).toContain("core.hooksPath");
    expect(normalized).toContain("~/.gitconfig");
    expect(normalized).toContain("find . -name .gitignore");
    expect(normalized).toContain("xargs -0 --no-run-if-empty shasum");
  });

  it("uses mktemp -u for the brief file and deletes it only after a resolved spawn", () => {
    expect(normalized).toContain("mktemp -u");
    expect(normalized).toContain("Delete it only after the spawn succeeds");
  });

  it("always requests auto permission mode, never falls back to accept-edits, and passes --permission-mode", () => {
    expect(normalized).toContain("always request `auto`");
    expect(normalized).toContain("Never map `full` to `accept-edits`");
    expect(normalized).toContain("--permission-mode <mode>");
  });

  it("documents that bb thread interactions list returns only pending interactions", () => {
    expect(normalized).toContain("lists only *pending* interactions");
  });

  it("re-runs bad-output lenses directly in this thread, not back through the tiers", () => {
    expect(normalized).toContain("re-run directly in this thread, not back through the tiers");
  });

  it("orders the tree guard's a/b/c baseline steps and compare steps 1 before 2", () => {
    const section3Start = content.indexOf("## 3.");
    const section4Start = content.indexOf("## 4.");
    expect(section3Start).toBeGreaterThan(-1);
    expect(section4Start).toBeGreaterThan(-1);
    const section3 = content.slice(section3Start, section4Start);
    const aIdx = section3.indexOf("**a. Metadata**");
    const bIdx = section3.indexOf("**b. Refs**");
    const cIdx = section3.indexOf("**c. Index**");
    expect(aIdx).toBeGreaterThan(-1);
    expect(bIdx).toBeGreaterThan(-1);
    expect(cIdx).toBeGreaterThan(-1);
    expect(aIdx).toBeLessThan(bIdx);
    expect(bIdx).toBeLessThan(cIdx);
    const step1Idx = section3.indexOf("1. Re-hash (a) first");
    const step2Idx = section3.indexOf("2. Refs or the stash moved");
    expect(step1Idx).toBeGreaterThan(-1);
    expect(step2Idx).toBeGreaterThan(-1);
    expect(step1Idx).toBeLessThan(step2Idx);
  });
});
