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
const VERSION_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$/;

// The catalog is public and mirrored and the schema forbids an email in the
// author block, so keep a plugin's own author name only when it has one.
function pluginAuthorName(author) {
  if (typeof author === "string") {
    return author.replace(/<[^>]*>/g, "").replace(/\([^)]*\)/g, "").trim();
  }
  if (typeof author === "object" && author !== null && typeof author.name === "string") {
    return author.name.trim();
  }
  return "";
}

const root = fileURLToPath(new URL("..", import.meta.url));

const args = process.argv.slice(2);
if (args.length > 1) {
  console.error("marketplace: expected at most one argument; usage: node scripts/marketplace.mjs [--check]");
  process.exit(1);
}
if (args.length === 1 && args[0] !== "--check") {
  console.error(`marketplace: unknown argument ${args[0]}; usage: node scripts/marketplace.mjs [--check]`);
  process.exit(1);
}

let collection;
try {
  collection = JSON.parse(readFileSync(join(root, ".bb/plugins.json"), "utf8"));
} catch (error) {
  console.error(`marketplace: cannot read .bb/plugins.json (${error.message})`);
  process.exit(1);
}
if (collection === null || typeof collection !== "object" || !Array.isArray(collection.plugins)) {
  console.error("marketplace: cannot read .bb/plugins.json (the plugins field must be an array)");
  process.exit(1);
}

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

for (const entry of collection.plugins) {
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
    errors.push(`marketplace: ${JSON.stringify(entry)}: collection entry must be an object`);
    continue;
  }
  const { name: id, source } = entry;
  if (typeof id !== "string") {
    errors.push(`marketplace: ${JSON.stringify(id)}: name must be a string`);
    continue;
  }
  const fail = (msg) => errors.push(`marketplace: ${id}: ${msg}`);
  const errorsBefore = errors.length;

  if (!ID_RE.test(id)) fail(`id must match ${ID_RE.source}`);
  if (id.length > 127) fail("id must be at most 127 characters (the schema caps the <id>/ tag prefix at 128)");
  if (seen.has(id)) fail("duplicate id in the collection");
  seen.add(id);

  let subdir = "";
  if (typeof source !== "string") {
    fail("source must be a string");
  } else {
    subdir = source.replace(/^\.\//, "");
    if (subdir !== `plugins/${id}`) {
      fail(`source "${source}" must be "./plugins/${id}" — release tags are cut per plugin directory`);
    }
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
    if (pkg === null || typeof pkg !== "object" || Array.isArray(pkg)) {
      fail(`${subdir}/package.json must be a JSON object`);
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
    const authorName = pluginAuthorName(pkg.author);
    // An author that is present but nameless must not fall back to the
    // marketplace author — that would misattribute someone else's plugin.
    if (authorName === "" && pkg.author !== undefined) {
      fail("package.json author has no name; add a name, or remove author to list the plugin under the marketplace author");
    }
    // A lone leading @ reads as a handle; any other @ reads as an email.
    if (authorName.slice(1).includes("@")) {
      fail('package.json author must be a name without "@" after the first character (emails are not published)');
    }

    if (errors.length === errorsBefore) {
      const major = pkg.version.split("-")[0].split(".")[0];
      doc.plugins.push({
        id,
        displayName: pkg.bb.name,
        description: pkg.bb.description,
        icon,
        author: authorName === "" ? MARKETPLACE.author : { name: authorName },
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

if (args.length === 1) {
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
