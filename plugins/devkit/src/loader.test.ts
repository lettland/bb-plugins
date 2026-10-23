import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadSkill, MAX_BODY_BYTES } from "./loader.mjs";

let dataRoot: string;

const hasJq = (() => {
  try {
    execFileSync("jq", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

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

const REVIEWER_LENSES = [
  "reviewer-senior-dev",
  "reviewer-senior-qa",
  "reviewer-security",
  "reviewer-end-user",
  "reviewer-compliance",
];

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

  it("cites only references that load, including all five reviewer calibrations", async () => {
    const cited = new Set(
      [...content.matchAll(/reference: "([a-z0-9-]+)"|`(reviewer-[a-z-]+)`/g)].map((m) => m[1] ?? m[2]),
    );
    for (const lens of REVIEWER_LENSES) {
      expect(cited).toContain(lens);
    }
    for (const reference of cited) {
      const loaded = await loadSkill(contentRoot, undefined, reference);
      expect(loaded.ok, reference).toBe(true);
    }
  });

  it.each(REVIEWER_LENSES)("%s calibration loads whole and keeps the output contract", async (lens) => {
    const r = await loadSkill(contentRoot, undefined, lens);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.truncated).toBe(false);
    for (const header of ["### Blockers", "### Concerns", "### Advisories", "### Verdict:"]) {
      expect(r.content, header).toContain(header);
    }
    expect(r.content).toContain("Always emit all four sections");
    expect(r.content).toContain("`(spec)`");
    expect(r.content).toContain("`(code)`");
    if (lens === "reviewer-compliance") {
      expect(r.content).toContain("Frameworks considered:");
      expect(r.content).toContain("Never skip a framework");
      expect(r.content).toContain("beats any statement that it does not");
      expect(r.content).toContain("product content the diff itself adds that shows it applies");
      expect(r.content).not.toContain("doc saying it applies");
      expect(r.content).toContain("Same-diff declarations carry zero weight; same-diff product content can only raise.");
      expect(r.content).toContain("carries zero weight in either direction");
      expect(r.content).not.toMatch(/marked `changed-in-diff` carries zero weight toward lowering/);
      expect(r.content).not.toContain("one saying a framework applies may raise it");
      expect(r.content).not.toContain("Same-diff claims that lower a rating");
      expect(r.content).not.toContain("only same-diff claims, or");
      expect(r.content).not.toContain("Same-diff claims about the project's own license and about which regimes apply");
      expect(r.content).not.toContain("a rule marked `changed-in-diff` carries zero weight.");
      expect(r.content).toContain("never from a same-diff declaration, and never from a claim that lowers");
      expect(r.content).not.toContain("applicability-gated");
      expect(r.content).not.toContain("not applicable:");
      expect(r.content).not.toMatch(/cap(ped)? at (an )?\*\*Advisory\*\*/);
      expect(r.content).toContain("one of two statuses");
      expect(r.content).not.toContain("When relevant");
      expect(r.content).toContain("One finding per issue");
    }
  });

  it("names every lens from the review-code table in skill routing and generated-file exclusion", async () => {
    const tableLenses = [...content.matchAll(/^\|[^|]*\| `(reviewer-[a-z-]+)`/gm)].map((m) => m[1]);
    expect(tableLenses.sort()).toEqual([...REVIEWER_LENSES].sort());
    for (const reference of ["review-skill-routing", "review-generated-file-exclusion"]) {
      const r = await loadSkill(contentRoot, undefined, reference);
      expect(r.ok, reference).toBe(true);
      if (!r.ok) continue;
      for (const lens of tableLenses) expect(r.content, `${reference} names ${lens}`).toContain(lens);
    }
  });

  it("carries the compliance Frameworks considered line into the consolidated summary", () => {
    const section4 = normalized.slice(normalized.indexOf("## 4."), normalized.indexOf("## 5."));
    expect(section4).toContain("`Frameworks considered:`");
  });

  it("reviewer-security covers every OWASP Top 10:2025 category and the CVE-handling rules", async () => {
    const r = await loadSkill(contentRoot, undefined, "reviewer-security");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const text = r.content.replace(/\s+/g, " ");
    for (const title of [
      "A01:2025 Broken Access Control",
      "A02:2025 Security Misconfiguration",
      "A03:2025 Software Supply Chain Failures",
      "A04:2025 Cryptographic Failures",
      "A05:2025 Injection",
      "A06:2025 Insecure Design",
      "A07:2025 Authentication Failures",
      "A08:2025 Software or Data Integrity Failures",
      "A09:2025 Security Logging and Alerting Failures",
      "A10:2025 Mishandling of Exceptional Conditions",
    ]) {
      expect(text, title).toContain(title);
    }
    // Every OWASP citation must carry an edition (A05:2025), never a bare A05.
    expect(text).not.toMatch(/\bA(0[1-9]|10)\b(?!:2025|:2021)/);
    expect(text).toContain("A06:2021");
    expect(text).toContain("A10:2021");
    expect(text).toContain("A09:2021");
    expect(text).toContain("`MAL-*`");
    expect(text).toContain("**Blocker**");
    expect(text).toContain("run no scanner and make no network call");
    const verdict = r.content.slice(r.content.indexOf("### Verdict:"));
    expect(verdict).toContain("CVE check:");
  });

  it("routes `security` to reviewer-security unconditionally, even with no stack keyword", async () => {
    const routing = await loadSkill(contentRoot, undefined, "review-skill-routing");
    expect(routing.ok).toBe(true);
    if (!routing.ok) return;
    const text = routing.content.replace(/\s+/g, " ");
    expect(text).toContain("`reviewer-security` gets `Stack skills: security`");
    expect(text).toContain("fixed slug");
    expect(text).toContain("unconditional");
    const security = await loadSkill(contentRoot, "security");
    expect(security.ok).toBe(true);
  });

  it("documents the orchestrator-side CVE lookup and keeps scanner names to one sentence", async () => {
    const r = await loadSkill(contentRoot, undefined, "review-cve-lookup");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const text = r.content.replace(/\s+/g, " ");
    expect(text).toContain("https://api.osv.dev/v1/querybatch");
    expect(text).toContain("DEVKIT_CVE_LOOKUP");
    expect(text).toContain("skip all Go as `private`");
    expect(text).toContain("--proto '=https'");
    expect(text).toContain("--fail-early");
    expect(text).toContain("Never read a raw response");
    expect(text).toContain("Any failure ends the lookup");
    expect(text).toContain("not run — plan review");
    const scanners = ["npm audit", "pip-audit", "cargo audit", "osv-scanner", "govulncheck"];
    const neverRun = text.match(/\*\*Never run\*\*[^.]*\./g) ?? [];
    expect(neverRun).toHaveLength(1);
    const [sentence = ""] = neverRun;
    const rest = text.replace(sentence, "");
    for (const scanner of scanners) {
      expect(sentence, scanner).toContain(scanner);
      expect(rest, scanner).not.toContain(scanner);
    }
  });

  it("keeps every CVE check status line in reviewer-security inside the lookup grammar", async () => {
    const security = await loadSkill(contentRoot, undefined, "reviewer-security");
    expect(security.ok).toBe(true);
    if (!security.ok) return;
    const lookup = await loadSkill(contentRoot, undefined, "review-cve-lookup");
    expect(lookup.ok).toBe(true);
    if (!lookup.ok) return;
    expect(lookup.content).toContain("api.osv.dev — N queried");
    const counts = String.raw`\d+ queried(, \d+ skipped \([^)]+\))?, \d+ hits?`;
    const grammar = new RegExp(
      String.raw`^(api\.osv\.dev — ${counts}|partial — ${counts}; .+|not run — .+|no dependency changes)$`,
    );
    const lines = [...security.content.matchAll(/`CVE check: ([^`]+)`/g)]
      .map((m) => (m[1] ?? "").trim())
      .filter((line) => !line.startsWith("<"));
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) expect(line, line).toMatch(grammar);
  });

  it("keeps backslash escapes out of every single-quoted jq program (fish turns `\\` into `\`)", async () => {
    const lookup = await loadSkill(contentRoot, undefined, "review-cve-lookup");
    expect(lookup.ok).toBe(true);
    if (!lookup.ok) return;
    const programs = lookup.content
      .split("\n")
      .filter((line) => line.startsWith("jq "))
      .flatMap((line) => [...line.matchAll(/'([^']*)'/g)].map((m) => m[1] ?? ""));
    expect(programs.length).toBeGreaterThanOrEqual(3);
    for (const program of programs) expect(program).not.toContain("\\\\");
  });

  it("has jq available on CI so the executable jq tests cannot be skipped there", () => {
    if (process.env.CI) expect(hasJq).toBe(true);
  });

  it.skipIf(!hasJq)("the Step 5 jq programs list valid hits and count paged results and bad IDs", async () => {
    const lookup = await loadSkill(contentRoot, undefined, "review-cve-lookup");
    expect(lookup.ok).toBe(true);
    if (!lookup.ok) return;
    const programs = [...lookup.content.matchAll(/^jq -r '([^']+)' "<run dir>\/batch\.json"$/gm)].map(
      (m) => m[1] ?? "",
    );
    expect(programs).toHaveLength(2);
    const dir = await mkdtemp(path.join(tmpdir(), "devkit-jq-"));
    try {
      const file = path.join(dir, "batch.json");
      await writeFile(
        file,
        JSON.stringify({
          results: [
            { vulns: [{ id: "GHSA-aaaa-bbbb-cccc" }] },
            {},
            { vulns: [{ id: "MAL-2024-1" }, { id: "bad id!" }], next_page_token: "t" },
          ],
        }),
      );
      const run = (program: string) => execFileSync("jq", ["-r", program, file], { encoding: "utf8" }).trimEnd();
      expect(run(programs[0] ?? "")).toBe("0\tGHSA-aaaa-bbbb-cccc\n2\tMAL-2024-1");
      expect(run(programs[1] ?? "")).toBe("1\t1");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it.skipIf(!hasJq)("the Step 6 jq extracts every fixed version, exact names, and aligned columns", async () => {
    const lookup = await loadSkill(contentRoot, undefined, "review-cve-lookup");
    expect(lookup.ok).toBe(true);
    if (!lookup.ok) return;
    const program = /--arg fre '<fixed-version regex>' '([^']+)'/.exec(lookup.content)?.[1];
    expect(program).toBeTruthy();
    // Each ecosystem's own fixed-version regex, read from the reference's Step 4.
    const npmRe = /- \*\*npm\*\*[\s\S]*?Version: `([^`]+)`/.exec(lookup.content)?.[1] ?? "";
    const pypiRe = /- \*\*PyPI\*\*[\s\S]*?Version \(PEP 440[^`]*`([^`]+)`/.exec(lookup.content)?.[1] ?? "";
    const goRe = /Fixed-version regex \(Step 6\): `([^`]+)`/.exec(lookup.content)?.[1] ?? "";
    for (const re of [npmRe, pypiRe, goRe]) expect(re).not.toBe("");
    const dir = await mkdtemp(path.join(tmpdir(), "devkit-jq-"));
    const run = async (eco: string, name: string, fre: string, record: object): Promise<string> => {
      const file = path.join(dir, "v.json");
      await writeFile(file, JSON.stringify(record));
      return execFileSync(
        "jq",
        ["-r", "--arg", "eco", eco, "--arg", "name", name, "--arg", "fre", fre, program ?? "", file],
        { encoding: "utf8" },
      ).trimEnd();
    };
    const affected = (eco: string, name: string, ...ranges: unknown[][]) => [
      {
        package: { ecosystem: eco, name },
        ranges: ranges.map(([from, fixed]) => ({ type: "SEMVER", events: [{ introduced: from }, { fixed }] })),
      },
    ];
    try {
      const multi = { id: "GHSA-aaaa-bbbb-cccc", database_specific: { severity: "high" } };
      expect(
        await run("npm", "foo", npmRe, {
          ...multi,
          affected: affected("npm", "foo", ["0", "1.2.3"], ["2.0.0", "2.0.5"]),
        }),
      ).toBe("GHSA-aaaa-bbbb-cccc\tHIGH\t1.2.3,2.0.5");
      expect(
        await run("npm", "foo", npmRe, {
          ...multi,
          affected: affected("npm", "foo", ["2.0.0", "1.10.0"], ["0", "1.9.2"]),
        }),
      ).toBe("GHSA-aaaa-bbbb-cccc\tHIGH\t1.9.2,1.10.0");
      expect(
        await run("npm", "foo", npmRe, {
          ...multi,
          affected: affected("npm", "foo", ["0", 5], ["1.0.0", "1.2.3"]),
        }),
      ).toBe("GHSA-aaaa-bbbb-cccc\tHIGH\t1.2.3");
      expect(
        await run("npm", "foo.bar", npmRe, { ...multi, affected: affected("npm", "foo-bar", ["0", "1.2.3"]) }),
      ).toBe("GHSA-aaaa-bbbb-cccc\tHIGH\tunknown");
      expect(
        await run("npm", "foo", npmRe, { ...multi, affected: affected("PyPI", "foo", ["0", "1.2.3"]) }),
      ).toBe("GHSA-aaaa-bbbb-cccc\tHIGH\tunknown");
      expect(
        await run("npm", "foo", npmRe, {
          id: "GHSA-aaaa-bbbb-cccc",
          database_specific: { severity: "moderate" },
          affected: affected("npm", "foo", ["0", "1.2.3"]),
        }),
      ).toBe("GHSA-aaaa-bbbb-cccc\tMODERATE\t1.2.3");
      expect(
        await run("PyPI", "foo-bar", pypiRe, {
          id: "PYSEC-2020-1",
          affected: affected("PyPI", "Foo_Bar", ["0", "1.0.1"]),
        }),
      ).toBe("PYSEC-2020-1\tunknown\t1.0.1");
      const goRecord = { id: "GO-2024-0001", affected: affected("Go", "example.com/x", ["0", "v1.2.4"]) };
      expect(await run("Go", "example.com/x", goRe, goRecord)).toBe("GO-2024-0001\tunknown\tv1.2.4");
      expect(await run("Go", "example.com/x", npmRe, goRecord)).toBe("GO-2024-0001\tunknown\tunknown");
      expect(await run("npm", "foo", npmRe, { id: "bad id!", affected: affected("npm", "foo", ["0", "1.2.3"]) })).toBe(
        "unknown\tunknown\t1.2.3",
      );
      expect(await run("npm", "foo", npmRe, { id: "GHSA-a..b", affected: affected("npm", "foo", ["0", "1.2.3"]) })).toBe(
        "unknown\tunknown\t1.2.3",
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("references the CVE lookup from review-code and carries the CVE check line in §4", () => {
    expect(normalized).toContain('devkit_load_skill({ reference: "review-cve-lookup" })');
    expect(normalized).toContain("The block goes to the security brief only.");
    const section4 = normalized.slice(normalized.indexOf("## 4."), normalized.indexOf("## 5."));
    expect(section4).toContain("`CVE check:`");
  });

  it("gives the closure reviewer and compliance the license-file hunks, patterns included", async () => {
    const r = await loadSkill(contentRoot, undefined, "review-generated-file-exclusion");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const text = r.content.replace(/\s+/g, " ");
    expect(text).toContain("closure reviewer");
    expect(text).toContain("`LICEN[CS]E*`");
  });

  it("keeps stale four-lens counts out of every skill that names the cohort", async () => {
    const stale = /\b(four|4)[- ](calibrated|reviewers?|lens(es)?)\b|security is one of four/;
    const scanned: string[] = [];
    for (const slug of await readdir(path.join(contentRoot, "skills"))) {
      const body = await readFile(path.join(contentRoot, "skills", slug, "SKILL.md"), "utf8").catch(() => "");
      const text = body.replace(/\s+/g, " ");
      if (!/reviewer-(senior-dev|senior-qa|security|end-user|compliance)|calibrated[\w -]{0,30}review/i.test(text)) continue;
      scanned.push(slug);
      expect(text, slug).not.toMatch(stale);
    }
    for (const slug of ["review-code", "planning", "security-auditor", "cmd-commit", "code-review"]) {
      expect(scanned, slug).toContain(slug);
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

  it("never skips a valid finding for being pre-existing, only for an unrelated named feature", async () => {
    const collapse = async (reference: string | undefined, slug?: string) => {
      const r = await loadSkill(contentRoot, slug, reference);
      expect(r.ok, reference ?? slug).toBe(true);
      return r.ok ? r.content.replace(/\s+/g, " ") : "";
    };
    const disposition = await collapse("review-finding-disposition");
    expect(disposition).toContain("**Pre-existing is not a reason to skip.**");
    expect(disposition).toContain("The only allowed skip for being pre-existing is **named feature + unrelated**");
    expect(disposition).toContain("Fix everything in the handed-over scope, whoever wrote it.");
    expect(disposition).not.toContain("is the user's to fix");
    expect(disposition).toContain("outside the files under review or the scope the caller set, or another party's in-flight edit");
    expect(disposition).toContain("_unrelated to named feature `<name>`_");
    expect(disposition).toContain("_outside review scope (reported)_");
    expect(disposition).toContain("highest severity first");
    expect(disposition).toContain("Report fixes to pre-existing code separately");
    expect(disposition).toContain("still needs rotation");
    expect(disposition).toContain("Only edits outside the scope the caller handed over, or ones that appear after the review started, are off-limits");
    expect(disposition).not.toContain("you did not write");
    expect(disposition).not.toContain("wrong, out of scope, or already handled");

    expect(normalized).toContain("excludes other parties' concurrent edits, not pre-existing code in the turn's files");
    expect(normalized).not.toContain("(auto-review: only your own work from this turn) or");
    expect(normalized).toContain(
      "findings unrelated to a named feature, or findings outside review scope (reported), with a one-line reason",
    );

    const compliance = await collapse("reviewer-compliance");
    expect(compliance).not.toContain("Pre-existing gaps in code the change does not touch are not findings");
    expect(compliance).toContain(
      "Every finding anchors to a file under review or a plan step.** Report pre-existing gaps in those files at their true severity; the orchestrator's disposition decides what is skipped",
    );
    expect(compliance).toContain("missing organizational documents are outside the diff");
    expect(compliance).toContain(
      "a concrete obligation breach in the code under review (introduced by this change or pre-existing)",
    );
    expect(compliance).toContain(
      "Blockers require a **concrete obligation breach in the files under review**, introduced by this change or pre-existing",
    );
    expect(compliance).toContain("the same issue on a line under review");
    expect(compliance).not.toContain("(see below)");
    expect(compliance).toContain("If no line in the files under review touches any framework's subject matter");
    expect(compliance).not.toContain("breach introduced by this change");
    expect(compliance).not.toContain("If no changed line touches");

    const codeReviewer = await collapse(undefined, "code-reviewer");
    expect(codeReviewer).toContain("Likely false positive");
    expect(codeReviewer).not.toContain("or pre-existing issue");
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

  it("ends the plan-scope review once the plan-approval call returns approved", () => {
    expect(normalized).toContain(
      "Skip steps 1 and 2 once the plan-approval call you made from plan mode for this plan has returned approved, and go to step 3.",
    );
    expect(normalized).toContain(
      "that is the approval and ends this review: implement then, without more closure rounds, EnterPlanMode, or presenting the plan again",
    );
  });

  it("hashes every hook directory git could run, plus the config snapshot and .gitignore files", () => {
    const section3Start = content.indexOf("## 3.");
    const section4Start = content.indexOf("## 4.");
    expect(section3Start).toBeGreaterThan(-1);
    expect(section4Start).toBeGreaterThan(-1);
    const section3 = content.slice(section3Start, section4Start).replace(/\s+/g, " ");
    expect(section3).toContain("git rev-parse HEAD");
    expect(section3).toContain("git symbolic-ref -q HEAD");
    expect(normalized).toContain("git config --list --show-origin --show-scope");
    expect(normalized).toContain("--git-common-dir");
    expect(normalized).toContain("core.hooksPath");
    expect(normalized).toContain("core.excludesFile");
    expect(normalized).toContain("find . -name .gitignore");
    expect(normalized).toContain("xargs -0 --no-run-if-empty shasum");
  });

  it("matches hookspath/excludesfile case-insensitively and resolves info/exclude absolutely", () => {
    expect(normalized).toContain("case-insensitively");
    expect(normalized).toContain("--git-path info/exclude");
  });

  it("uses mktemp -d for the run dir, with no broken BSD mktemp -u template anywhere in §3", () => {
    const section3Start = content.indexOf("## 3.");
    const section4Start = content.indexOf("## 4.");
    expect(section3Start).toBeGreaterThan(-1);
    expect(section4Start).toBeGreaterThan(-1);
    const section3 = content.slice(section3Start, section4Start);
    expect(normalized).toContain("mktemp -d");
    expect(section3).not.toMatch(/X{3,}\.\w/);
    expect(normalized).toContain("delete it once no further spawn attempt will read it");
  });

  it("cleans up the run dir without rm -r", () => {
    const section3Start = content.indexOf("## 3.");
    const section4Start = content.indexOf("## 4.");
    expect(section3Start).toBeGreaterThan(-1);
    expect(section4Start).toBeGreaterThan(-1);
    const section3 = content.slice(section3Start, section4Start);
    expect(normalized).toContain("rmdir");
    expect(section3).not.toContain("rm -r");
  });

  it("names bb thread delete --yes in SKILL.md", () => {
    expect(normalized).toContain("bb thread delete --yes");
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

  it("compares (d) by content never SHA, and never re-baselines on a benign config change", () => {
    expect(normalized).toContain("record (b)'s HEAD SHA instead of the word `HEAD`");
    expect(normalized).toContain("never by SHA equality");
    expect(normalized).toContain("never taking a new baseline");
  });

  it("the closure review's brief explicitly overrides §2 item 2's stop-on-failed-calibration rule", () => {
    expect(normalized).toContain("overrides §2 item 2");
  });

  it("slices the config/hooks/ignore (a) group and confirms hooks content precedes (b)", () => {
    const section3Start = content.indexOf("## 3.");
    const section4Start = content.indexOf("## 4.");
    expect(section3Start).toBeGreaterThan(-1);
    expect(section4Start).toBeGreaterThan(-1);
    const section3 = content.slice(section3Start, section4Start);
    const aStart = section3.indexOf("**a1.");
    const bStart = section3.indexOf("**b.");
    expect(aStart).toBeGreaterThan(-1);
    expect(bStart).toBeGreaterThan(-1);
    const aGroup = section3.slice(aStart, bStart);
    expect(aGroup).toContain("--git-common-dir");
    expect(aGroup).toContain("core.hooksPath");
  });

  it("orders the tree guard's a1-e baseline steps and compare steps 1 before 2 before 3", () => {
    const section3Start = content.indexOf("## 3.");
    const section4Start = content.indexOf("## 4.");
    expect(section3Start).toBeGreaterThan(-1);
    expect(section4Start).toBeGreaterThan(-1);
    const section3 = content.slice(section3Start, section4Start);
    const a1Idx = section3.indexOf("**a1. Config**");
    const bIdx = section3.indexOf("**b. Refs**");
    const cIdx = section3.indexOf("**c. Index**");
    const dIdx = section3.indexOf("**d. Tracked worktree content**");
    const eIdx = section3.indexOf("**e. Untracked content**");
    for (const idx of [a1Idx, bIdx, cIdx, dIdx, eIdx]) expect(idx).toBeGreaterThan(-1);
    expect(a1Idx).toBeLessThan(bIdx);
    expect(bIdx).toBeLessThan(cIdx);
    expect(cIdx).toBeLessThan(dIdx);
    expect(dIdx).toBeLessThan(eIdx);
    const step1Idx = section3.indexOf("1. Re-run a1");
    const step2Idx = section3.indexOf("2. Refs or the stash moved");
    const step3Idx = section3.indexOf("3. The index listing changed");
    expect(step1Idx).toBeGreaterThan(-1);
    expect(step2Idx).toBeGreaterThan(-1);
    expect(step3Idx).toBeGreaterThan(-1);
    expect(step1Idx).toBeLessThan(step2Idx);
    expect(step2Idx).toBeLessThan(step3Idx);
  });
});

describe("devkit README", () => {
  it("tells agents to delete a leaked-secret reviewer thread with bb thread delete --yes", async () => {
    const readmePath = path.join(import.meta.dirname, "..", "README.md");
    const text = await readFile(readmePath, "utf8");
    expect(text).toContain("bb thread delete --yes");
  });

  it("describes the compliance lens as capping, not demoting, unconfirmed findings", async () => {
    const readmePath = path.join(import.meta.dirname, "..", "README.md");
    const text = await readFile(readmePath, "utf8");
    expect(text).not.toContain("declared out of scope: Advisory");
    expect(text).toContain("capped at conditional Concerns");
  });

  it("loads the shipped review-delta-scope reference", async () => {
    const contentRoot = path.join(import.meta.dirname, "..", "content");
    const r = await loadSkill(contentRoot, undefined, "review-delta-scope");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.truncated).toBe(false);
      for (const phrase of [
        "manifest.tsv",
        "--no-index",
        "baseline <dir>",
        "**3 closure rounds**",
        "{ shasum -a 256 2>/dev/null || sha256sum; } | cut -c1-64",
        "not 64 hex characters",
        "## Promoting",
        "<hash>.pending",
        "/dev/null",
      ]) {
        expect(r.content).toContain(phrase);
      }
    }
  });
});
