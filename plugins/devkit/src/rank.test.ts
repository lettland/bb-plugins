import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { clampLimit, rankSkills } from "./rank.mjs";
import { tokenize } from "./text.mjs";
import type { SkillIndexEntry } from "./rank.mjs";

function entry(slug: string, description: string, keywords: string[], tokens?: string[]): SkillIndexEntry {
  return {
    slug,
    description,
    category: "x",
    keywords,
    tokens: tokens ?? [...new Set([...tokenize(slug), ...tokenize(description), ...keywords])],
  };
}

const corpus: SkillIndexEntry[] = [
  entry("go-essentials", "Go naming, errors, modules", ["golang"]),
  entry("go-testing", "Go tests, table-driven", []),
  entry("python-essentials", "Python typing, packaging", []),
];

describe("rankSkills", () => {
  it("ranks a keyword+token match ahead of the field", () => {
    expect(rankSkills(corpus, "golang errors", 5).map((h) => h.slug)).toMatchInlineSnapshot(`
      [
        "go-essentials",
      ]
    `);
  });

  it("weights a keyword hit above a token-only hit", () => {
    const entries = [
      entry("b-token-only", "", [], ["cache"]),
      entry("a-keyword", "", ["cache"], ["cache"]),
    ];
    // a-keyword scores 5 (keyword), b-token-only scores 2 (token) → keyword first
    expect(rankSkills(entries, "cache", 5).map((h) => h.slug)).toEqual(["a-keyword", "b-token-only"]);
  });

  it("gives an exact slug match the top spot via the slug bonus", () => {
    const entries = [
      entry("cache", "", [], []), // exact-slug bonus 10, no token/keyword hit
      entry("database-cache", "", ["cache"], ["cache"]), // keyword 5
    ];
    expect(rankSkills(entries, "cache", 5)[0]?.slug).toBe("cache");
  });

  it("returns nothing for an unrelated topic", () => {
    expect(rankSkills(corpus, "haskell monads", 5)).toEqual([]);
  });

  it("breaks score ties by slug ascending and respects the limit", () => {
    const tie = [entry("b-skill", "shared", []), entry("a-skill", "shared", [])];
    expect(rankSkills(tie, "shared", 1).map((h) => h.slug)).toEqual(["a-skill"]);
  });

  it("orders many tied entries by slug regardless of input order", () => {
    const tie = ["d-skill", "b-skill", "c-skill", "a-skill"].map((slug) => entry(slug, "shared", []));
    expect(rankSkills(tie, "shared", 10).map((h) => h.slug)).toEqual(["a-skill", "b-skill", "c-skill", "d-skill"]);
  });

  it("tolerates entries without keywords or tokens (older index shape)", () => {
    const legacy = [
      { slug: "cache", description: "no arrays", category: "x" },
      { slug: "other", description: "no arrays", category: "x" },
    ] as unknown as SkillIndexEntry[];
    // Only the exact-slug bonus can score; the missing arrays must not throw.
    expect(rankSkills(legacy, "cache", 5)).toEqual([{ slug: "cache", description: "no arrays" }]);
    expect(rankSkills(legacy, "anything", 5)).toEqual([]);
  });

  it("keeps duplicate slugs with equal scores (stable, no dedup)", () => {
    const dup = [entry("same", "first", ["kafka"]), entry("same", "second", ["kafka"])];
    expect(rankSkills(dup, "kafka", 5).map((h) => h.description)).toEqual(["first", "second"]);
  });
});

describe("clampLimit", () => {
  it("clamps to [1,25] with a default of 8 for non-positive/invalid input", () => {
    expect(clampLimit(3)).toBe(3);
    expect(clampLimit(25)).toBe(25);
    expect(clampLimit(999)).toBe(25);
    expect(clampLimit(0)).toBe(8);
    expect(clampLimit(-4)).toBe(8);
    expect(clampLimit(Number.NaN)).toBe(8);
    expect(clampLimit(undefined)).toBe(8);
  });
});

describe("rankSkills against the committed content/index.json", () => {
  const index = JSON.parse(
    readFileSync(path.join(import.meta.dirname, "..", "content", "index.json"), "utf8"),
  ) as { skills: SkillIndexEntry[] };

  // The vendored grc-* skills carry neutral descriptions so they cannot displace devkit's own
  // skills on generic queries. If one starts to, report it; do not tune a description alone.
  it.each([
    ["encryption", "secrets-kms"],
    ["audit logging", "cmd-audit"],
    ["security review", "review-code"],
  ])("ranks %s first as %s and keeps grc-* out of the top 3", (query, top) => {
    const hits = rankSkills(index.skills, query, 3).map((h) => h.slug);
    expect(hits[0]).toBe(top);
    expect(hits.some((slug) => slug.startsWith("grc-"))).toBe(false);
  });
});
