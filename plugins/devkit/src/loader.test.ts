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

  it("cites only references that load, including all four reviewer calibrations", async () => {
    const r = await loadSkill(contentRoot, "review-code");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const cited = new Set(
      [...r.content.matchAll(/reference: "([a-z0-9-]+)"|`(reviewer-[a-z-]+)`/g)].map((m) => m[1] ?? m[2]),
    );
    for (const lens of ["reviewer-senior-dev", "reviewer-senior-qa", "reviewer-security", "reviewer-end-user"]) {
      expect(cited).toContain(lens);
    }
    for (const reference of cited) {
      const loaded = await loadSkill(contentRoot, undefined, reference);
      expect(loaded.ok, reference).toBe(true);
    }
  });
});
