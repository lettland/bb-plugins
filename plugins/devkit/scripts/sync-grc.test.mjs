import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FRAMEWORKS,
  MANIFEST_FILE,
  NOTICES_HEADING,
  UPSTREAM_REPO,
  assertVisibleContent,
  listedFiles,
  rewriteCitations,
  runCli,
  syncGrc,
} from "./sync-grc.mjs";

const COMMIT_DATE = "2026-01-02T03:04:05Z";

const ALPHA = { upstream: "alpha", slug: "grc-alpha", description: "Alpha pack (vendored): it's a test; use for Alpha questions." };
const BETA = { upstream: "beta", slug: "grc-beta", description: "Beta pack (vendored): second framework." };

const ALPHA_SKILL = [
  "---",
  "name: alpha",
  "description: >",
  "  Upstream text that it's",
  "  triggers a lot.",
  "---",
  "",
  "# Alpha",
  "",
  "Prose: read `references/guide.md` for detail.",
  "Bold: **`references/guide.md`** and also this.",
  "| Task | → `references/other-ref.md` |",
  "- `references/guide.md` — bullet",
  "Bare backticked: load `other-ref.md` first.",
  "Bare prose: Section in guide.md applies; dpa-template.md and my-guide.md and x_guide.md are not ours.",
  "",
].join("\n");

const ALPHA_SKILL_EXPECTED = [
  "---",
  "name: grc-alpha",
  "description: 'Alpha pack (vendored): it''s a test; use for Alpha questions.'",
  "metadata:",
  "  type: grc",
  "---",
  "",
  "> Vendored from Sushegaad/Claude-Skills-Governance-Risk-and-Compliance@SHA (MIT); not legal advice. Do not edit; re-run scripts/sync-grc.mjs.",
  "",
  "# Alpha",
  "",
  'Prose: read `devkit_load_skill({ reference: "grc-alpha-guide" })` for detail.',
  'Bold: **`devkit_load_skill({ reference: "grc-alpha-guide" })`** and also this.',
  '| Task | → `devkit_load_skill({ reference: "grc-alpha-other-ref" })` |',
  '- `devkit_load_skill({ reference: "grc-alpha-guide" })` — bullet',
  'Bare backticked: load `devkit_load_skill({ reference: "grc-alpha-other-ref" })` first.',
  'Bare prose: Section in devkit_load_skill({ reference: "grc-alpha-guide" }) applies; dpa-template.md and my-guide.md and x_guide.md are not ours.',
  "",
].join("\n");

const ALPHA_GUIDE = "# Guide\n\nSee `references/other-ref.md` and other-ref.md. Compare 1 < 2 and a<b.\n";
const ALPHA_OTHER = "# Other\n\nPlain text ❤\uFE0F with an emoji variation selector (U+FE0F).\n";
const BETA_SKILL = '---\nname: beta\ndescription: "Quote \\"d\\" desc"\n---\nBeta body `references/one.md` here.\n';
const BETA_ONE = "# One\n";

const execEnv = () => {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) if (!key.startsWith("GIT_")) env[key] = value;
  return env;
};

let root;
let cloneDir;
let contentDir;
let noticesFile;
let gitEnv;

function git(...args) {
  return execFileSync(
    "git",
    ["-C", cloneDir, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", ...args],
    { env: gitEnv, encoding: "utf8" },
  ).trim();
}

/** Replace the whole fixture tree with `files` and commit it. A value is text, a Buffer, { symlink } or { gitlink }. */
async function commit(files) {
  for (const entry of await readdir(cloneDir)) if (entry !== ".git") await rm(path.join(cloneDir, entry), { recursive: true, force: true });
  const gitlinks = [];
  for (const [file, value] of Object.entries(files)) {
    const target = path.join(cloneDir, file);
    await mkdir(path.dirname(target), { recursive: true });
    if (typeof value === "object" && !Buffer.isBuffer(value) && "symlink" in value) await symlink(value.symlink, target);
    else if (typeof value === "object" && !Buffer.isBuffer(value)) gitlinks.push([file, value.gitlink]);
    else await writeFile(target, value);
  }
  git("add", "-A");
  for (const [file, sha] of gitlinks) git("update-index", "--add", "--cacheinfo", `160000,${sha},${file}`);
  git("commit", "-q", "--allow-empty", "-m", "fixture");
  return git("rev-parse", "HEAD");
}

const tree = (upstream, skill, refs) => ({
  [`plugins/${upstream}/skills/${upstream}/SKILL.md`]: skill,
  ...Object.fromEntries(Object.entries(refs).map(([name, text]) => [`plugins/${upstream}/skills/${upstream}/references/${name}.md`, text])),
});

const goodFiles = () => ({
  ...tree("alpha", ALPHA_SKILL, { guide: ALPHA_GUIDE, "other-ref": ALPHA_OTHER }),
  ...tree("beta", BETA_SKILL, { one: BETA_ONE }),
});

async function writeNotices(...shas) {
  const body = shas.map((sha) => `- commit \`${sha}\``).join("\n");
  await writeFile(
    noticesFile,
    `# Notices\n\n## Other (MIT)\n\nOther text.\n\n---\n\n${NOTICES_HEADING}\n\n${body}\n\n---\n\n## Later (MIT)\n\nLater text.\n`,
  );
}

const sync = (sha, frameworks = [ALPHA, BETA]) => syncGrc({ cloneDir, sha, contentDir, noticesFile, frameworks });

async function snapshot(dir = contentDir) {
  const out = {};
  for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
    const full = path.join(entry.parentPath, entry.name);
    out[path.relative(dir, full)] = entry.isDirectory() ? "<dir>" : await readFile(full, "utf8");
  }
  return out;
}

/** Sync the good tree, then expect the next commit (the broken tree) to fail and leave the output untouched. */
async function expectFailure(files, matcher, { frameworks = [ALPHA, BETA], before } = {}) {
  const good = await commit(goodFiles());
  await writeNotices(good);
  await sync(good);
  const bad = await commit(files);
  await writeNotices(good, bad);
  if (before !== undefined) await before();
  const snap = await snapshot();
  await expect(sync(bad, frameworks)).rejects.toThrow(matcher);
  expect(await snapshot()).toEqual(snap);
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "devkit-sync-grc-"));
  cloneDir = path.join(root, "upstream");
  contentDir = path.join(root, "content");
  noticesFile = path.join(root, "THIRD_PARTY_NOTICES.md");
  const home = path.join(root, "home");
  await mkdir(home);
  await writeFile(path.join(home, ".gitconfig"), "");
  await mkdir(cloneDir);
  await mkdir(path.join(contentDir, "skills"), { recursive: true });
  await mkdir(path.join(contentDir, "references"), { recursive: true });
  gitEnv = {
    ...execEnv(),
    HOME: home,
    GIT_CONFIG_GLOBAL: path.join(home, ".gitconfig"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_DATE: "2026-01-02T03:04:05+00:00",
    GIT_COMMITTER_DATE: "2026-01-02T03:04:05+00:00",
  };
  git("init", "-q", "-b", "main");
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

describe("syncGrc happy path", () => {
  it("rewrites citations, edits the frontmatter, writes the header, the references and the manifest", async () => {
    const sha = await commit(goodFiles());
    await writeNotices(sha);
    const result = await sync(sha);
    expect(result).toEqual({ commit: sha, commitDate: COMMIT_DATE, skills: 2, references: 3 });

    expect(await readFile(path.join(contentDir, "skills/grc-alpha/SKILL.md"), "utf8")).toBe(ALPHA_SKILL_EXPECTED.replace("@SHA", `@${sha}`));
    expect(await readFile(path.join(contentDir, "references/grc-alpha-guide.md"), "utf8")).toBe(
      '# Guide\n\nSee `devkit_load_skill({ reference: "grc-alpha-other-ref" })` and devkit_load_skill({ reference: "grc-alpha-other-ref" }). Compare 1 < 2 and a<b.\n',
    );
    expect(await readFile(path.join(contentDir, "references/grc-alpha-other-ref.md"), "utf8")).toBe(ALPHA_OTHER);
    expect(await readFile(path.join(contentDir, "references/grc-beta-one.md"), "utf8")).toBe(BETA_ONE);
    // No blank line after the upstream frontmatter: the header still gets one.
    expect(await readFile(path.join(contentDir, "skills/grc-beta/SKILL.md"), "utf8")).toBe(
      [
        "---",
        "name: grc-beta",
        "description: 'Beta pack (vendored): second framework.'",
        "metadata:",
        "  type: grc",
        "---",
        "",
        `> Vendored from ${UPSTREAM_REPO}@${sha} (MIT); not legal advice. Do not edit; re-run scripts/sync-grc.mjs.`,
        "",
        'Beta body `devkit_load_skill({ reference: "grc-beta-one" })` here.',
        "",
      ].join("\n"),
    );
    expect(await readFile(path.join(contentDir, MANIFEST_FILE), "utf8")).toBe(
      `${JSON.stringify(
        {
          repo: UPSTREAM_REPO,
          commit: sha,
          commitDate: COMMIT_DATE,
          frameworks: [
            { upstream: "alpha", slug: "grc-alpha", references: ["guide", "other-ref"] },
            { upstream: "beta", slug: "grc-beta", references: ["one"] },
          ],
        },
        null,
        2,
      )}\n`,
    );
  });

  it("handles a frontmatter-only SKILL.md that ends at the closing fence", async () => {
    const sha = await commit(tree("alpha", "---\nname: alpha\ndescription: x\n---", {}));
    await writeNotices(sha);
    await sync(sha, [ALPHA]);
    const out = await readFile(path.join(contentDir, "skills/grc-alpha/SKILL.md"), "utf8");
    expect(out.endsWith(".mjs.\n\n")).toBe(true);
    expect(await readFile(path.join(contentDir, MANIFEST_FILE), "utf8")).toContain('"references": []');
  });

  it("is byte-identical when re-run at the same SHA", async () => {
    const sha = await commit(goodFiles());
    await writeNotices(sha);
    await sync(sha);
    const first = await snapshot();
    await sync(sha);
    expect(await snapshot()).toEqual(first);
  });

  it("accepts a notices section that is the last section of the file", async () => {
    const sha = await commit(goodFiles());
    await writeFile(noticesFile, `# Notices\n\n${NOTICES_HEADING}\n\ncommit ${sha}\n`);
    await expect(sync(sha)).resolves.toMatchObject({ commit: sha });
  });

  it("reads the commit object, not the working tree", async () => {
    const sha = await commit(goodFiles());
    await writeNotices(sha);
    await writeFile(path.join(cloneDir, "plugins/alpha/skills/alpha/references/guide.md"), "local edit <!-- hidden -->\n");
    await writeFile(path.join(cloneDir, "plugins/alpha/skills/alpha/references/untracked.md"), "untracked\n");
    await sync(sha);
    expect(await readFile(path.join(contentDir, "references/grc-alpha-guide.md"), "utf8")).toContain("# Guide");
    await expect(readFile(path.join(contentDir, "references/grc-alpha-untracked.md"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("is not redirected by an inherited GIT_DIR", async () => {
    const sha = await commit(goodFiles());
    await writeNotices(sha);
    const other = path.join(root, "other");
    await mkdir(other);
    execFileSync("git", ["-C", other, "init", "-q", "-b", "main"], { env: gitEnv });
    vi.stubEnv("GIT_DIR", path.join(other, ".git"));
    try {
      await expect(sync(sha)).resolves.toMatchObject({ commit: sha });
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("content gate", () => {
  it("lets U+FE0F and a plain < through (both directions)", async () => {
    const sha = await commit(goodFiles());
    await writeNotices(sha);
    await sync(sha);
    expect(await readFile(path.join(contentDir, "references/grc-alpha-other-ref.md"), "utf8")).toContain("❤\uFE0F");
    expect(await readFile(path.join(contentDir, "references/grc-alpha-guide.md"), "utf8")).toContain("1 < 2");
    expect(() => assertVisibleContent("a < b \uFE0F", "x")).not.toThrow();
  });

  it("rejects an HTML comment", async () => {
    await expectFailure({ ...goodFiles(), ...tree("alpha", ALPHA_SKILL, { guide: "x <!-- hidden --> y\n", "other-ref": "o\n" }) }, /HTML comment/u);
  });

  it.each([
    ["U+00AD", "\u00AD"],
    ["U+180E", "\u180E"],
    ["U+200B", "\u200B"],
    ["U+202A", "\u202A"],
    ["U+2060", "\u2060"],
    ["U+2066", "\u2066"],
    ["U+FEFF", "\uFEFF"],
    ["U+E0041", "\u{E0041}"],
    ["U+E0100", "\u{E0100}"],
  ])("rejects %s in a reference", async (label, char) => {
    await expectFailure(
      { ...goodFiles(), ...tree("alpha", ALPHA_SKILL, { guide: `ok${char}ok\n`, "other-ref": "o\n" }) },
      new RegExp(`invisible character ${label.replace("+", "\\+")}`, "u"),
    );
  });

  it("rejects an invisible character in SKILL.md", async () => {
    await expectFailure({ ...goodFiles(), ...tree("alpha", `${ALPHA_SKILL}\u200B`, { guide: "g\n", "other-ref": "o\n" }) }, /U\+200B/u);
  });

  it("pads short code points to four hex digits", () => {
    expect(() => assertVisibleContent("a\u00ADb", "x")).toThrow(/U\+00AD/u);
  });
});

describe("failures leave the output tree unchanged", () => {
  it.each(["abc123", "HEAD", "A".repeat(40), ""])("rejects the commit argument %j", async (arg) => {
    const sha = await commit(goodFiles());
    await writeNotices(sha);
    await expect(sync(arg)).rejects.toThrow(/full 40-hex SHA/u);
    expect(await snapshot()).toEqual({ references: "<dir>", skills: "<dir>" });
  });

  it("rejects an unknown commit", async () => {
    const sha = await commit(goodFiles());
    await writeNotices(sha);
    await expect(sync("0".repeat(40))).rejects.toThrow(/git rev-parse failed/u);
    expect(await snapshot()).toEqual({ references: "<dir>", skills: "<dir>" });
  });

  it("rejects an annotated tag object that is not a commit", async () => {
    const sha = await commit(goodFiles());
    git("tag", "-a", "v1", "-m", "tag");
    const tag = git("rev-parse", "v1");
    expect(tag).not.toBe(sha);
    await writeNotices(sha, tag);
    await expect(sync(tag)).rejects.toThrow(/not a commit object/u);
  });

  it("rejects a clone path that is not a repository", async () => {
    await expect(syncGrc({ cloneDir: root, sha: "1".repeat(40), contentDir, noticesFile, frameworks: [ALPHA] })).rejects.toThrow(/git rev-parse failed/u);
  });

  it("rejects a symlink entry", async () => {
    await expectFailure(
      { ...goodFiles(), "plugins/alpha/skills/alpha/references/link.md": { symlink: "guide.md" } },
      /mode 120000/u,
    );
  });

  it("rejects a submodule entry", async () => {
    await expectFailure(
      { ...goodFiles(), "plugins/alpha/skills/alpha/references/mod.md": { gitlink: "2".repeat(40) } },
      /mode 160000/u,
    );
  });

  it("rejects a SKILL.md that is a directory", async () => {
    const files = goodFiles();
    delete files["plugins/alpha/skills/alpha/SKILL.md"];
    await expectFailure({ ...files, "plugins/alpha/skills/alpha/SKILL.md/inner.md": "x\n" }, /unexpected file/u);
  });

  it.each([
    ["scripts/run.sh", "echo\n"],
    ["assets/logo.txt", "x\n"],
    ["references/nested/deep.md", "x\n"],
    ["references/notes.txt", "x\n"],
  ])("rejects the unexpected upstream file %s", async (rel, text) => {
    await expectFailure({ ...goodFiles(), [`plugins/alpha/skills/alpha/${rel}`]: text }, /unexpected file/u);
  });

  it("rejects a framework with no SKILL.md upstream", async () => {
    await expectFailure(withoutBetaSkill(), /no SKILL\.md/u);
  });

  it("rejects a reference that is not valid UTF-8", async () => {
    await expectFailure({ ...goodFiles(), ...tree("alpha", ALPHA_SKILL, { guide: Buffer.from([0x61, 0xff, 0xfe]), "other-ref": "o\n" }) }, /not valid UTF-8/u);
  });

  it("rejects a cited reference that has no file", async () => {
    await expectFailure(
      { ...goodFiles(), ...tree("alpha", `${ALPHA_SKILL}\nSee \`references/missing.md\`.\n`, { guide: "g\n", "other-ref": "o\n" }) },
      /cites references\/missing\.md/u,
    );
  });

  it("rejects a leftover references/ substring", async () => {
    await expectFailure(
      { ...goodFiles(), ...tree("alpha", `${ALPHA_SKILL}\nSee the references/ directory.\n`, { guide: "g\n", "other-ref": "o\n" }) },
      /still contains "references\/"/u,
    );
  });

  it("rejects a leftover references/ substring inside a reference file", async () => {
    await expectFailure(
      { ...goodFiles(), ...tree("alpha", ALPHA_SKILL, { guide: "cross-references/ here\n", "other-ref": "o\n" }) },
      /alpha\/references\/guide\.md: still contains "references\/"/u,
    );
  });

  it("rejects a leftover bare known name behind a path prefix", async () => {
    await expectFailure(
      { ...goodFiles(), ...tree("alpha", `${ALPHA_SKILL}\nOpen docs/guide.md.\n`, { guide: "g\n", "other-ref": "o\n" }) },
      /bare reference name "guide\.md"/u,
    );
  });

  it("rejects a leftover bare known name inside a reference file", async () => {
    await expectFailure(
      { ...goodFiles(), ...tree("alpha", ALPHA_SKILL, { guide: "see ./other-ref.md\n", "other-ref": "o\n" }) },
      /alpha\/references\/guide\.md: still contains the bare reference name/u,
    );
  });

  it("rejects an invalid reference name", async () => {
    await expectFailure({ ...goodFiles(), ...tree("alpha", ALPHA_SKILL, { Bad_Name: "x\n" }) }, /reference name "Bad_Name" violates/u);
  });

  it("rejects a reference whose slug-prefixed file name is too long", async () => {
    await expectFailure({ ...goodFiles(), ...tree("alpha", ALPHA_SKILL, { [`a${"b".repeat(60)}`]: "x\n" }) }, /reference file name/u);
  });

  it.each([
    ["Bad_Slug", /slug "Bad_Slug" violates/u],
    ["alpha-pack", /must start with "grc-"/u],
  ])("rejects the allowlist slug %s", async (slug, matcher) => {
    const sha = await commit(goodFiles());
    await writeNotices(sha);
    await expect(sync(sha, [{ ...ALPHA, slug }])).rejects.toThrow(matcher);
    expect(await snapshot()).toEqual({ references: "<dir>", skills: "<dir>" });
  });

  it.each([
    ["no frontmatter", "# no fm\n", /no frontmatter block/u],
    ["an indented first line", "---\n  name: alpha\ndescription: x\n---\nbody\n", /does not start with a key/u],
    ["an unparseable line", "---\nname alpha\ndescription: x\n---\nbody\n", /unparseable frontmatter line/u],
    ["an extra key", "---\nname: alpha\ndescription: x\nlicense: MIT\n---\nbody\n", /exactly name and description/u],
    ["a missing description", "---\nname: alpha\nlicense: MIT\n---\nbody\n", /exactly name and description/u],
    ["a repeated key", "---\nname: alpha\nname: beta\ndescription: x\n---\nbody\n", /exactly name and description/u],
  ])("rejects SKILL.md with %s", async (_label, skill, matcher) => {
    await expectFailure({ ...goodFiles(), ...tree("alpha", skill, { guide: "g\n", "other-ref": "o\n" }) }, matcher);
  });

  it("rejects a missing notices section", async () => {
    const sha = await commit(goodFiles());
    await writeFile(noticesFile, `# Notices\n\n## Something else\n\n${sha}\n`);
    await expect(sync(sha)).rejects.toThrow(/no section headed exactly/u);
    expect(await snapshot()).toEqual({ references: "<dir>", skills: "<dir>" });
  });

  it("rejects a heading that only starts with the required text", async () => {
    const sha = await commit(goodFiles());
    await writeFile(noticesFile, `# Notices\n\n${NOTICES_HEADING} extra\n\n${sha}\n`);
    await expect(sync(sha)).rejects.toThrow(/no section headed exactly/u);
  });

  it("rejects a stale notices SHA", async () => {
    const sha = await commit(goodFiles());
    await writeNotices("3".repeat(40));
    await expect(sync(sha)).rejects.toThrow(/does not contain the commit/u);
    expect(await snapshot()).toEqual({ references: "<dir>", skills: "<dir>" });
  });

  it("does not accept the SHA when it appears only in another section", async () => {
    const sha = await commit(goodFiles());
    await writeFile(noticesFile, `# Notices\n\n${NOTICES_HEADING}\n\nold\n\n## Other (MIT)\n\n${sha}\n`);
    await expect(sync(sha)).rejects.toThrow(/does not contain the commit/u);
  });

  it("fails when the notices file is missing", async () => {
    const sha = await commit(goodFiles());
    await expect(sync(sha)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses to overwrite an existing unlisted reference", async () => {
    const sha = await commit(goodFiles());
    await writeNotices(sha);
    await writeFile(path.join(contentDir, "references/grc-alpha-guide.md"), "hand-authored\n");
    const snap = await snapshot();
    await expect(sync(sha)).rejects.toThrow(/references\/grc-alpha-guide\.md already exists/u);
    expect(await snapshot()).toEqual(snap);
  });

  it("refuses to overwrite an existing unlisted skill", async () => {
    const sha = await commit(goodFiles());
    await writeNotices(sha);
    await mkdir(path.join(contentDir, "skills/grc-beta"));
    await writeFile(path.join(contentDir, "skills/grc-beta/SKILL.md"), "hand-authored\n");
    const snap = await snapshot();
    await expect(sync(sha)).rejects.toThrow(/skills\/grc-beta\/SKILL\.md already exists/u);
    expect(await snapshot()).toEqual(snap);
  });

  it.each([
    ["invalid JSON", "{nope", /not valid JSON/u],
    ["a JSON null", "null", /no frameworks array/u],
    ["no frameworks array", "{}", /no frameworks array/u],
    ["a non-array frameworks", '{"frameworks": {}}', /no frameworks array/u],
    ["a null framework", '{"frameworks": [null]}', /slug undefined violates/u],
    ["a non-string slug", '{"frameworks": [{"slug": 5, "references": []}]}', /slug 5 violates/u],
    ["a traversal slug", '{"frameworks": [{"slug": "../x", "references": []}]}', /slug "\.\.\/x" violates/u],
    ["a slug without the grc- prefix", '{"frameworks": [{"slug": "code-review", "references": []}]}', /must start with "grc-"/u],
    ["a missing references array", '{"frameworks": [{"slug": "grc-alpha"}]}', /grc-alpha has no references array/u],
    ["a traversal reference name", '{"frameworks": [{"slug": "grc-alpha", "references": ["../x"]}]}', /reference name "\.\.\/x" violates/u],
    ["an over-long reference name", `{"frameworks": [{"slug": "grc-alpha", "references": ["a${"b".repeat(60)}"]}]}`, /reference file name/u],
  ])("rejects a previous manifest with %s before deleting anything", async (_label, manifest, matcher) => {
    const sha = await commit(goodFiles());
    await writeNotices(sha);
    await writeFile(path.join(contentDir, MANIFEST_FILE), manifest);
    await writeFile(path.join(contentDir, "references/grc-alpha-guide.md"), "listed? must survive\n");
    const snap = await snapshot();
    await expect(sync(sha)).rejects.toThrow(matcher);
    expect(await snapshot()).toEqual(snap);
  });
});

describe("cleanup driven by the previous manifest", () => {
  it("removes a dropped framework and a dropped reference, and keeps hand-authored grc-* files", async () => {
    const first = await commit(goodFiles());
    await writeNotices(first);
    await sync(first);
    await writeFile(path.join(contentDir, "references/grc-handmade.md"), "mine\n");
    await mkdir(path.join(contentDir, "skills/grc-handmade"));
    await writeFile(path.join(contentDir, "skills/grc-handmade/SKILL.md"), "mine\n");

    const second = await commit(alphaWithoutGuide());
    await writeNotices(second);
    await sync(second, [ALPHA]);

    const files = Object.keys(await snapshot()).sort();
    expect(files).toEqual(
      [
        MANIFEST_FILE,
        "references",
        "references/grc-alpha-other-ref.md",
        "references/grc-handmade.md",
        "skills",
        "skills/grc-alpha",
        "skills/grc-alpha/SKILL.md",
        "skills/grc-handmade",
        "skills/grc-handmade/SKILL.md",
      ].sort(),
    );
    expect(await readFile(path.join(contentDir, "references/grc-handmade.md"), "utf8")).toBe("mine\n");
  });

  it("tolerates a listed skill directory that is already gone", async () => {
    const sha = await commit(goodFiles());
    await writeNotices(sha);
    await sync(sha);
    await rm(path.join(contentDir, "skills/grc-beta"), { recursive: true });
    await expect(sync(sha)).resolves.toMatchObject({ commit: sha });
  });

  it("fails loudly when a listed skill directory holds an unlisted file", async () => {
    const first = await commit(goodFiles());
    await writeNotices(first);
    await sync(first);
    await writeFile(path.join(contentDir, "skills/grc-beta/NOTES.md"), "mine\n");
    const second = await commit(alphaWithoutGuide());
    await writeNotices(second);
    await expect(sync(second, [ALPHA])).rejects.toMatchObject({ code: "ENOTEMPTY" });
    expect(await readFile(path.join(contentDir, "skills/grc-beta/NOTES.md"), "utf8")).toBe("mine\n");
  });
});

describe("rewriteCitations and listedFiles", () => {
  it("rewrites both citation shapes and leaves unknown bare names alone", () => {
    expect(rewriteCitations("`references/a.md` a.md other.md", "grc-x", ["a"], "t")).toBe(
      '`devkit_load_skill({ reference: "grc-x-a" })` devkit_load_skill({ reference: "grc-x-a" }) other.md',
    );
  });

  it("lists the skills and references of a valid manifest", () => {
    expect(listedFiles('{"frameworks":[{"slug":"grc-x","references":["a","b"]}]}')).toEqual({
      skills: ["grc-x"],
      references: ["references/grc-x-a.md", "references/grc-x-b.md"],
    });
  });
});

describe("default allowlist", () => {
  it("has 9 unique grc-* slugs and descriptions that fit the 1024-char limit and the vendored pattern", () => {
    expect(FRAMEWORKS.map((f) => f.slug)).toEqual([
      "grc-gdpr",
      "grc-soc2",
      "grc-nis2",
      "grc-eu-ai-act",
      "grc-eu-cra",
      "grc-dora",
      "grc-pci-dss",
      "grc-hipaa",
      "grc-ccpa",
    ]);
    for (const fw of FRAMEWORKS) {
      expect(fw.description.length).toBeLessThanOrEqual(400);
      expect(fw.description).toMatch(/knowledge pack \(vendored, MIT\): .+\. Loaded by the compliance reviewer when the framework applies; use for .+-specific questions\.$/u);
    }
  });
});

describe("CLI", () => {
  const collect = () => {
    const lines = { log: [], error: [] };
    return { lines, io: { log: (l) => lines.log.push(l), error: (l) => lines.error.push(l) } };
  };

  async function defaultTree() {
    const files = {};
    for (const fw of FRAMEWORKS) {
      Object.assign(files, tree(fw.upstream, `---\nname: ${fw.upstream}\ndescription: x\n---\nBody \`references/ref.md\`.\n`, { ref: "ref\n" }));
    }
    return commit(files);
  }

  it("reports a usage error with exit code 2", async () => {
    for (const args of [[], ["only-one"], ["a", "b", "c"]]) {
      const { lines, io } = collect();
      expect(await runCli(args, { pluginRoot: root, ...io })).toBe(2);
      expect(lines.error).toEqual(["usage: node scripts/sync-grc.mjs <path-to-upstream-clone> <40-hex-commit-sha>"]);
      expect(lines.log).toEqual([]);
    }
  });

  it("syncs the default allowlist and exits 0", async () => {
    const sha = await defaultTree();
    await writeNotices(sha);
    const { lines, io } = collect();
    expect(await runCli([cloneDir, sha], { pluginRoot: root, ...io })).toBe(0);
    expect(lines.error).toEqual([]);
    expect(lines.log).toEqual([`devkit sync-grc: wrote 9 skills + 9 references at ${sha} (${COMMIT_DATE}). Now run: node scripts/build-index.mjs`]);
    expect((await readdir(path.join(contentDir, "skills"))).sort()).toEqual(FRAMEWORKS.map((f) => f.slug).sort());
  });

  it("reports a sync failure with exit code 1", async () => {
    const sha = await defaultTree();
    await writeNotices("4".repeat(40));
    const { lines, io } = collect();
    expect(await runCli([cloneDir, sha], { pluginRoot: root, ...io })).toBe(1);
    expect(lines.error).toHaveLength(1);
    expect(lines.error[0]).toMatch(/^devkit sync-grc failed: the notices section/u);
  });

  it("reports an unexpected error with its stack and exit code 1", async () => {
    const sha = await defaultTree();
    const { lines, io } = collect();
    expect(await runCli([cloneDir, sha], { pluginRoot: root, ...io })).toBe(1);
    expect(lines.error[0]).toContain("ENOENT");
  });

  it("runs as the entry script when it is the process entry point", async () => {
    const sha = await defaultTree();
    await writeNotices(sha);
    const fakeScript = path.join(root, "scripts", "sync-grc.mjs");
    const exit = vi.spyOn(process, "exit").mockImplementation(() => undefined);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.doMock("node:url", async (importOriginal) => ({ ...(await importOriginal()), fileURLToPath: () => fakeScript }));
    const prevArgv = process.argv;
    process.argv = [prevArgv[0], fakeScript, cloneDir, sha];
    try {
      vi.resetModules();
      await import("./sync-grc.mjs");
      expect(exit).toHaveBeenCalledWith(0);
      expect(log).toHaveBeenCalledTimes(1);
    } finally {
      process.argv = prevArgv;
      vi.doUnmock("node:url");
      vi.resetModules();
    }
  });
});

function withoutBetaSkill() {
  return { ...tree("alpha", ALPHA_SKILL, { guide: ALPHA_GUIDE, "other-ref": ALPHA_OTHER }), "plugins/beta/skills/beta/references/one.md": BETA_ONE };
}

function alphaWithoutGuide() {
  return tree("alpha", ALPHA_SKILL.replaceAll("`references/guide.md`", "`references/other-ref.md`"), { "other-ref": ALPHA_OTHER });
}
