import path from "node:path";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import {
  DEFAULT_WORKTREE_CONTAINER_ROOT,
  MANIFEST_FILE_NAME,
  MANIFEST_VERSION,
  PLACEHOLDER_PATTERN,
  PRIMARY_ROOT_PLACEHOLDER,
  assertString,
  deny,
  isPlainObject,
  validateRepositoryRelativePath,
} from "./manifest-primitives.mjs";
import { validateOperations } from "./manifest-operations.mjs";
import {
  validateCompose,
  validateContainers,
  validateDependency,
  validateGit,
  validateIsolation,
  validateLifecycle,
  validateScratch,
  validateSearch,
  validateWorktrees,
} from "./manifest-sections.mjs";

export {
  DEFAULT_WORKTREE_CONTAINER_ROOT,
  MANIFEST_FILE_NAME,
  MANIFEST_VERSION,
  PRIMARY_ROOT_PLACEHOLDER,
  validateRepositoryRelativePath,
};

function requiresIsolation(manifest) {
  return (
    Object.values(manifest.operations).some((operation) =>
      operation.kind !== "sequence"
        ? operation.step.kind === "container" || operation.target?.variants
        : true,
    ) || manifest.git.generators.length > 0
  );
}

export function validateManifest(document) {
  if (!isPlainObject(document)) {
    deny("document must be a JSON object");
  }
  if (document.version !== MANIFEST_VERSION) {
    deny(`version must be ${MANIFEST_VERSION}`);
  }
  const manifest = {
    version: MANIFEST_VERSION,
    name:
      document.name === undefined ? null : assertString(document.name, "name"),
    containers: validateContainers(document.containers),
    scratch: validateScratch(document.scratch),
    lifecycle: validateLifecycle(document.lifecycle),
    worktrees: validateWorktrees(document.worktrees),
    search: validateSearch(document.search),
    compose: validateCompose(document.compose),
  };
  manifest.isolation = validateIsolation(document.isolation, manifest.containers);

  if (document.dependencies !== undefined && !Array.isArray(document.dependencies)) {
    deny("dependencies must be an array");
  }
  manifest.dependencies = Object.freeze(
    (document.dependencies ?? []).map((entry, index) => validateDependency(entry, index)),
  );

  manifest.operations = Object.freeze(validateOperations(manifest, document.operations));
  manifest.git = validateGit(manifest, document.git);

  if (requiresIsolation(manifest) && manifest.isolation === null) {
    deny("isolation.builder is required when container operations are declared");
  }
  return Object.freeze(manifest);
}

export function manifestDigest(content) {
  return createHash("sha256").update(content).digest("hex");
}

export async function readManifest(primaryRoot, configuredPath) {
  const manifestPath = configuredPath ?? path.join(primaryRoot, MANIFEST_FILE_NAME);
  if (!path.isAbsolute(manifestPath)) {
    deny("manifest path must be absolute");
  }
  let content;
  try {
    content = await readFile(manifestPath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error(`Shared runtime manifest missing: ${manifestPath}`);
    }
    throw error;
  }
  let document;
  try {
    document = JSON.parse(content.toString("utf8"));
  } catch {
    deny(`${manifestPath} is not valid JSON`);
  }
  return Object.freeze({
    digest: manifestDigest(content),
    manifest: validateManifest(document),
    path: manifestPath,
  });
}

export function substitutePlaceholders(value, variables, label = "value") {
  return value.replace(PLACEHOLDER_PATTERN, (_match, name) => {
    if (!Object.hasOwn(variables, name)) {
      throw new Error(`Shared runtime denied: ${label} references unresolved placeholder ${JSON.stringify(name)}`);
    }
    return variables[name];
  });
}

export function listOperationNames(manifest) {
  return Object.keys(manifest.operations).sort();
}

export function describeOperations(manifest) {
  return listOperationNames(manifest).map((name) => {
    const operation = manifest.operations[name];
    if (operation.kind === "sequence") {
      const parts = operation.steps.map((step) =>
        step.reference !== undefined
          ? step.reference
          : `${step.kind}:${step.kind === "host" ? step.script : step.argv[0]}`,
      );
      return `${name} (sequence: ${parts.join(", ")})`;
    }
    const target = operation.target;
    if (target === null) {
      return name;
    }
    if (target.variants) {
      return `${name} (target one of ${Object.keys(target.variants).map((value) => JSON.stringify(value)).join(", ")})`;
    }
    return `${name} (${target.required ? "requires" : "accepts"} target matching ${target.patternSource}${target.description ? `: ${target.description}` : ""})`;
  });
}

function expandWildcardSegments(segments, primaryRoot, readDirectory) {
  return (async () => {
    let candidates = [{ relative: [], captures: [] }];
    for (const segment of segments) {
      const next = [];
      for (const candidate of candidates) {
        if (segment !== "*") {
          next.push({
            relative: [...candidate.relative, segment],
            captures: candidate.captures,
          });
          continue;
        }
        const directory = path.join(primaryRoot, ...candidate.relative);
        let entries;
        try {
          entries = await readDirectory(directory);
        } catch (error) {
          if (error?.code === "ENOENT" || error?.code === "ENOTDIR") {
            continue;
          }
          throw error;
        }
        for (const entry of entries) {
          if (!entry.isDirectory() || entry.name.startsWith(".")) {
            continue;
          }
          next.push({
            relative: [...candidate.relative, entry.name],
            captures: [...candidate.captures, entry.name],
          });
        }
      }
      candidates = next;
    }
    return candidates;
  })();
}

function fillTemplate(template, captures) {
  let index = 0;
  return template
    .split("/")
    .map((segment) => (segment === "*" ? captures[index++] : segment))
    .join("/");
}

export async function expandDependencies(manifest, primaryRoot, { readDirectory, pathExists }) {
  const expanded = [];
  for (const dependency of manifest.dependencies) {
    const segments = dependency.path.split("/");
    if (!segments.includes("*")) {
      expanded.push({ ...dependency, relativePath: dependency.path, containerTarget: dependency.target });
      continue;
    }
    const matches = await expandWildcardSegments(segments, primaryRoot, readDirectory);
    for (const match of matches) {
      const relativePath = match.relative.join("/");
      if (!(await pathExists(path.join(primaryRoot, ...match.relative)))) {
        continue;
      }
      expanded.push({
        ...dependency,
        relativePath,
        containerTarget: fillTemplate(dependency.target, match.captures),
      });
    }
  }
  return expanded;
}
