import path from "node:path";
import { lstat, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

import { readManifest } from "./manifest.mjs";
import {
  defaultRuntimeRoot,
  loadRegistry,
  policyPathFor,
  projectsDirectory,
} from "./registry.mjs";
import {
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

export async function commandInstall(options, { reloadByDefault }) {
  const runtimeRoot = options.values["runtime-root"]
    ? path.resolve(options.values["runtime-root"])
    : defaultRuntimeRoot();
  const requestedPrimaryRoot = options.values["primary-root"]
    ? path.resolve(options.values["primary-root"])
    : process.cwd();
  const { primaryRoot, gitCommonDir } = await requirePrimaryCheckout(requestedPrimaryRoot);
  const configuredManifestPath = options.values.manifest
    ? path.resolve(options.values.manifest)
    : undefined;
  const loaded = await readManifest(primaryRoot, configuredManifestPath);
  const manifest = loaded.manifest;
  const cli = await resolveBbCli();
  const { project, source } = await resolveProject(cli, primaryRoot, options);
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
    manifestPath: configuredManifestPath,
    bbCli: cli,
    installedAt: new Date().toISOString(),
  };
  await ensureProtectedDirectories(runtimeRoot);
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
