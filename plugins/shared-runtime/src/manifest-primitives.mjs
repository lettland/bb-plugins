import path from "node:path";

export const MANIFEST_FILE_NAME = ".bb-runtime.json";
export const MANIFEST_VERSION = 1;
export const DEFAULT_WORKTREE_CONTAINER_ROOT = "/bb-worktrees";
export const PRIMARY_ROOT_PLACEHOLDER = "${primaryRoot}";
export const NAME_PATTERN = /^[a-z][a-z0-9_]*$/;
export const ROLE_PATTERN = /^[a-z][a-z0-9_-]*$/;
export const SERVICE_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;
export const PLACEHOLDER_PATTERN = /\$\{([a-zA-Z0-9_.-]+)\}/g;
export const SHELL_INTERPRETERS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish"]);
export const SCRIPT_INTERPRETERS = new Set(["node", "nodejs", "php", "python", "python3", "perl", "ruby"]);
export const LIFECYCLE_OPERATIONS = Object.freeze(["ensure", "recreate", "stop"]);

export function deny(message) {
  throw new Error(`Shared runtime manifest invalid: ${message}`);
}

export function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function assertString(value, label) {
  if (typeof value !== "string" || value.trim() === "" || value.includes("\0")) {
    deny(`${label} must be a non-empty string`);
  }
  return value;
}

export function assertOptionalBoolean(value, label) {
  if (value !== undefined && typeof value !== "boolean") {
    deny(`${label} must be a boolean`);
  }
  return value === true;
}

export function validateRepositoryRelativePath(value, label, { allowRoot = false } = {}) {
  assertString(value, label);
  if (path.posix.isAbsolute(value) || value.startsWith("-") || value.includes("\\")) {
    deny(`${label} must be a repository-relative POSIX path`);
  }
  const normalized = path.posix.normalize(value);
  if (normalized === "." || normalized === "./") {
    if (!allowRoot) {
      deny(`${label} may not be the repository root`);
    }
    return ".";
  }
  if (
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.includes("/../") ||
    normalized.endsWith("/..")
  ) {
    deny(`${label} escapes the repository`);
  }
  return normalized.replace(/\/+$/, "");
}

export function assertAbsoluteContainerPath(value, label) {
  assertString(value, label);
  if (!path.posix.isAbsolute(value) || value.includes("\\")) {
    deny(`${label} must be an absolute container path`);
  }
  const normalized = path.posix.normalize(value);
  if (normalized.includes("/../") || normalized.endsWith("/..")) {
    deny(`${label} escapes its root`);
  }
  return normalized === "/" ? "/" : normalized.replace(/\/+$/, "");
}

export function assertArgv(value, label) {
  if (!Array.isArray(value) || value.length === 0) {
    deny(`${label} must be a non-empty argument array`);
  }
  for (const [index, argument] of value.entries()) {
    if (typeof argument !== "string" || argument.includes("\0")) {
      deny(`${label}[${index}] must be a string`);
    }
  }
  const program = value[0];
  if (program === "" || program.startsWith("-")) {
    deny(`${label} program is invalid`);
  }
  const base = path.posix.basename(program);
  if (SHELL_INTERPRETERS.has(base)) {
    if (value.length < 2 || value.slice(1).some((argument) => /^-(?:c|i|s)$/.test(argument))) {
      deny(`${label} may not evaluate inline shell text`);
    }
  }
  if (SCRIPT_INTERPRETERS.has(base)) {
    if (value.slice(1).some((argument) => /^(?:-e|--eval|-p|--print|-r)$/.test(argument))) {
      deny(`${label} may not evaluate inline script text`);
    }
  }
  return [...value];
}

function collectPlaceholders(value, into) {
  for (const match of value.matchAll(PLACEHOLDER_PATTERN)) {
    into.add(match[1]);
  }
}

export function assertEnvironment(value, label) {
  if (value === undefined) {
    return {};
  }
  if (!isPlainObject(value)) {
    deny(`${label} must be an object`);
  }
  const environment = {};
  for (const [name, entry] of Object.entries(value)) {
    if (!/^[A-Z_][A-Z0-9_]*$/.test(name)) {
      deny(`${label} name ${JSON.stringify(name)} is invalid`);
    }
    if (typeof entry !== "string" || entry.includes("\0")) {
      deny(`${label}.${name} must be a string`);
    }
    environment[name] = entry;
  }
  return environment;
}

export function knownPlaceholders(manifest, { allowTarget = false, host = false } = {}) {
  const names = new Set([
    "root",
    "cwd",
    "env",
    "envSlug",
    "tmp",
    "runtime",
    "primaryRoot",
    "hostRoot",
    "docker",
  ]);
  if (allowTarget) {
    names.add("target");
  }
  for (const scratchName of Object.keys(manifest.scratch)) {
    names.add(`scratch.${scratchName}`);
  }
  for (const role of Object.keys(manifest.containers)) {
    names.add(`launcher.${role}`);
    names.add(`root.${role}`);
    names.add(`runtime.${role}`);
  }
  if (host) {
    names.add("worktreeRoot");
  }
  return names;
}

export function assertPlaceholders(values, allowed, label) {
  const used = new Set();
  for (const value of values) {
    collectPlaceholders(value, used);
  }
  for (const name of used) {
    if (!allowed.has(name)) {
      deny(`${label} references unknown placeholder ${JSON.stringify(name)}`);
    }
  }
  return used;
}
