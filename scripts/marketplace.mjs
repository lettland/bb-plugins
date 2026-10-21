import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Branding of the published marketplace. Users add the catalog from
// git:https://github.com/lettland/bb-plugins.git@master; each entry installs
// from its plugin's own <id>/vX.Y.Z release tags (range + tagPrefix).
const MARKETPLACE = {
  name: "lettland-plugins",
  displayName: "Lettland plugins",
  description: "Lettland's bb plugins: agent hooks, auto review, devkit and more.",
  author: { name: "Lettland", github: "lettland", url: "https://github.com/lettland" },
  gitUrl: "https://github.com/lettland/bb-plugins.git",
};

const ID_RE = /^[a-z0-9][a-z0-9-]*$/;
const ICON_RE = /^[A-Za-z][A-Za-z0-9]*$/;
const VERSION_RE = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

const root = fileURLToPath(new URL("..", import.meta.url));
const collection = JSON.parse(readFileSync(join(root, ".bb/plugins.json"), "utf8"));

const doc = {
  $schema: "https://getbb.app/schemas/marketplace.schema.json",
  schemaVersion: 1,
  name: MARKETPLACE.name,
  displayName: MARKETPLACE.displayName,
  description: MARKETPLACE.description,
  plugins: [],
};
const errors = [];
const seen = new Set();

for (const { name: id, source } of collection.plugins) {
  const fail = (msg) => errors.push(`marketplace: ${id}: ${msg}`);
  const errorsBefore = errors.length;

  if (!ID_RE.test(id)) fail(`id must match ${ID_RE.source}`);
  if (seen.has(id)) fail("duplicate id in the collection");
  seen.add(id);

  const subdir = source.replace(/^\.\//, "");
  if (subdir !== `plugins/${id}`) {
    fail(`source "${source}" must be "./plugins/${id}" — release tags are cut per plugin directory`);
  }

  // Read the package only once the entry itself checks out; a mismatched
  // source would otherwise fail on a file that does not exist.
  if (errors.length === errorsBefore) {
    let pkg;
    try {
      pkg = JSON.parse(readFileSync(join(root, source, "package.json"), "utf8"));
    } catch (error) {
      fail(`cannot read ${subdir}/package.json (${error.message})`);
      continue;
    }
    const pkgName = typeof pkg.name === "string" ? pkg.name : "";

    if (pkgName !== `bb-plugin-${id}` && !(pkgName.startsWith("@") && pkgName.endsWith(`/bb-plugin-${id}`))) {
      fail(`package.json name "${pkgName}" must be "bb-plugin-${id}" or "@<scope>/bb-plugin-${id}"`);
    }
    if (typeof pkg.bb?.name !== "string" || pkg.bb.name === "") fail("bb.name must be a non-empty string");
    if (typeof pkg.bb?.description !== "string" || pkg.bb.description === "") {
      fail("bb.description must be a non-empty string");
    }

    const icon = pkg.bb?.branding?.icon;
    if (typeof icon !== "string" || !ICON_RE.test(icon)) {
      fail(
        typeof icon === "string" && /[\\/]/.test(icon)
          ? `bb.branding.icon "${icon}" is a path — path icons are not supported by this generator; use a host icon name`
          : `bb.branding.icon must be a host icon name matching ${ICON_RE.source}`,
      );
    }
    if (typeof pkg.version !== "string" || !VERSION_RE.test(pkg.version)) {
      fail(`version ${JSON.stringify(pkg.version)} must match ${VERSION_RE.source}`);
    }

    if (errors.length === errorsBefore) {
      const major = pkg.version.split("-")[0].split(".")[0];
      doc.plugins.push({
        id,
        displayName: pkg.bb.name,
        description: pkg.bb.description,
        icon,
        author: MARKETPLACE.author,
        source: {
          git: {
            url: MARKETPLACE.gitUrl,
            subdir,
            range: `${major}.x`,
            tagPrefix: `${id}/`,
          },
        },
      });
    }
  }
}

const output = JSON.stringify(doc, null, 2) + "\n";

if (errors.length > 0) {
  for (const error of errors) console.error(error);
  process.exit(1);
}

if (process.argv.includes("--check")) {
  let onDisk;
  try {
    onDisk = readFileSync(join(root, "marketplace.json"), "utf8");
  } catch {
    // Missing counts as different.
  }
  if (onDisk !== output) {
    console.error("marketplace.json is out of date; run: node scripts/marketplace.mjs");
    process.exit(1);
  }
} else {
  writeFileSync(join(root, "marketplace.json"), output);
}
