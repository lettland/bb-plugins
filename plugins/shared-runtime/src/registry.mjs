import { constants, lstatSync, watch } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import { MANIFEST_FILE_NAME, manifestDigest, readManifest, validateManifest } from "./manifest.mjs";

export const RUNTIME_ROOT_NAME = "shared-runtime";
const PROJECT_ID_PATTERN = /^proj_[a-zA-Z0-9]+$/;
const HOST_ID_PATTERN = /^host_[a-zA-Z0-9]+$/;

function deny(message) {
  throw new Error(`Shared runtime denied: ${message}`);
}

function assertNonEmptyString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    deny(`${label} is missing or invalid`);
  }
  return value;
}

export function defaultRuntimeRoot() {
  return path.join(homedir(), ".bb", RUNTIME_ROOT_NAME);
}

export function projectsDirectory(runtimeRoot = defaultRuntimeRoot()) {
  return path.join(runtimeRoot, "projects");
}

// The per-project host directory: it holds a manifest, its scripts and its overlay for a
// project that commits no runtime files. Only proj_*.json regular files are registry
// entries, so this directory never disturbs the registry scan.
export function projectDirectoryFor(projectId, runtimeRoot = defaultRuntimeRoot()) {
  if (!PROJECT_ID_PATTERN.test(projectId)) {
    deny("project id is invalid");
  }
  return path.join(projectsDirectory(runtimeRoot), projectId);
}

export function hostManifestPathFor(projectId, runtimeRoot = defaultRuntimeRoot()) {
  return path.join(projectDirectoryFor(projectId, runtimeRoot), MANIFEST_FILE_NAME);
}

// "repo", "host-dir" or "custom": where a registered policy's manifest comes from.
export function manifestSourceOf(policy) {
  if (policy.manifestPath === undefined || policy.manifestPath === null) {
    return "repo";
  }
  if (policy.manifestPath === path.join(policy.primaryRoot, MANIFEST_FILE_NAME)) {
    return "repo";
  }
  if (
    typeof policy.runtimeRoot === "string" &&
    policy.manifestPath === hostManifestPathFor(policy.projectId, policy.runtimeRoot)
  ) {
    return "host-dir";
  }
  return "custom";
}

export function policyPathFor(projectId, runtimeRoot = defaultRuntimeRoot()) {
  if (!PROJECT_ID_PATTERN.test(projectId)) {
    deny("project id is invalid");
  }
  return path.join(projectsDirectory(runtimeRoot), `${projectId}.json`);
}

async function assertProtectedDirectory(directory, label) {
  let directoryStat;
  try {
    directoryStat = await lstat(directory);
  } catch {
    deny(`${label} is missing`);
  }
  if (
    !directoryStat.isDirectory() ||
    directoryStat.isSymbolicLink() ||
    directoryStat.uid !== process.getuid() ||
    (directoryStat.mode & 0o7777) !== 0o700 ||
    (await realpath(directory)) !== path.resolve(directory)
  ) {
    deny(`${label} has unsafe identity or permissions`);
  }
}

export function validatePolicyDocument(parsed) {
  for (const field of [
    "projectId",
    "trustedHostId",
    "primaryRoot",
    "worktreeRoot",
    "worktreeDirectoryName",
    "gitCommonDir",
    "dockerPath",
    "manifestSha256",
  ]) {
    assertNonEmptyString(parsed[field], `policy ${field}`);
  }
  if (!PROJECT_ID_PATTERN.test(parsed.projectId)) {
    deny("policy projectId is invalid");
  }
  if (!HOST_ID_PATTERN.test(parsed.trustedHostId)) {
    deny("policy trustedHostId is invalid");
  }
  if (
    parsed.worktreeDirectoryName.includes("/") ||
    parsed.worktreeDirectoryName === "." ||
    parsed.worktreeDirectoryName === ".." ||
    parsed.worktreeDirectoryName.includes("\0")
  ) {
    deny("policy worktreeDirectoryName is invalid");
  }
  if (!/^[0-9a-f]{64}$/.test(parsed.manifestSha256)) {
    deny("policy manifestSha256 is invalid");
  }
  if (!path.isAbsolute(parsed.primaryRoot) || !path.isAbsolute(parsed.worktreeRoot)) {
    deny("policy roots must be absolute");
  }
  if (!path.isAbsolute(parsed.gitCommonDir) || !path.isAbsolute(parsed.dockerPath)) {
    deny("policy executable and repository paths must be absolute");
  }
  if (
    parsed.dockerSocket !== undefined &&
    parsed.dockerSocket !== null &&
    !path.isAbsolute(assertNonEmptyString(parsed.dockerSocket, "policy Docker socket"))
  ) {
    deny("policy Docker socket must be absolute");
  }
  if (
    parsed.manifestPath !== undefined &&
    parsed.manifestPath !== null &&
    !path.isAbsolute(assertNonEmptyString(parsed.manifestPath, "policy manifest path"))
  ) {
    deny("policy manifest path must be absolute");
  }
  if (
    parsed.composeProject !== undefined &&
    parsed.composeProject !== null &&
    (parsed.composeProject === "null" ||
      !/^[a-zA-Z0-9_.-]+$/.test(
        assertNonEmptyString(parsed.composeProject, "policy Compose project"),
      ))
  ) {
    deny("policy Compose project is invalid");
  }
  if (
    typeof parsed.containers !== "object" ||
    parsed.containers === null ||
    Array.isArray(parsed.containers) ||
    Object.keys(parsed.containers).length === 0
  ) {
    deny("policy containers must map roles to container names");
  }
  for (const [role, name] of Object.entries(parsed.containers)) {
    if (!/^[a-z][a-z0-9_-]*$/.test(role)) {
      deny(`policy container role ${JSON.stringify(role)} is invalid`);
    }
    if (typeof name !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(name)) {
      deny(`policy container ${role} name is invalid`);
    }
  }
  if (
    parsed.bbCli !== undefined &&
    parsed.bbCli !== null &&
    !path.isAbsolute(assertNonEmptyString(parsed.bbCli, "policy BB CLI"))
  ) {
    deny("policy BB CLI must be absolute");
  }
  return parsed;
}

export async function loadPolicy(policyPath) {
  if (!path.isAbsolute(policyPath) || typeof process.getuid !== "function") {
    deny("policy path or current user identity is invalid");
  }
  if (typeof constants.O_NOFOLLOW !== "number" || constants.O_NOFOLLOW === 0) {
    deny("host does not expose no-follow policy opening");
  }
  const projectsRoot = path.dirname(policyPath);
  await assertProtectedDirectory(path.dirname(projectsRoot), "policy runtime directory");
  await assertProtectedDirectory(projectsRoot, "policy projects directory");

  let policyHandle;
  try {
    policyHandle = await open(policyPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    deny("policy file is missing or not a regular file");
  }

  let policyContent;
  try {
    const policyStat = await policyHandle.stat();
    if (
      !policyStat.isFile() ||
      policyStat.uid !== process.getuid() ||
      policyStat.nlink !== 1 ||
      (policyStat.mode & 0o7777) !== 0o600
    ) {
      deny("policy file has unsafe identity, links, or permissions");
    }
    policyContent = await policyHandle.readFile("utf8");
  } finally {
    await policyHandle.close();
  }

  const parsed = validatePolicyDocument(JSON.parse(policyContent));
  const expectedName = `${parsed.projectId}.json`;
  if (path.basename(policyPath) !== expectedName) {
    deny(`policy file name must be ${expectedName}`);
  }
  const runtimeRoot = path.dirname(projectsRoot);
  // scriptRoot is derived here and never read from the policy file: a host-directory
  // manifest resolves its scripts in that directory, every other manifest in the primary
  // checkout. The spread comes first so a scriptRoot key in the file cannot win.
  const scriptRoot =
    manifestSourceOf({ ...parsed, runtimeRoot }) === "host-dir"
      ? projectDirectoryFor(parsed.projectId, runtimeRoot)
      : parsed.primaryRoot;
  return Object.freeze({ ...parsed, runtimeRoot, scriptRoot });
}

function trustFailure(message, fix) {
  throw new Error(`Shared runtime denied: ${message}; fix: ${fix}`);
}

function assertCurrentUser(stats, target) {
  if (stats.uid !== process.getuid()) {
    trustFailure(`${target} is not owned by the current user`, `chown "$(id -un)" ${target}`);
  }
}

// Reads a host-directory manifest only if the directory and the file are not writable by
// anyone but the current user and are not links: a branch-controlled checkout can then
// never change what a registered project runs. The bytes come from the checked
// descriptor, never from a second open by path.
export async function readTrustedHostManifest(directory, manifestPath) {
  let directoryStat;
  try {
    directoryStat = await lstat(directory);
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new Error(`Shared runtime manifest missing: ${manifestPath}`);
    }
    throw error;
  }
  if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) {
    trustFailure(`host project directory ${directory} is a symlink or not a directory`, `replace it with a real directory (mkdir -m 700 ${directory})`);
  }
  assertCurrentUser(directoryStat, directory);
  if ((directoryStat.mode & 0o7777) !== 0o700) {
    trustFailure(`host project directory ${directory} must have mode 0700`, `chmod 700 ${directory}`);
  }
  let handle;
  try {
    handle = await open(manifestPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new Error(`Shared runtime manifest missing: ${manifestPath}`);
    }
    if (error.code === "ELOOP") {
      trustFailure(`host manifest ${manifestPath} is a symlink`, `replace it with a regular file`);
    }
    throw error;
  }
  let content;
  try {
    const manifestStat = await handle.stat();
    if (!manifestStat.isFile()) {
      trustFailure(`host manifest ${manifestPath} is not a regular file`, "replace it with a regular file");
    }
    assertCurrentUser(manifestStat, manifestPath);
    if (manifestStat.nlink !== 1) {
      trustFailure(`host manifest ${manifestPath} has more than one hard link`, `copy it to a new file and remove the old one`);
    }
    if ((manifestStat.mode & 0o022) !== 0) {
      trustFailure(`host manifest ${manifestPath} is group- or world-writable`, `chmod go-w ${manifestPath}`);
    }
    content = await handle.readFile();
  } finally {
    await handle.close();
  }
  let document;
  try {
    document = JSON.parse(content.toString("utf8"));
  } catch {
    throw new Error(`Shared runtime manifest invalid: ${manifestPath} is not valid JSON`);
  }
  return Object.freeze({
    digest: manifestDigest(content),
    manifest: validateManifest(document),
    path: manifestPath,
  });
}

// The script a manifest names, resolved against the policy's script root. It never falls
// back to the primary checkout: a host-directory manifest's scripts must not quietly run
// from the branch-controlled checkout. A host-directory script is trusted only when every
// path component from the script root down is a user-owned, non-writable, non-link entry.
export function resolvePolicyScript(policy, relativeScript) {
  if (typeof policy.scriptRoot !== "string" || !path.isAbsolute(policy.scriptRoot)) {
    deny("script root is not set for this project");
  }
  const root = path.resolve(policy.scriptRoot);
  const script = path.join(root, relativeScript);
  if (root === path.resolve(policy.primaryRoot)) {
    return script;
  }
  const components = [root];
  for (const part of path.relative(root, script).split(path.sep)) {
    components.push(path.join(components.at(-1), part));
  }
  components.forEach((component, index) => {
    const isScript = index === components.length - 1;
    let stats;
    try {
      stats = lstatSync(component);
    } catch {
      deny(`host script ${component} is missing`);
    }
    if (stats.isSymbolicLink()) {
      deny(`host script path ${component} is a symlink`);
    }
    if (isScript ? !stats.isFile() : !stats.isDirectory()) {
      deny(`host script path ${component} is not a ${isScript ? "regular file" : "directory"}`);
    }
    if (stats.uid !== process.getuid()) {
      deny(`host script path ${component} is not owned by the current user`);
    }
    if ((stats.mode & 0o022) !== 0) {
      deny(`host script path ${component} is group- or world-writable`);
    }
    if (isScript && stats.nlink !== 1) {
      deny(`host script ${component} has more than one hard link`);
    }
  });
  return script;
}

export async function attachManifest(policy, { readManifestFile = readManifest } = {}) {
  let loaded;
  try {
    loaded =
      manifestSourceOf(policy) === "host-dir"
        ? await readTrustedHostManifest(projectDirectoryFor(policy.projectId, policy.runtimeRoot), policy.manifestPath)
        : await readManifestFile(policy.primaryRoot, policy.manifestPath);
  } catch (error) {
    return Object.freeze({
      ...policy,
      manifest: null,
      manifestDigest: null,
      manifestError: error?.message ?? String(error),
      manifestStale: true,
    });
  }
  return Object.freeze({
    ...policy,
    manifest: loaded.manifest,
    manifestDigest: loaded.digest,
    manifestError: null,
    manifestStale: loaded.digest !== policy.manifestSha256,
  });
}

export async function loadRegistry(runtimeRoot = defaultRuntimeRoot(), options = {}) {
  const directory = projectsDirectory(runtimeRoot);
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { policies: new Map(), problems: [] };
    }
    throw error;
  }
  const policies = new Map();
  const problems = [];
  for (const entry of entries) {
    if (!entry.isFile() || !/^proj_[a-zA-Z0-9]+\.json$/.test(entry.name)) {
      continue;
    }
    const policyPath = path.join(directory, entry.name);
    try {
      const policy = await attachManifest(await loadPolicy(policyPath), options);
      policies.set(policy.projectId, policy);
    } catch (error) {
      problems.push({ path: policyPath, message: error?.message ?? String(error) });
    }
  }
  return { policies, problems };
}

export function createRegistry({ runtimeRoot = defaultRuntimeRoot(), log = null, readManifestFile } = {}) {
  let policies = new Map();
  let problems = [];
  let watcher = null;
  let refreshTimer = null;
  let refreshing = null;

  async function refresh() {
    if (refreshing) {
      return refreshing;
    }
    refreshing = (async () => {
      try {
        const loaded = await loadRegistry(runtimeRoot, { readManifestFile });
        policies = loaded.policies;
        problems = loaded.problems;
        for (const problem of problems) {
          log?.warn?.(`shared runtime registry entry skipped: ${problem.path}: ${problem.message}`);
        }
      } finally {
        refreshing = null;
      }
      return policies;
    })();
    return refreshing;
  }

  function scheduleRefresh() {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      refresh().catch((error) => log?.warn?.(`shared runtime registry refresh failed: ${error?.message ?? error}`));
    }, 250);
    refreshTimer.unref?.();
  }

  function startWatching() {
    if (watcher) {
      return;
    }
    try {
      watcher = watch(projectsDirectory(runtimeRoot), { persistent: false }, scheduleRefresh);
      watcher.on("error", () => {
        watcher = null;
      });
    } catch {
      watcher = null;
    }
  }

  return {
    async load() {
      await refresh();
      startWatching();
      return policies;
    },
    refresh,
    policyFor(projectId) {
      return policies.get(projectId) ?? null;
    },
    entries() {
      return [...policies.values()];
    },
    problems() {
      return [...problems];
    },
    dispose() {
      clearTimeout(refreshTimer);
      watcher?.close();
      watcher = null;
      policies = new Map();
    },
  };
}
