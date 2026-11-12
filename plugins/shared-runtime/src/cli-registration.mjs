import path from "node:path";
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

import { MANIFEST_FILE_NAME, readManifest } from "./manifest.mjs";
import {
  defaultRuntimeRoot,
  hostManifestPathFor,
  loadRegistry,
  policyPathFor,
  projectDirectoryFor,
  projectsDirectory,
  readTrustedHostManifest,
} from "./registry.mjs";
import {
  pathExists,
  execFile,
  commandPath,
  resolveBbCli,
  bb,
  bbJson,
  requirePrimaryCheckout,
  resolveComposeProject,
  resolveDockerSocket,
  resolveProject,
} from "./cli-host.mjs";
import { CliError } from "./cli-arguments.mjs";

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const PLUGIN_ID = "shared-runtime";

function worktreeDirectoryNameFor(project) {
  const name = typeof project.name === "string" ? project.name.trim() : "";
  if (name === "" || name.includes("/") || name === "." || name === "..") {
    throw new CliError(`BB project ${project.id} has a name that cannot be a worktree directory`);
  }
  return name;
}

async function writeProtectedJson(target, document) {
  const directory = path.dirname(target);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = `${target}.tmp-${process.pid}`;
  await rm(temporary, { force: true });
  await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, target);
}

async function ensureProtectedDirectories(runtimeRoot) {
  for (const directory of [runtimeRoot, projectsDirectory(runtimeRoot), path.join(runtimeRoot, "locks")]) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const directoryStat = await lstat(directory);
    if ((directoryStat.mode & 0o777) !== 0o700) {
      await execFile("chmod", ["0700", directory]);
    }
  }
}

async function pluginState(cli) {
  const listed = await bbJson(cli, ["plugin", "list"]);
  const plugins = Array.isArray(listed) ? listed : listed.plugins ?? [];
  return plugins.find((plugin) => plugin.id === PLUGIN_ID) ?? null;
}

async function installOrReloadPlugin(cli, { reload }) {
  const existing = await pluginState(cli);
  if (!existing) {
    await bb(cli, ["plugin", "install", "--yes", pluginRoot]);
    return "installed";
  }
  if (!reload) {
    return "registered";
  }
  await bb(cli, ["plugin", "reload", PLUGIN_ID]);
  return "reloaded";
}

export function containerNames(manifest, composeProject) {
  const names = {};
  for (const [role, container] of Object.entries(manifest.containers)) {
    if (container.containerName !== null) {
      names[role] = container.containerName;
      continue;
    }
    if (composeProject === null) {
      throw new CliError(
        `containers.${role} needs a Compose project name to derive its container name; pass --compose-project or declare compose.envFile and compose.projectVariable`,
      );
    }
    names[role] = `${composeProject}_${container.service}`;
  }
  return names;
}

// The lines that keep the per-project runtime files out of `git status` for a project
// whose manifest lives in the host directory.
export const GIT_EXCLUDE_LINES = Object.freeze(["/.bb-runtime/", "/.bb-runtime-isolation-*/"]);

// `git rev-parse --git-path info/exclude` resolves a symlinked exclude file to its target,
// which would hide the link from O_NOFOLLOW; ask for the directory and join the name.
async function gitExcludePath(primaryRoot) {
  const { stdout } = await execFile("git", [
    "-C",
    primaryRoot,
    "rev-parse",
    "--path-format=absolute",
    "--git-path",
    "info",
  ]);
  return path.join(stdout.trim(), "exclude");
}

// Appends the missing exclude lines. It never rewrites an existing line, refuses to write
// through a symlink, and fails loudly when the file cannot be read or written.
export async function ensureGitExcludes(primaryRoot) {
  const excludePath = await gitExcludePath(primaryRoot);
  await mkdir(path.dirname(excludePath), { recursive: true });
  let handle;
  try {
    handle = await open(
      excludePath,
      constants.O_RDWR | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW,
      0o644,
    );
  } catch (error) {
    throw new CliError(
      error.code === "ELOOP"
        ? `Refusing to write ${excludePath}: it is a symlink`
        : `Cannot open ${excludePath} for appending: ${error.message}`,
    );
  }
  try {
    const content = await handle.readFile("utf8");
    const present = new Set(content.split(/\r?\n/).map((line) => line.trim()));
    const missing = GIT_EXCLUDE_LINES.filter((line) => !present.has(line));
    if (missing.length > 0) {
      const separator = content !== "" && !content.endsWith("\n") ? "\n" : "";
      await handle.appendFile(`${separator}${missing.join("\n")}\n`);
    }
  } finally {
    await handle.close();
  }
}

export async function gitExcludeStatus(primaryRoot) {
  const excludePath = await gitExcludePath(primaryRoot);
  let content = "";
  try {
    content = await readFile(excludePath, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }
  const present = new Set(content.split(/\r?\n/).map((line) => line.trim()));
  return { excludePath, missing: GIT_EXCLUDE_LINES.filter((line) => !present.has(line)) };
}

// Which manifest a command uses, in order: --manifest; the registered policy's path
// (validate and compose-overlay only); the host project directory; the repository file.
// Two candidates without --manifest, or none, is an error rather than a guess.
export async function resolveManifestLocation({
  explicit = null,
  registeredPath = null,
  projectId = null,
  runtimeRoot,
  primaryRoot,
}) {
  if (explicit !== null) {
    return { path: path.resolve(explicit), source: "explicit" };
  }
  if (registeredPath !== null) {
    return { path: registeredPath, source: "registered" };
  }
  const repoPath = path.join(primaryRoot, MANIFEST_FILE_NAME);
  const hostPath = projectId === null ? null : hostManifestPathFor(projectId, runtimeRoot);
  const hostExists = hostPath !== null && (await pathExists(hostPath));
  const repoExists = await pathExists(repoPath);
  if (hostExists && repoExists) {
    throw new CliError(
      `two manifests: ${hostPath} and ${repoPath}; remove one or pass --manifest`,
    );
  }
  if (hostExists) {
    return { path: hostPath, source: "host-dir" };
  }
  if (repoExists) {
    return { path: repoPath, source: "repo" };
  }
  const hostSearched =
    hostPath ??
    `${path.join(projectsDirectory(runtimeRoot), "<projectId>")}${path.sep}${MANIFEST_FILE_NAME} (skipped: no single BB project was resolved)`;
  throw new CliError(
    `No manifest found. Searched: ${hostSearched}, then ${repoPath}. Create one of them, or pass --manifest. Find the project id with \`bb project list\`; the project directory is ${path.join(projectsDirectory(runtimeRoot), "<projectId>")}${path.sep}.`,
  );
}

// Reads the resolved manifest; a manifest inside the host project directory goes through
// the trust checks, every other one through the plain reader.
export async function loadResolvedManifest(location, { primaryRoot, projectId, runtimeRoot }) {
  if (projectId !== null && location.path === hostManifestPathFor(projectId, runtimeRoot)) {
    return readTrustedHostManifest(projectDirectoryFor(projectId, runtimeRoot), location.path);
  }
  return readManifest(primaryRoot, location.path);
}

export async function commandInstall(options, { reloadByDefault }) {
  const runtimeRoot = options.values["runtime-root"]
    ? path.resolve(options.values["runtime-root"])
    : defaultRuntimeRoot();
  const requestedPrimaryRoot = options.values["primary-root"]
    ? path.resolve(options.values["primary-root"])
    : process.cwd();
  const { primaryRoot, gitCommonDir } = await requirePrimaryCheckout(requestedPrimaryRoot);
  const cli = await resolveBbCli();
  const { project, source } = await resolveProject(cli, primaryRoot, options);
  const location = await resolveManifestLocation({
    explicit: options.values.manifest ?? null,
    projectId: project.id,
    runtimeRoot,
    primaryRoot,
  });
  const loaded = await loadResolvedManifest(location, {
    primaryRoot,
    projectId: project.id,
    runtimeRoot,
  });
  const manifest = loaded.manifest;
  const hostDirectoryManifest = location.path === hostManifestPathFor(project.id, runtimeRoot);
  const dockerPath = await commandPath("docker");
  if (!dockerPath) {
    throw new CliError("docker is not on PATH");
  }
  for (const key of ["user.name", "user.email"]) {
    const { stdout } = await execFile("git", ["-C", primaryRoot, "config", "--get", key]).catch(() => ({ stdout: "" }));
    if (stdout.trim() === "") {
      throw new CliError(`Git ${key} must be configured in the primary checkout before installation`);
    }
  }
  const composeProject = await resolveComposeProject(manifest, primaryRoot, options);
  const dockerSocket = await resolveDockerSocket(dockerPath, options);
  const worktreeRoot = path.resolve(
    options.values["worktree-root"] ??
      process.env.BB_WORKTREES_ROOT ??
      path.join(homedir(), ".bb", "worktrees"),
  );
  const document = {
    projectId: project.id,
    trustedHostId: source.hostId,
    primaryRoot,
    worktreeRoot,
    worktreeDirectoryName: worktreeDirectoryNameFor(project),
    gitCommonDir,
    dockerPath,
    dockerSocket,
    composeProject,
    containers: containerNames(manifest, composeProject),
    manifestSha256: loaded.digest,
    manifestPath:
      location.path === path.join(primaryRoot, MANIFEST_FILE_NAME) ? undefined : location.path,
    bbCli: cli,
    installedAt: new Date().toISOString(),
  };
  await ensureProtectedDirectories(runtimeRoot);
  if (hostDirectoryManifest) {
    await ensureGitExcludes(primaryRoot);
  }
  await writeProtectedJson(policyPathFor(project.id, runtimeRoot), document);
  const pluginOutcome = await installOrReloadPlugin(cli, {
    reload: reloadByDefault && !options.flags.has("no-reload"),
  });
  process.stdout.write(
    `Registered ${project.name} (${project.id}) on host ${source.hostId} with manifest ${loaded.digest.slice(0, 12)}; plugin ${pluginOutcome}.\n`,
  );
  process.stdout.write(
    `Containers: ${Object.entries(document.containers)
      .map(([role, name]) => `${role}=${name}`)
      .join(", ")}\n`,
  );
}

export async function commandUninstall(options) {
  const runtimeRoot = options.values["runtime-root"]
    ? path.resolve(options.values["runtime-root"])
    : defaultRuntimeRoot();
  const { primaryRoot } = await requirePrimaryCheckout(process.cwd());
  const cli = await resolveBbCli();
  let projectId = options.values["project-id"] ?? null;
  if (projectId === null) {
    const registry = await loadRegistry(runtimeRoot);
    const matching = [...registry.policies.values()].filter(
      (policy) => policy.primaryRoot === primaryRoot,
    );
    if (matching.length !== 1) {
      throw new CliError(
        matching.length === 0
          ? `No registration exists for ${primaryRoot}`
          : "More than one registration matches this checkout; pass --project-id",
      );
    }
    projectId = matching[0].projectId;
  }
  await rm(policyPathFor(projectId, runtimeRoot), { force: true });
  const remaining = await loadRegistry(runtimeRoot);
  if (remaining.policies.size === 0 && options.flags.has("remove-plugin")) {
    if (await pluginState(cli)) {
      await bb(cli, ["plugin", "remove", PLUGIN_ID]);
    }
    process.stdout.write(`Removed registration ${projectId} and the ${PLUGIN_ID} plugin.\n`);
    return;
  }
  if (!options.flags.has("no-reload") && (await pluginState(cli))) {
    await bb(cli, ["plugin", "reload", PLUGIN_ID]);
  }
  process.stdout.write(`Removed registration ${projectId}.\n`);
}
