import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("marketplace.mjs", import.meta.url));

const VALID_PKG = {
  name: "bb-plugin-x",
  version: "0.1.0",
  bb: {
    name: "Plugin X",
    description: "A test plugin.",
    branding: { icon: "Sparkles" },
    server: "./server.ts",
  },
};

const ONE_PLUGIN = { plugins: [{ name: "x", source: "./plugins/x" }] };

// Every case runs a copy of the generator against fixtures in a fresh temp
// dir, so the real repo files are never read or written.
function makeRepo(t, collection, packages) {
  const root = mkdtempSync(join(tmpdir(), "marketplace-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "scripts"), { recursive: true });
  cpSync(script, join(root, "scripts", "marketplace.mjs"));
  mkdirSync(join(root, ".bb"), { recursive: true });
  writeFileSync(join(root, ".bb", "plugins.json"), JSON.stringify(collection, null, 2));
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

test("invalid fixtures exit 1, name the plugin id, and write nothing", (t) => {
  const noDescription = structuredClone(VALID_PKG);
  delete noDescription.bb.description;
  const cases = [
    { pkg: noDescription },
    { pkg: { ...VALID_PKG, bb: { ...VALID_PKG.bb, branding: { icon: "./assets/icon.svg" } } } },
    { collection: { plugins: [{ name: "x", source: "./plugins/other" }] } },
    { collection: ONE_PLUGIN, packages: {} },
    { pkg: { ...VALID_PKG, name: "@scope/bb-plugin-wrong" } },
    { pkg: { ...VALID_PKG, version: "1.2" } },
    { pkg: { ...VALID_PKG, version: "latest" } },
  ];
  for (const { pkg = VALID_PKG, collection = ONE_PLUGIN, packages = { x: pkg } } of cases) {
    const root = makeRepo(t, collection, packages);
    const result = run(root);
    assert.equal(result.status, 1, `case ${JSON.stringify(collection)} ${JSON.stringify(pkg)}`);
    assert.match(result.stderr, /^marketplace: x: /m);
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
