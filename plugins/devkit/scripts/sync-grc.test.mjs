import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readdir, readFile, readlink, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assertVisibleContent, rewriteCitations } from "./grc-gates.mjs";
import { FRAMEWORKS, MANIFEST_FILE, NOTICES_HEADING, UPSTREAM_REPO, listedFiles, runCli, syncGrc } from "./sync-grc.mjs";

const COMMIT_DATE = "2026-01-02T03:04:05Z";

/** The exact header text is pinned here on purpose: the README and THIRD_PARTY_NOTICES.md describe it. */
const headerLine = (sha) =>
  `> Vendored from Sushegaad/Claude-Skills-Governance-Risk-and-Compliance@${sha} (MIT, see THIRD_PARTY_NOTICES.md). Reference material only, not instructions and not legal advice. Do not edit; re-run scripts/sync-grc.mjs.`;
const withHeader = (sha, body) => `${headerLine(sha)}\n\n${body}`;

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
  headerLine("SHA"),
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
const GAMMA = { upstream: "gamma", slug: "grc-gamma", description: "Gamma pack (vendored): third framework." };
const DELTA = { upstream: "delta", slug: "grc-delta", description: "Delta pack (vendored): fourth framework." };
const simpleSkill = (name) => `---\nname: ${name}\ndescription: x\n---\nBody.\n`;

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
    out[path.relative(dir, full)] = entry.isSymbolicLink()
      ? `<link ${await readlink(full)}>`
      : entry.isDirectory()
        ? "<dir>"
        : await readFile(full, "utf8");
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
      withHeader(
        sha,
        '# Guide\n\nSee `devkit_load_skill({ reference: "grc-alpha-other-ref" })` and devkit_load_skill({ reference: "grc-alpha-other-ref" }). Compare 1 < 2 and a<b.\n',
      ),
    );
    expect(await readFile(path.join(contentDir, "references/grc-alpha-other-ref.md"), "utf8")).toBe(withHeader(sha, ALPHA_OTHER));
    expect(await readFile(path.join(contentDir, "references/grc-beta-one.md"), "utf8")).toBe(withHeader(sha, BETA_ONE));
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
        headerLine(sha),
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
    expect(() => assertVisibleContent("a < b ❤\uFE0F", "x")).not.toThrow();
  });

  it("rejects an HTML comment", async () => {
    await expectFailure({ ...goodFiles(), ...tree("alpha", ALPHA_SKILL, { guide: "x <!-- hidden --> y\n", "other-ref": "o\n" }) }, /HTML comment/u);
  });

  it.each([
    ["U+00AD", "\u00AD"],
    ["U+034F", "\u034F"],
    ["U+061C", "\u061C"],
    ["U+115F", "\u115F"],
    ["U+1160", "\u1160"],
    ["U+17B4", "\u17B4"],
    ["U+17B5", "\u17B5"],
    ["U+180E", "\u180E"],
    ["U+200B", "\u200B"],
    ["U+2028", "\u2028"],
    ["U+2029", "\u2029"],
    ["U+202A", "\u202A"],
    ["U+2060", "\u2060"],
    ["U+2066", "\u2066"],
    ["U+3164", "\u3164"],
    ["U+FEFF", "\uFEFF"],
    ["U+FFA0", "\uFFA0"],
    ["U+FFF9", "\uFFF9"],
    ["U+FFFB", "\uFFFB"],
    ["U+E0000", "\u{E0000}"],
    ["U+E0010", "\u{E0010}"],
    ["U+E0041", "\u{E0041}"],
    ["U+E0100", "\u{E0100}"],
    ["U+0000", "\u0000"],
    ["U+000B", "\u000B"],
    ["U+000C", "\u000C"],
    ["U+001B", "\u001B"],
    ["U+007F", "\u007F"],
    ["U+0085", "\u0085"],
    ["U+180C", "\u180C"],
    ["U+180F", "\u180F"],
    ["U+FE0E", "\uFE0E"],
    ["U+FFFA", "\uFFFA"],
    ["U+1D175", "\u{1D175}"],
    ["U+0600", "\u0600"],
    ["U+06DD", "\u06DD"],
    ["U+070F", "\u070F"],
    ["U+0890", "\u0890"],
    ["U+08E2", "\u08E2"],
    ["U+206A", "\u206A"],
    ["U+110BD", "\u{110BD}"],
    ["U+13430", "\u{13430}"],
    ["U+1BCA0", "\u{1BCA0}"],
    ["U+FFFC", "\uFFFC"],
  ])("rejects %s in a reference", async (label, char) => {
    await expectFailure(
      { ...goodFiles(), ...tree("alpha", ALPHA_SKILL, { guide: `ok${char}ok\n`, "other-ref": "o\n" }) },
      new RegExp(`invisible character ${label.replace("+", "\\+")}`, "u"),
    );
  });

  const NBSP = String.fromCodePoint(0x00a0);
  const IDEOGRAPHIC_SPACE = String.fromCodePoint(0x3000);
  const DEFINITION_MESSAGE = /looks like a Markdown link-reference definition \(`\[label\]:`\), which can hide text; refusing it/u;

  it.each([
    ["a bare URL destination", "[x]: https://example.com\n"],
    ["a URL destination with a title", '[a]: https://example.com "t"\n'],
    ["a # destination", "[x]: #\n"],
    ["a <> destination", "[x]: <>\n"],
    ["a label alone on its line", "[x]:\n"],
    ["a [//]: # comment", "[//]: # (hidden instruction)\n"],
    ["an indented definition", "text\n\n   [x]: #   \"hidden\"\n"],
    ["a tab-indented definition", "\t[x]: #\n"],
    ["a definition in a deep list item", "10. item\n\n    [x]: # (hidden)\n"],
    ["a definition in a nested list", "- a\n  - b\n\n    [x]: #\n"],
    ["a block-quoted definition", "> [x]: #\n"],
    ["a definition in a - list item", "- [x]: #\n"],
    ["a definition in a * list item", "* [x]: #\n"],
    ["a definition in a + list item", "+ [x]: #\n"],
    ["a definition in a 1) list item", "1) [x]: <>\n"],
    ["a definition in a nested quote and list", "> - [x]: #\n"],
    ["a backslash before a line break in the label", "[a\\\nb]: #\n"],
    ["a title that ends in a backslash before a line break", '[x]: # "t\\\nmore"\n'],
    ["a label made of U+00A0", `[${NBSP}]: #\n`],
    ["a label made of U+3000", `[${IDEOGRAPHIC_SPACE}]: #\n`],
    ["a label opened on one line and closed on the next", "[a\nb]: #\n"],
    ["a closing line with no opening bracket at all", "text\nlabel]: #\n"],
    ["a closing line after a quote prefix", "[a\n> b]: #\n"],
    ["an escaped [ on the closing line", "[a\n \\[ b]: #\n"],
    ["an escaped [ before the only ]:", "x \\[a]: y\n"],
    ["a [ with three backslashes before it (escaped)", "x \\\\\\[a]: y\n"],
    ["an unescaped [ that comes only after the first ]:", "y \\[a]: b [c]: d\n"],
    ["a definition inside a fenced code block (intended: fail closed)", "```\n[x]: #\n```\n"],
    ["a prose line that looks like a definition (intended: fail closed)", "[PLACEHOLDER]: for [PURPOSE]\n"],
    ["a CRLF line end", "[x]: # (hidden)\r\n"],
    ["a bare CR line end", "[x]: #\r(hidden)\r"],
    ["a definition that ends the text", "[x]: #"],
  ])("rejects %s", (_label, text) => {
    expect(() => assertVisibleContent(text, "x")).toThrow(DEFINITION_MESSAGE);
  });

  it("reports the 1-based number of the first rejected line, whatever the line break", () => {
    expect(() => assertVisibleContent("ok\n\n> [x]: #\n", "doc")).toThrow("doc: line 3 looks like");
    expect(() => assertVisibleContent("ok\r\nok\r[x]: #", "doc")).toThrow("doc: line 3 looks like");
    expect(() => assertVisibleContent("[a\nb]: #\n", "doc")).toThrow("doc: line 2 looks like");
  });

  it("rejects a definition end to end and leaves the output untouched", async () => {
    await expectFailure(
      { ...goodFiles(), ...tree("alpha", ALPHA_SKILL, { guide: "ok\n[x]: https://example.com\n", "other-ref": "o\n" }) },
      /alpha\/references\/guide\.md: line 2 looks like a Markdown link-reference definition/u,
    );
  });

  it.each([
    ["a bold requirement label (upstream pci SKILL.md)", "**Requirement [X.X]: [Name]**\n"],
    ["an inline link", "See [text](https://example.com) and [ref][id].\n"],
    ["several bracketed words", "see [a] and [b]\n"],
    ["a `]:` after an earlier `[` that is not at the line start", "Use [X]: the value\n"],
    ["a list marker with no space after it (a paragraph)", "-[x]: #\n"],
    ["a [ with two backslashes before it (not escaped)", "x \\\\[a]: y\n"],
    ["a task list item", "- [ ] open\n- [x] done\n"],
    ["a label with no colon", "[x] # (text)\n"],
    ["a lone opening bracket", "[a\nb\n"],
    ["a colon after a closing bracket in code", "arr[0]:\n"],
  ])("lets %s through (both directions)", (_label, text) => {
    expect(() => assertVisibleContent(text, "x")).not.toThrow();
  });

  it("runs in linear time: 20,000 lines of `[a`, and a 20,000-deep container prefix", () => {
    const start = performance.now();
    expect(() => assertVisibleContent("[a\n".repeat(20_000), "x")).not.toThrow();
    expect(() => assertVisibleContent(`${"> ".repeat(20_000)}[x]: #`, "x")).toThrow(DEFINITION_MESSAGE);
    expect(performance.now() - start).toBeLessThan(1000);
  });

  it("rejects an invisible character in SKILL.md", async () => {
    await expectFailure({ ...goodFiles(), ...tree("alpha", `${ALPHA_SKILL}\u200B`, { guide: "g\n", "other-ref": "o\n" }) }, /U\+200B/u);
  });

  it("lets tab, LF and CR through (both directions)", () => {
    expect(() => assertVisibleContent("a\tb\r\nc\nd", "x")).not.toThrow();
    expect(() => assertVisibleContent("a\u0008b", "x")).toThrow(/U\+0008/u);
    expect(() => assertVisibleContent("a\u000Eb", "x")).toThrow(/U\+000E/u);
    expect(() => assertVisibleContent("a\u009Fb", "x")).toThrow(/U\+009F/u);
  });

  it("lets U+FE0F through only as an emoji selector (both directions)", () => {
    expect(() => assertVisibleContent("❤\uFE0F\n✔\uFE0F ok ❤\uFE0F", "x")).not.toThrow();
    expect(() => assertVisibleContent("a 1\uFE0F\u20E3 #\uFE0F\u20E3 *\uFE0F\u20E3 b", "x")).not.toThrow();
    expect(() => assertVisibleContent("a\uFE0Fb", "x")).toThrow(/U\+FE0F/u);
    expect(() => assertVisibleContent("a \uFE0Fb", "x")).toThrow(/U\+FE0F/u);
    expect(() => assertVisibleContent("1\uFE0Fb", "x")).toThrow(/U\+FE0F/u);
    expect(() => assertVisibleContent("1\uFE0F\uFE0F\u20E3", "x")).toThrow(/U\+FE0F/u);
    expect(() => assertVisibleContent("a\uFE0F\uFE0Fb", "x")).toThrow(/U\+FE0F/u);
    expect(() => assertVisibleContent("❤\uFE0F\uFE0F\uFE0F", "x")).toThrow(/U\+FE0F/u);
    expect(() => assertVisibleContent("\uFE0Fa", "x")).toThrow(/U\+FE0F/u);
    expect(() => assertVisibleContent("ok\n\uFE0Fa", "x")).toThrow(/U\+FE0F/u);
    expect(() => assertVisibleContent("❤\uFE0F\n\uFE0F", "x")).toThrow(/U\+FE0F/u);
  });

  it("rejects a doubled U+FE0F in a reference", async () => {
    await expectFailure(
      { ...goodFiles(), ...tree("alpha", ALPHA_SKILL, { guide: "ok ❤\uFE0F\uFE0F ok\n", "other-ref": "o\n" }) },
      /invisible character U\+FE0F/u,
    );
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

  it("falls back to the exec error message when git writes nothing to stderr", async () => {
    vi.stubEnv("PATH", root);
    try {
      await expect(sync("5".repeat(40))).rejects.toThrow(/git rev-parse failed: spawn git ENOENT/u);
    } finally {
      vi.unstubAllEnvs();
    }
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
    ["an indented first line", "---\n  name: alpha\ndescription: x\n---\nbody\n", /frontmatter does not parse/u],
    ["an unparseable line", "---\nname alpha\ndescription: x\n---\nbody\n", /frontmatter does not parse/u],
    ["a comment-only block", "---\n# nothing\n---\nbody\n", /not a key\/value map/u],
    ["a YAML list", "---\n- name\n- description\n---\nbody\n", /exactly name and description/u],
    ["an extra key", "---\nname: alpha\ndescription: x\nlicense: MIT\n---\nbody\n", /exactly name and description/u],
    ["a missing description", "---\nname: alpha\nlicense: MIT\n---\nbody\n", /exactly name and description/u],
    ["a repeated key", "---\nname: alpha\nname: beta\ndescription: x\n---\nbody\n", /frontmatter does not parse/u],
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
    ["a missing upstream", '{"frameworks": [{"slug": "grc-alpha", "references": []}]}', /upstream undefined violates/u],
    ["a non-string upstream", '{"frameworks": [{"slug": "grc-alpha", "upstream": 5, "references": []}]}', /upstream 5 violates/u],
    ["a traversal upstream", '{"frameworks": [{"slug": "grc-alpha", "upstream": "../x", "references": []}]}', /upstream "\.\.\/x" violates/u],
    ["an upstream with a path separator", '{"frameworks": [{"slug": "grc-alpha", "upstream": "a/b", "references": []}]}', /upstream "a\/b" violates/u],
    ["a missing references array", '{"frameworks": [{"slug": "grc-alpha", "upstream": "alpha"}]}', /grc-alpha has no references array/u],
    ["a traversal reference name", '{"frameworks": [{"slug": "grc-alpha", "upstream": "alpha", "references": ["../x"]}]}', /reference name "\.\.\/x" violates/u],
    ["an over-long reference name", `{"frameworks": [{"slug": "grc-alpha", "upstream": "alpha", "references": ["a${"b".repeat(60)}"]}]}`, /reference file name/u],
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

  it("fails before any delete when a listed skill directory holds an unlisted file", async () => {
    await expectFailure(alphaWithoutGuide(), /skills\/grc-beta holds files the previous grc-upstream\.json does not list: NOTES\.md/u, {
      frameworks: [ALPHA],
      before: () => writeFile(path.join(contentDir, "skills/grc-beta/NOTES.md"), "mine\n"),
    });
  });

  it("fails before any delete when a listed skill directory is a symlink, and never writes through it", async () => {
    const elsewhere = path.join(root, "elsewhere");
    await expectFailure(alphaWithoutGuide(), /skills\/grc-beta is not a real directory/u, {
      frameworks: [ALPHA],
      before: async () => {
        await rm(path.join(contentDir, "skills/grc-beta"), { recursive: true });
        await mkdir(elsewhere);
        await writeFile(path.join(elsewhere, "SKILL.md"), "outside\n");
        await symlink(elsewhere, path.join(contentDir, "skills/grc-beta"));
      },
    });
    expect(await readFile(path.join(elsewhere, "SKILL.md"), "utf8")).toBe("outside\n");
  });

  it("fails before any write when the content directory is a plain file", async () => {
    const sha = await commit(goodFiles());
    await writeNotices(sha);
    await sync(sha);
    await rm(contentDir, { recursive: true });
    await writeFile(contentDir, "a file where the content directory belongs\n");
    await expect(sync(sha)).rejects.toThrow(/the content directory is not a real directory/u);
    expect(await readFile(contentDir, "utf8")).toBe("a file where the content directory belongs\n");
  });

  it("fails before any write when the content directory is missing", async () => {
    const sha = await commit(goodFiles());
    await writeNotices(sha);
    await rm(contentDir, { recursive: true });
    await expect(sync(sha)).rejects.toThrow(/the content directory is not a real directory/u);
    await expect(readdir(contentDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails before any write when the content directory is a symlink, and never writes through it", async () => {
    const moved = path.join(root, "moved-content");
    await expectFailure(alphaWithoutGuide(), /the content directory is not a real directory/u, {
      frameworks: [ALPHA],
      before: async () => {
        await rename(contentDir, moved);
        await symlink(moved, contentDir);
      },
    });
    expect(Object.keys(await snapshot(moved)).sort()).toEqual(
      [MANIFEST_FILE, "references", "references/grc-alpha-guide.md", "references/grc-alpha-other-ref.md", "references/grc-beta-one.md", "skills", "skills/grc-alpha", "skills/grc-alpha/SKILL.md", "skills/grc-beta", "skills/grc-beta/SKILL.md"].sort(),
    );
  });

  it("rethrows an lstat error other than ENOENT before any write", async () => {
    const sha = await commit(goodFiles());
    await writeNotices(sha);
    const blocker = path.join(root, "blocker");
    await writeFile(blocker, "a file where a parent directory belongs\n");
    await expect(syncGrc({ cloneDir, sha, contentDir: path.join(blocker, "content"), noticesFile, frameworks: [ALPHA, BETA] })).rejects.toMatchObject({
      code: "ENOTDIR",
    });
    expect(await readFile(blocker, "utf8")).toBe("a file where a parent directory belongs\n");
  });

  it("fails before any write when the previous manifest is a symlink, and never reads or writes through it", async () => {
    const outside = path.join(root, "outside.json");
    await expectFailure(alphaWithoutGuide(), /grc-upstream\.json is not a regular file/u, {
      frameworks: [ALPHA],
      before: async () => {
        await rename(path.join(contentDir, MANIFEST_FILE), outside);
        await symlink(outside, path.join(contentDir, MANIFEST_FILE));
      },
    });
    expect(JSON.parse(await readFile(outside, "utf8")).frameworks).toHaveLength(2);
  });

  it("fails before any write when the previous manifest is a directory", async () => {
    await expectFailure(alphaWithoutGuide(), /grc-upstream\.json is not a regular file/u, {
      frameworks: [ALPHA],
      before: async () => {
        await rm(path.join(contentDir, MANIFEST_FILE));
        await mkdir(path.join(contentDir, MANIFEST_FILE));
      },
    });
  });

  it.each(["skills", "references"])("fails before any delete or write when content/%s is a symlink, and never writes through it", async (parent) => {
    const elsewhere = path.join(root, "elsewhere");
    await expectFailure(alphaWithoutGuide(), new RegExp(`content/${parent} is not a real directory`, "u"), {
      frameworks: [ALPHA],
      before: async () => {
        await mkdir(elsewhere);
        await writeFile(path.join(elsewhere, "keep.md"), "outside\n");
        await rename(path.join(contentDir, parent), path.join(root, `moved-${parent}`));
        await symlink(elsewhere, path.join(contentDir, parent));
      },
    });
    expect(await readdir(elsewhere)).toEqual(["keep.md"]);
  });

  it.each(["skills", "references"])("fails before any delete or write when content/%s is a plain file", async (parent) => {
    await expectFailure(alphaWithoutGuide(), new RegExp(`content/${parent} is not a real directory`, "u"), {
      frameworks: [ALPHA],
      before: async () => {
        await rename(path.join(contentDir, parent), path.join(root, `moved-${parent}`));
        await writeFile(path.join(contentDir, parent), "a file where the directory belongs\n");
      },
    });
  });

  it.each(["skills", "references"])("creates content/%s when it does not exist yet", async (parent) => {
    const sha = await commit(goodFiles());
    await writeNotices(sha);
    await rm(path.join(contentDir, parent), { recursive: true });
    await expect(sync(sha)).resolves.toMatchObject({ commit: sha });
    expect((await snapshot())[parent]).toBe("<dir>");
  });

  it("fails before any delete when a listed reference is a directory", async () => {
    await expectFailure(alphaWithoutGuide(), /references\/grc-alpha-guide\.md is not a regular file/u, {
      frameworks: [ALPHA],
      before: async () => {
        await rm(path.join(contentDir, "references/grc-alpha-guide.md"));
        await mkdir(path.join(contentDir, "references/grc-alpha-guide.md"));
      },
    });
  });

  it("fails before any delete when a listed reference is a symlink, and never touches its target", async () => {
    const outside = path.join(root, "outside.md");
    await writeFile(outside, "outside\n");
    await expectFailure(alphaWithoutGuide(), /references\/grc-alpha-guide\.md is not a regular file/u, {
      frameworks: [ALPHA],
      before: async () => {
        await rm(path.join(contentDir, "references/grc-alpha-guide.md"));
        await symlink(outside, path.join(contentDir, "references/grc-alpha-guide.md"));
      },
    });
    expect(await readFile(outside, "utf8")).toBe("outside\n");
  });

  it("fails before any delete when a listed SKILL.md is a directory", async () => {
    await expectFailure(alphaWithoutGuide(), /skills\/grc-beta\/SKILL\.md is not a regular file/u, {
      frameworks: [ALPHA],
      before: async () => {
        await rm(path.join(contentDir, "skills/grc-beta/SKILL.md"));
        await mkdir(path.join(contentDir, "skills/grc-beta/SKILL.md"));
      },
    });
  });

  it("fails before any delete when a listed SKILL.md is a symlink, and never touches its target", async () => {
    const outside = path.join(root, "outside.md");
    await writeFile(outside, "outside\n");
    await expectFailure(alphaWithoutGuide(), /skills\/grc-beta\/SKILL\.md is not a regular file/u, {
      frameworks: [ALPHA],
      before: async () => {
        await rm(path.join(contentDir, "skills/grc-beta/SKILL.md"));
        await symlink(outside, path.join(contentDir, "skills/grc-beta/SKILL.md"));
      },
    });
    expect(await readFile(outside, "utf8")).toBe("outside\n");
  });

  it("fails before any write when a new target skill directory is a symlink, and never writes through it", async () => {
    const elsewhere = path.join(root, "elsewhere");
    await expectFailure(withGamma(), /skills\/grc-gamma is not a real directory/u, {
      frameworks: [ALPHA, BETA, GAMMA],
      before: async () => {
        await mkdir(elsewhere);
        await symlink(elsewhere, path.join(contentDir, "skills/grc-gamma"));
      },
    });
    expect(await readdir(elsewhere)).toEqual([]);
  });

  it("fails before any write when a new target skill directory is a plain file", async () => {
    await expectFailure(withGamma(), /skills\/grc-gamma is not a real directory/u, {
      frameworks: [ALPHA, BETA, GAMMA],
      before: () => writeFile(path.join(contentDir, "skills/grc-gamma"), "blocker\n"),
    });
  });

  it.skipIf(process.getuid?.() === 0)("lists the union in the manifest first, so a re-run after an I/O failure in phase 2 succeeds", async () => {
    const first = await commit(goodFiles());
    await writeNotices(first);
    await sync(first);
    const second = await commit({
      ...goodFiles(),
      ...tree("gamma", simpleSkill("gamma"), { g: "g\n" }),
      ...tree("delta", simpleSkill("delta"), { d: "d\n" }),
    });
    await writeNotices(first, second);
    const all = [ALPHA, BETA, GAMMA, DELTA];
    // A read-only but real, empty directory where delta's skill directory belongs: every phase-1 check passes and
    // phase 2 fails writing delta's SKILL.md, after the gamma files are already written. (chmod does not bind root.)
    const blocked = path.join(contentDir, "skills/grc-delta");
    await mkdir(blocked);
    await chmod(blocked, 0o555);
    try {
      await expect(sync(second, all)).rejects.toMatchObject({ code: "EACCES" });
    } finally {
      await chmod(blocked, 0o755);
    }

    const interim = JSON.parse(await readFile(path.join(contentDir, MANIFEST_FILE), "utf8"));
    expect(interim.frameworks.map((fw) => fw.slug)).toEqual(["grc-alpha", "grc-beta", "grc-gamma", "grc-delta"]);
    expect(await readFile(path.join(contentDir, "references/grc-gamma-g.md"), "utf8")).toBe(withHeader(second, "g\n"));

    await expect(sync(second, all)).resolves.toMatchObject({ commit: second, skills: 4, references: 5 });
    const final = JSON.parse(await readFile(path.join(contentDir, MANIFEST_FILE), "utf8"));
    expect(final.commit).toBe(second);
    expect(final.frameworks.map((fw) => fw.upstream)).toEqual(["alpha", "beta", "gamma", "delta"]);
    expect(await readFile(path.join(contentDir, "references/grc-delta-d.md"), "utf8")).toBe(withHeader(second, "d\n"));
  });

  it.skipIf(process.getuid?.() === 0)("merges a slug's old and new references in the interim manifest", async () => {
    const first = await commit(goodFiles());
    await writeNotices(first);
    await sync(first);
    const second = await commit({ ...goodFiles(), ...tree("alpha", ALPHA_SKILL, { guide: ALPHA_GUIDE, "other-ref": ALPHA_OTHER, extra: "e\n" }) });
    await writeNotices(first, second);
    // Make phase 2 fail right after the interim manifest: a read-only references directory, so deleting the first
    // listed reference file fails. Every phase-1 check passes. (chmod does not bind root.)
    const referencesDir = path.join(contentDir, "references");
    await chmod(referencesDir, 0o555);
    try {
      await expect(sync(second)).rejects.toMatchObject({ code: "EACCES" });
    } finally {
      await chmod(referencesDir, 0o755);
    }
    const interim = JSON.parse(await readFile(path.join(contentDir, MANIFEST_FILE), "utf8"));
    expect(interim.frameworks).toEqual([
      { upstream: "alpha", slug: "grc-alpha", references: ["guide", "other-ref", "extra"] },
      { upstream: "beta", slug: "grc-beta", references: ["one"] },
    ]);
  });
});

describe("excluded references", () => {
  const SKILL = "---\nname: alpha\ndescription: x\n---\nSee `references/guide.md`.\n";
  const DRAFT_WITH_PLACEHOLDERS = "# Draft\n[PLACEHOLDER]: for [PURPOSE]\n";
  const ALPHA_EXCLUDING_DRAFT = { ...ALPHA, exclude: ["draft"] };

  it("neither reads, copies nor lists an excluded reference, and a later sync deletes the old copy", async () => {
    const first = await commit(tree("alpha", SKILL, { guide: "# Guide\n", draft: "# Draft\n" }));
    await writeNotices(first);
    await sync(first, [ALPHA]);
    expect(await readFile(path.join(contentDir, "references/grc-alpha-draft.md"), "utf8")).toBe(withHeader(first, "# Draft\n"));

    // The excluded file now fails the content gate; it is never read, so the sync still passes.
    const second = await commit(tree("alpha", SKILL, { guide: "# Guide see my-draft.md\n", draft: DRAFT_WITH_PLACEHOLDERS }));
    await writeNotices(first, second);
    expect(await sync(second, [ALPHA_EXCLUDING_DRAFT])).toEqual({ commit: second, commitDate: COMMIT_DATE, skills: 1, references: 1 });
    expect(Object.keys(await snapshot()).sort()).toEqual(
      [MANIFEST_FILE, "references", "references/grc-alpha-guide.md", "skills", "skills/grc-alpha", "skills/grc-alpha/SKILL.md"].sort(),
    );
    expect(JSON.parse(await readFile(path.join(contentDir, MANIFEST_FILE), "utf8")).frameworks).toEqual([
      { upstream: "alpha", slug: "grc-alpha", references: ["guide"] },
    ]);
  });

  it("fails when the same file is not excluded (the gate is real)", async () => {
    await expectFailure(tree("alpha", SKILL, { guide: "# Guide\n", draft: DRAFT_WITH_PLACEHOLDERS }), /alpha\/references\/draft\.md: line 2 looks like/u, {
      frameworks: [ALPHA],
    });
  });

  it("fails on a stale exclude that names no upstream reference", async () => {
    await expectFailure(goodFiles(), /alpha: exclude entry "nope" names no reference file upstream/u, {
      frameworks: [{ ...ALPHA, exclude: ["nope"] }],
    });
  });

  it.each([
    ["the skill, by path", `---\nname: alpha\ndescription: x\n---\nOpen \`references/draft.md\`.\n`, "# Guide\n", /alpha\/SKILL\.md: cites the excluded reference "draft"/u],
    ["the skill, by bare name", `---\nname: alpha\ndescription: x\n---\nOpen draft.md.\n`, "# Guide\n", /alpha\/SKILL\.md: cites the excluded reference "draft"/u],
    ["a reference, by path", SKILL, "See references/draft.md\n", /alpha\/references\/guide\.md: cites the excluded reference "draft"/u],
    ["a reference, by bare name", SKILL, "See draft.md\n", /alpha\/references\/guide\.md: cites the excluded reference "draft"/u],
  ])("fails when %s cites an excluded reference", async (_label, skill, guide, matcher) => {
    await expectFailure(tree("alpha", skill, { guide, draft: "# Draft\n" }), matcher, { frameworks: [ALPHA_EXCLUDING_DRAFT] });
  });
});

describe("rewriteCitations and listedFiles", () => {
  it("rewrites both citation shapes and leaves unknown bare names alone", () => {
    expect(rewriteCitations("`references/a.md` a.md other.md", "grc-x", ["a"], "t")).toBe(
      '`devkit_load_skill({ reference: "grc-x-a" })` devkit_load_skill({ reference: "grc-x-a" }) other.md',
    );
  });

  it("lists the skills and references of a valid manifest", () => {
    expect(listedFiles('{"frameworks":[{"upstream":"x","slug":"grc-x","references":["a","b"]}]}')).toEqual({
      skills: ["grc-x"],
      references: ["references/grc-x-a.md", "references/grc-x-b.md"],
      frameworks: [{ upstream: "x", slug: "grc-x", references: ["a", "b"] }],
    });
  });
});

describe("default allowlist", () => {
  it("excludes only gdpr-compliance's privacy-notice drafting template", () => {
    expect(FRAMEWORKS.filter((f) => f.exclude !== undefined).map((f) => [f.upstream, f.exclude])).toEqual([["gdpr-compliance", ["privacy-notice"]]]);
  });


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
      const refs = { ref: "ref\n", ...Object.fromEntries((fw.exclude ?? []).map((name) => [name, "excluded\n"])) };
      Object.assign(files, tree(fw.upstream, `---\nname: ${fw.upstream}\ndescription: x\n---\nBody \`references/ref.md\`.\n`, refs));
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

function withGamma() {
  return { ...goodFiles(), ...tree("gamma", simpleSkill("gamma"), { g: "g\n" }) };
}

function alphaWithoutGuide() {
  return tree("alpha", ALPHA_SKILL.replaceAll("`references/guide.md`", "`references/other-ref.md`"), { "other-ref": ALPHA_OTHER });
}
