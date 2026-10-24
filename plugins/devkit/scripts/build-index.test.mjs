import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildIndex, generateEssentials } from "./build-index.mjs";
import { ESSENTIALS } from "../src/select-skills.mjs";

let root;

async function skill(slug, frontmatter, body = "body") {
  const dir = path.join(root, "skills", slug);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "SKILL.md"), `---\n${frontmatter}\n---\n\n${body}\n`);
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "devkit-index-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("buildIndex", () => {
  it("indexes a valid skill and derives its category + tokens", async () => {
    await skill(
      "go-essentials",
      "name: go-essentials\ndescription: Go naming, errors, modules\nmetadata:\n  type: language\n  keywords: [golang]",
    );
    const { entries, categories, errors } = await buildIndex(root);
    expect(errors).toEqual([]);
    expect(entries).toHaveLength(1);
    expect(entries[0].slug).toBe("go-essentials");
    expect(entries[0].category).toBe("language");
    expect(entries[0].keywords).toContain("golang");
    expect(entries[0].tokens).toContain("error");
    expect(categories).toEqual(["language"]);
  });

  it("derives category from the slug prefix, falling back to misc", async () => {
    await skill("rust-cli", "name: rust-cli\ndescription: Rust CLIs");
    await skill("x-thing", "name: x-thing\ndescription: single-char prefix");
    const { entries } = await buildIndex(root);
    const byslug = Object.fromEntries(entries.map((e) => [e.slug, e.category]));
    expect(byslug["rust-cli"]).toBe("rust");
    expect(byslug["x-thing"]).toBe("misc");
  });

  it("flags a name/dirname mismatch", async () => {
    await skill("go-essentials", "name: wrong-name\ndescription: x");
    const { errors } = await buildIndex(root);
    expect(errors.some((e) => e.includes("must equal directory name"))).toBe(true);
  });

  it("flags a missing frontmatter block", async () => {
    const dir = path.join(root, "skills", "no-fm");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "SKILL.md"), "# no frontmatter here\n");
    const { errors } = await buildIndex(root);
    expect(errors.some((e) => e.includes("no frontmatter"))).toBe(true);
  });

  it("flags an over-long description", async () => {
    await skill("long-desc", `name: long-desc\ndescription: ${"x".repeat(1025)}`);
    const { errors } = await buildIndex(root);
    expect(errors.some((e) => e.includes("description exceeds"))).toBe(true);
  });

  it("flags a skill directory missing SKILL.md", async () => {
    await mkdir(path.join(root, "skills", "empty-dir"), { recursive: true });
    const { errors } = await buildIndex(root);
    expect(errors.some((e) => e.includes("missing SKILL.md"))).toBe(true);
  });

  it("flags unparseable YAML frontmatter", async () => {
    await skill("bad-yaml", "name: bad-yaml\ndescription: \"unterminated");
    const { errors } = await buildIndex(root);
    expect(errors.some((e) => e.includes("unparseable frontmatter"))).toBe(true);
  });

  it("reports a missing skills directory rather than throwing", async () => {
    const { entries, errors } = await buildIndex(path.join(root, "nope"));
    expect(entries).toEqual([]);
    expect(errors.some((e) => e.includes("content skills dir missing"))).toBe(true);
  });

  it("skips plain files in the skills dir and sorts the rest by slug", async () => {
    await skill("aaa-skill", "name: aaa-skill\ndescription: Aaa");
    await skill("mmm-skill", "name: mmm-skill\ndescription: Mmm");
    await skill("zzz-skill", "name: zzz-skill\ndescription: Zzz");
    await writeFile(path.join(root, "skills", "README.md"), "# not a skill\n");
    const { entries, errors } = await buildIndex(root);
    expect(errors).toEqual([]);
    expect(entries.map((e) => e.slug)).toEqual(["aaa-skill", "mmm-skill", "zzz-skill"]);
  });

  it("flags an unclosed frontmatter block", async () => {
    const dir = path.join(root, "skills", "unclosed");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "SKILL.md"), "---\nname: unclosed\ndescription: never closed\n");
    const { errors } = await buildIndex(root);
    expect(errors).toEqual(["unclosed: no frontmatter block"]);
  });

  it("flags frontmatter that parses to a non-object", async () => {
    await skill("scalar-fm", "just a scalar");
    const { errors } = await buildIndex(root);
    expect(errors).toEqual(["scalar-fm: no frontmatter block"]);
  });

  it("flags empty frontmatter", async () => {
    await skill("empty-fm", "");
    const { errors } = await buildIndex(root);
    expect(errors).toEqual(["empty-fm: no frontmatter block"]);
  });

  it("flags a non-string name and a non-string description", async () => {
    await skill("num-meta", "name: 42\ndescription: 42");
    const { errors } = await buildIndex(root);
    expect(errors).toEqual([
      "num-meta: frontmatter name '' must equal directory name",
      "num-meta: empty description",
    ]);
  });

  it("flags a slug that violates the name pattern", async () => {
    await skill("Bad_Slug", "name: Bad_Slug\ndescription: Bad");
    const { errors } = await buildIndex(root);
    expect(errors).toEqual(["Bad_Slug: slug violates the name pattern"]);
  });
});

describe("buildIndex sorting", () => {
  it("sorts entries by slug even when readdir returns them out of order", async () => {
    await skill("zzz-skill", "name: zzz-skill\ndescription: Zzz");
    await skill("aaa-skill", "name: aaa-skill\ndescription: Aaa");
    vi.resetModules();
    vi.doMock("node:fs/promises", async (importOriginal) => {
      const actual = await importOriginal();
      return {
        ...actual,
        readdir: async (dir, opts) => {
          const found = await actual.readdir(dir, opts);
          return found.reverse();
        },
      };
    });
    try {
      const { buildIndex: freshBuildIndex } = await import("./build-index.mjs");
      const { entries } = await freshBuildIndex(root);
      expect(entries.map((e) => e.slug)).toEqual(["aaa-skill", "zzz-skill"]);
    } finally {
      vi.doUnmock("node:fs/promises");
      vi.resetModules();
    }
  });
});

describe("buildIndex yaml failures", () => {
  it("reports a non-Error yaml throw as unparseable frontmatter", async () => {
    await skill("boom-skill", "name: boom-skill\ndescription: fine");
    vi.resetModules();
    vi.doMock("js-yaml", async (importOriginal) => {
      const actual = await importOriginal();
      return { ...actual, default: { ...actual.default, load: () => { throw "yaml boom"; } } };
    });
    try {
      const { buildIndex: freshBuildIndex } = await import("./build-index.mjs");
      const { errors } = await freshBuildIndex(root);
      expect(errors).toEqual(["boom-skill: unparseable frontmatter (yaml boom)"]);
    } finally {
      vi.doUnmock("js-yaml");
      vi.resetModules();
    }
  });
});

describe("committed index invariant", () => {
  it("content/index.json matches a fresh build (skills + categories)", async () => {
    const contentDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "content");
    const { entries, categories, errors } = await buildIndex(contentDir);
    expect(errors).toEqual([]);
    const committed = JSON.parse(await readFile(path.join(contentDir, "index.json"), "utf8"));
    expect(committed.categories).toEqual(categories);
    expect(committed.skills).toEqual(entries);
  });

  it("generated essentials (Tier-C) match their content/ source bodies and have no extras", async () => {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    for (const slug of ESSENTIALS) {
      const src = await readFile(path.join(root, "content", "skills", slug, "SKILL.md"), "utf8");
      const gen = await readFile(path.join(root, "skills-generated", slug, "SKILL.md"), "utf8");
      expect(gen).toBe(src);
    }
    const generatedDirs = (await readdir(path.join(root, "skills-generated"), { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
    expect(generatedDirs).toEqual([...ESSENTIALS].sort());
  });
});

describe("generateEssentials", () => {
  it("copies only the listed slugs and cleans up ones dropped from the list", async () => {
    await skill("foo", "name: foo\ndescription: Foo");
    await skill("bar", "name: bar\ndescription: Bar");
    const out = path.join(root, "gen");

    await generateEssentials(root, out, ["foo", "bar"]);
    expect((await readdir(out)).sort()).toEqual(["bar", "foo"]);
    expect(await readFile(path.join(out, "foo", "SKILL.md"), "utf8")).toContain("Foo");

    await generateEssentials(root, out, ["foo"]);
    expect(await readdir(out)).toEqual(["foo"]);
  });
});

describe("main entrypoint", () => {
  async function contentSkill(contentDir, slug, frontmatter) {
    const dir = path.join(contentDir, "skills", slug);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "SKILL.md"), `---\n${frontmatter}\n---\n\nbody\n`);
  }

  /**
   * Run the author-time CLI against a fixture root. process.argv[1] is pointed at a fake script
   * path inside the fixture and fileURLToPath is mocked to return it, so the module's own argv
   * check fires and main() resolves its content dir to <fixtureRoot>/content. The exit stub
   * throws a sentinel on its first `exitThrowCount` calls so main stops deterministically at the
   * first process.exit, then returns so the module's own .catch handler completes. Waits for the
   * terminal observable (the success log or the first exit), snapshots the calls, restores all.
   */
  async function runAsMain(fixtureRoot, { writeFileRejection, exitThrowCount = 0 } = {}) {
    const fakeScript = path.join(fixtureRoot, "scripts", "build-index.mjs");
    const sentinel = new Error("fake process.exit");
    let exitCalls = 0;
    const exit = vi.spyOn(process, "exit").mockImplementation(() => {
      exitCalls += 1;
      if (exitCalls <= exitThrowCount) throw sentinel;
      return undefined;
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.doMock("node:url", async (importOriginal) => {
      const actual = await importOriginal();
      return { ...actual, fileURLToPath: () => fakeScript };
    });
    if (writeFileRejection !== undefined) {
      vi.doMock("node:fs/promises", async (importOriginal) => {
        const actual = await importOriginal();
        return { ...actual, writeFile: () => Promise.reject(writeFileRejection) };
      });
    }
    const prevArgv = process.argv[1];
    process.argv[1] = fakeScript;
    let snap;
    try {
      vi.resetModules();
      await import("./build-index.mjs");
      for (let i = 0; i < 1000 && exitCalls === 0 && log.mock.calls.length === 0; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      snap = {
        exit: exit.mock.calls.map((c) => [...c]),
        log: log.mock.calls.map((c) => [...c]),
        error: error.mock.calls.map((c) => [...c]),
      };
    } finally {
      process.argv[1] = prevArgv;
      vi.doUnmock("node:url");
      if (writeFileRejection !== undefined) vi.doUnmock("node:fs/promises");
      vi.resetModules();
      vi.restoreAllMocks();
    }
    return snap;
  }

  it("regenerates index.json and the native essentials from a fixture content dir", async () => {
    const contentDir = path.join(root, "content");
    for (const slug of ESSENTIALS) await contentSkill(contentDir, slug, `name: ${slug}\ndescription: ${slug} guidance`);
    await contentSkill(contentDir, "extra-skill", "name: extra-skill\ndescription: Extra guidance");
    const snap = await runAsMain(root);
    expect(snap.exit).toEqual([]);
    expect(snap.error).toEqual([]);
    expect(snap.log).toEqual([
      ["devkit build-index: wrote content/index.json (7 skills, 7 categories) + 6 native essentials"],
    ]);
    const index = JSON.parse(await readFile(path.join(contentDir, "index.json"), "utf8"));
    expect(index.generatedAt).toBe(new Date(index.generatedAt).toISOString());
    expect(index.skills.map((s) => s.slug)).toEqual([...ESSENTIALS, "extra-skill"].sort());
    expect(index.categories).toEqual(["debugging", "extra", "go", "python", "security", "testing", "typescript"]);
    const genRoot = path.join(root, "skills-generated");
    expect((await readdir(genRoot)).sort()).toEqual([...ESSENTIALS].sort());
    for (const slug of ESSENTIALS) {
      expect(await readFile(path.join(genRoot, slug, "SKILL.md"), "utf8")).toContain(`${slug} guidance`);
    }
  });

  it("reports validation errors, exits 1, and writes no index", async () => {
    const contentDir = path.join(root, "content");
    await contentSkill(contentDir, "mismatch", "name: other\ndescription: Mismatched");
    const snap = await runAsMain(root, { exitThrowCount: 1 });
    expect(snap.exit[0]).toEqual([1]);
    expect(snap.error[0][0]).toBe("devkit build-index: 1 skill validation error(s):");
    expect(snap.error[1][0]).toBe("  - mismatch: frontmatter name 'other' must equal directory name");
    expect(snap.error[2][0]).toContain("devkit build-index failed");
    expect(snap.log).toEqual([]);
    await expect(readFile(path.join(contentDir, "index.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails loudly when generating the essentials hits a missing slug", async () => {
    const contentDir = path.join(root, "content");
    await contentSkill(contentDir, "plain-skill", "name: plain-skill\ndescription: Plain");
    const snap = await runAsMain(root);
    expect(snap.exit).toEqual([[1]]);
    expect(snap.log).toEqual([]);
    expect(snap.error).toHaveLength(1);
    expect(snap.error[0][0]).toContain("devkit build-index failed:");
    expect(snap.error[0][0]).toContain("ENOENT");
  });

  it("prints a non-Error rejection as a string", async () => {
    const contentDir = path.join(root, "content");
    for (const slug of ESSENTIALS) await contentSkill(contentDir, slug, `name: ${slug}\ndescription: ${slug} guidance`);
    const snap = await runAsMain(root, { writeFileRejection: "disk boom" });
    expect(snap.exit).toEqual([[1]]);
    expect(snap.error).toEqual([["devkit build-index failed: disk boom"]]);
  });
});
