import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("marketplace.mjs", import.meta.url));

const VALID_PKG = {
  name: "@scope/bb-plugin-x",
  version: "0.1.0",
  bb: {
    name: "Plugin X",
    description: "A test plugin.",
    branding: { icon: "Sparkles" },
    server: "./server.ts",
  },
};

const ONE_PLUGIN = { plugins: [{ name: "x", source: "./plugins/x" }] };
const LONG_ID = "a".repeat(128);

// Every case runs a copy of the generator against fixtures in a fresh temp
// dir, so the real repo files are never read or written.
function makeRepo(t, collection, packages) {
  const root = mkdtempSync(join(tmpdir(), "marketplace-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "scripts"), { recursive: true });
  cpSync(script, join(root, "scripts", "marketplace.mjs"));
  mkdirSync(join(root, ".bb"), { recursive: true });
  writeFileSync(
    join(root, ".bb", "plugins.json"),
    typeof collection === "string" ? collection : JSON.stringify(collection, null, 2),
  );
  for (const [id, pkg] of Object.entries(packages)) {
    mkdirSync(join(root, "plugins", id), { recursive: true });
    writeFileSync(join(root, "plugins", id, "package.json"), JSON.stringify(pkg, null, 2));
  }
  return root;
}

const run = (root, args = []) =>
  spawnSync(process.execPath, [join(root, "scripts", "marketplace.mjs"), ...args], { encoding: "utf8" });

const readDoc = (root) => JSON.parse(readFileSync(join(root, "marketplace.json"), "utf8"));

test("a valid fixture produces the expected marketplace.json", (t) => {
  const root = makeRepo(t, ONE_PLUGIN, { x: VALID_PKG });
  assert.equal(run(root).status, 0);
  const doc = readDoc(root);
  assert.deepEqual(doc, {
    $schema: "https://getbb.app/schemas/marketplace.schema.json",
    schemaVersion: 1,
    name: "lettland-plugins",
    displayName: "Lettland plugins",
    description: "Lettland's bb plugins: agent hooks, auto review, devkit and more.",
    plugins: [
      {
        id: "x",
        displayName: "Plugin X",
        description: "A test plugin.",
        icon: "Sparkles",
        author: { name: "Lettland", github: "lettland", url: "https://github.com/lettland" },
        source: {
          git: {
            url: "https://github.com/lettland/bb-plugins.git",
            subdir: "plugins/x",
            range: "0.x",
            tagPrefix: "x/",
          },
        },
      },
    ],
  });
  assert.deepEqual(Object.keys(doc), ["$schema", "schemaVersion", "name", "displayName", "description", "plugins"]);
  assert.deepEqual(Object.keys(doc.plugins[0]), ["id", "displayName", "description", "icon", "author", "source"]);
  assert.deepEqual(Object.keys(doc.plugins[0].source.git), ["url", "subdir", "range", "tagPrefix"]);
});

test("an unscoped package name is accepted too", (t) => {
  const root = makeRepo(t, ONE_PLUGIN, { x: { ...VALID_PKG, name: "bb-plugin-x" } });
  assert.equal(run(root).status, 0);
  assert.equal(readDoc(root).plugins[0].id, "x");
});

test("a string author is reduced to the bare name", (t) => {
  const root = makeRepo(t, ONE_PLUGIN, {
    x: { ...VALID_PKG, author: "Jane Doe <jane@example.com> (https://example.com)" },
  });
  assert.equal(run(root).status, 0);
  assert.deepEqual(readDoc(root).plugins[0].author, { name: "Jane Doe" });
  const text = readFileSync(join(root, "marketplace.json"), "utf8");
  assert.ok(!text.includes("jane@example.com"), text);
  assert.ok(!text.includes("https://example.com"), text);
});

test("an object author keeps the name only", (t) => {
  const root = makeRepo(t, ONE_PLUGIN, {
    x: { ...VALID_PKG, author: { name: "Jane Doe", email: "jane@example.com" } },
  });
  assert.equal(run(root).status, 0);
  assert.deepEqual(readDoc(root).plugins[0].author, { name: "Jane Doe" });
});

test("a bare handle is accepted as a name", (t) => {
  const root = makeRepo(t, ONE_PLUGIN, { x: { ...VALID_PKG, author: "@janedoe" } });
  assert.equal(run(root).status, 0);
  assert.deepEqual(readDoc(root).plugins[0].author, { name: "@janedoe" });
});

test("a 127-character id is accepted at the schema's tagPrefix limit", (t) => {
  const id = "b".repeat(127);
  const root = makeRepo(
    t,
    { plugins: [{ name: id, source: `./plugins/${id}` }] },
    { [id]: { ...VALID_PKG, name: `bb-plugin-${id}` } },
  );
  assert.equal(run(root).status, 0);
  const tagPrefix = readDoc(root).plugins[0].source.git.tagPrefix;
  assert.equal(tagPrefix, `${id}/`);
  assert.equal(tagPrefix.length, 128);
});

test("the range tracks the version's major", (t) => {
  const root = makeRepo(t, ONE_PLUGIN, { x: { ...VALID_PKG, version: "1.2.3" } });
  assert.equal(run(root).status, 0);
  assert.equal(readDoc(root).plugins[0].source.git.range, "1.x");
});

test("a prerelease version still yields the core's major", (t) => {
  const root = makeRepo(t, ONE_PLUGIN, { x: { ...VALID_PKG, version: "0.1.35-beta.0" } });
  assert.equal(run(root).status, 0);
  assert.equal(readDoc(root).plugins[0].source.git.range, "0.x");
});

test("invalid fixtures exit 1 with the expected message and write nothing", (t) => {
  const noName = structuredClone(VALID_PKG);
  delete noName.bb.name;
  const noDescription = structuredClone(VALID_PKG);
  delete noDescription.bb.description;
  const noBranding = structuredClone(VALID_PKG);
  delete noBranding.bb.branding;
  const cases = [
    { fragment: "bb.name must be a non-empty string", pkg: noName },
    { fragment: "bb.description must be a non-empty string", pkg: noDescription },
    { fragment: "bb.branding.icon must be a host icon name", pkg: noBranding },
    {
      fragment: "path icons are not supported",
      pkg: { ...VALID_PKG, bb: { ...VALID_PKG.bb, branding: { icon: "./assets/icon.svg" } } },
    },
    {
      fragment: "bb.branding.icon must be a host icon name",
      pkg: { ...VALID_PKG, bb: { ...VALID_PKG.bb, branding: { icon: "sparkles-1" } } },
    },
    {
      fragment: 'source "./plugins/other" must be "./plugins/x"',
      collection: { plugins: [{ name: "x", source: "./plugins/other" }] },
    },
    { fragment: "cannot read plugins/x/package.json", collection: ONE_PLUGIN, packages: {} },
    { fragment: "must be a JSON object", collection: ONE_PLUGIN, packages: { x: null } },
    {
      fragment: 'package.json name "@scope/bb-plugin-wrong" must be "bb-plugin-x"',
      pkg: { ...VALID_PKG, name: "@scope/bb-plugin-wrong" },
    },
    {
      fragment: "duplicate id in the collection",
      collection: { plugins: [{ name: "x", source: "./plugins/x" }, { name: "x", source: "./plugins/x" }] },
    },
    { fragment: "id must match", collection: { plugins: [{ name: "X", source: "./plugins/X" }] }, packages: {}, id: "X" },
    {
      fragment: "at most 127 characters",
      collection: { plugins: [{ name: LONG_ID, source: `./plugins/${LONG_ID}` }] },
      packages: { [LONG_ID]: { ...VALID_PKG, name: `bb-plugin-${LONG_ID}` } },
      id: LONG_ID,
    },
    { fragment: 'version "1.2" must match', pkg: { ...VALID_PKG, version: "1.2" } },
    { fragment: 'version "latest" must match', pkg: { ...VALID_PKG, version: "latest" } },
    { fragment: 'version "01.2.3" must match', pkg: { ...VALID_PKG, version: "01.2.3" } },
    { fragment: "name must be a string", collection: { plugins: [{ name: 123, source: "./plugins/x" }] }, id: "123" },
    { fragment: "source must be a string", collection: { plugins: [{ name: "x" }] } },
    { fragment: "collection entry must be an object", collection: { plugins: [null] }, id: "null" },
    {
      fragment: 'must be a name without "@" after the first character',
      pkg: { ...VALID_PKG, author: "jane@example.com" },
    },
    { fragment: "package.json author has no name", pkg: { ...VALID_PKG, author: "<jane@example.com>" } },
    { fragment: "package.json author has no name", pkg: { ...VALID_PKG, author: { email: "x@y.z" } } },
    { fragment: "remove author to list the plugin under the marketplace author", pkg: { ...VALID_PKG, author: null } },
    {
      fragment: 'must be a name without "@" after the first character',
      pkg: { ...VALID_PKG, author: "jane@ example.com" },
    },
  ];
  for (const { fragment, id = "x", pkg = VALID_PKG, collection = ONE_PLUGIN, packages = { x: pkg } } of cases) {
    const root = makeRepo(t, collection, packages);
    const result = run(root);
    assert.equal(result.status, 1, `case "${fragment}": stderr: ${result.stderr}`);
    assert.ok(
      result.stderr.split("\n").some((line) => line.startsWith(`marketplace: ${id}: `) && line.includes(fragment)),
      `case "${fragment}": stderr: ${result.stderr}`,
    );
    assert.equal(existsSync(join(root, "marketplace.json")), false, `case "${fragment}" wrote marketplace.json`);
  }
});

test("an unknown argument exits 1 with usage and writes nothing", (t) => {
  const root = makeRepo(t, ONE_PLUGIN, { x: VALID_PKG });
  const result = run(root, ["--chek"]);
  assert.equal(result.status, 1);
  assert.ok(result.stderr.includes("unknown argument --chek"), `stderr: ${result.stderr}`);
  assert.ok(result.stderr.includes("usage: node scripts/marketplace.mjs [--check]"), `stderr: ${result.stderr}`);
  assert.equal(existsSync(join(root, "marketplace.json")), false);
});

test("more than one argument exits 1 with usage and writes nothing", (t) => {
  const root = makeRepo(t, ONE_PLUGIN, { x: VALID_PKG });
  const result = run(root, ["--check", "--check"]);
  assert.equal(result.status, 1);
  assert.ok(result.stderr.includes("expected at most one argument"), `stderr: ${result.stderr}`);
  assert.equal(existsSync(join(root, "marketplace.json")), false);
});

test("a malformed or shapeless .bb/plugins.json exits 1 without a stack trace", (t) => {
  for (const content of ["{ not json", "{}", "null"]) {
    const root = makeRepo(t, content, {});
    const result = run(root);
    assert.equal(result.status, 1, `content ${content}: stderr: ${result.stderr}`);
    assert.ok(result.stderr.includes("cannot read .bb/plugins.json"), `content ${content}: stderr: ${result.stderr}`);
    assert.equal(existsSync(join(root, "marketplace.json")), false);
  }
});

test("--check passes after a write and flags a hand edit", (t) => {
  const root = makeRepo(t, ONE_PLUGIN, { x: VALID_PKG });

  // The file has not been written yet — missing counts as different.
  assert.equal(run(root, ["--check"]).status, 1);

  assert.equal(run(root).status, 0);
  assert.equal(run(root, ["--check"]).status, 0);

  const file = join(root, "marketplace.json");
  const doc = readDoc(root);
  doc.plugins[0].displayName = "Renamed by hand";
  writeFileSync(file, JSON.stringify(doc, null, 2) + "\n");

  const result = run(root, ["--check"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /run: node scripts\/marketplace\.mjs/);
});
