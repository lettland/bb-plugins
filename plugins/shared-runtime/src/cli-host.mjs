import path from "node:path";
import { execFile as execFileCallback } from "node:child_process";
import { access, lstat, readFile, realpath, stat } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { promisify } from "node:util";

import { CliError } from "./cli-arguments.mjs";

export const execFile = promisify(execFileCallback);

export async function pathExists(target) {
  try {
    await lstat(target);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function isExecutable(target) {
  try {
    await access(target, fsConstants.X_OK);
    const targetStat = await stat(target);
    return targetStat.isFile();
  } catch {
    return false;
  }
}

export async function commandPath(name) {
  const directories = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  for (const directory of directories) {
    const candidate = path.join(directory, name);
    if (await isExecutable(candidate)) {
      return realpath(candidate);
    }
  }
  return null;
}

export async function resolveBbCli() {
  if (process.env.BB_CLI) {
    const candidate = process.env.BB_CLI;
    if (!path.isAbsolute(candidate) || !(await isExecutable(candidate))) {
      throw new CliError(`BB_CLI is not an existing absolute executable: ${candidate}`);
    }
    return realpath(candidate);
  }
  const onPath = await commandPath("bb");
  if (onPath) {
    return onPath;
  }
  for (const candidate of [
    "/Applications/bb.app/Contents/Resources/app.asar.unpacked/node_modules/bb-app/host-daemon/dist/bb",
    "/Applications/BB.app/Contents/Resources/app.asar.unpacked/node_modules/bb-app/host-daemon/dist/bb",
    "/opt/homebrew/bin/bb",
    "/usr/local/bin/bb",
  ]) {
    if (await isExecutable(candidate)) {
      return realpath(candidate);
    }
  }
  throw new CliError("Could not resolve the BB CLI. Set BB_CLI to the absolute installed bb executable.");
}

export async function bb(cli, args) {
  const { stdout } = await execFile(cli, args, {
    env: { ...process.env, BB_CLI: cli },
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout;
}

export async function bbJson(cli, args) {
  return JSON.parse(await bb(cli, [...args, "--json"]));
}

export async function requirePrimaryCheckout(cwd) {
  const root = await realpath(cwd);
  let commonDir;
  try {
    const { stdout } = await execFile("git", [
      "-C",
      root,
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
    ]);
    commonDir = await realpath(stdout.trim());
  } catch {
    throw new CliError(`${root} is not inside a Git repository`);
  }
  const topLevel = (
    await execFile("git", ["-C", root, "rev-parse", "--show-toplevel"])
  ).stdout.trim();
  const primaryRoot = await realpath(topLevel);
  if (path.dirname(commonDir) !== primaryRoot) {
    throw new CliError(
      `Refusing to manage the shared runtime from a linked worktree:\n  worktree: ${primaryRoot}\n  primary:  ${path.dirname(commonDir)}\nRun this command from the primary checkout.`,
    );
  }
  return { primaryRoot, gitCommonDir: commonDir };
}

export function parseEnvFile(content) {
  const values = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) {
      continue;
    }
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) {
      continue;
    }
    let value = match[2];
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/, "");
    }
    values[match[1]] = value;
  }
  return values;
}

export async function resolveComposeProject(manifest, primaryRoot, options) {
  if (options.values["compose-project"]) {
    return options.values["compose-project"];
  }
  if (manifest.compose.envFile === null || manifest.compose.projectVariable === null) {
    return null;
  }
  const envPath = path.join(primaryRoot, manifest.compose.envFile);
  const values = {};
  for (const candidate of [envPath, `${envPath}.local`]) {
    if (await pathExists(candidate)) {
      Object.assign(values, parseEnvFile(await readFile(candidate, "utf8")));
    }
  }
  const value = values[manifest.compose.projectVariable];
  if (typeof value !== "string" || value === "") {
    throw new CliError(
      `${manifest.compose.projectVariable} is not set in ${manifest.compose.envFile}; pass --compose-project`,
    );
  }
  return value;
}

export async function resolveDockerSocket(dockerPath, options) {
  if (options.values["docker-socket"]) {
    return path.resolve(options.values["docker-socket"]);
  }
  const fromEnvironment = process.env.DOCKER_HOST;
  if (typeof fromEnvironment === "string" && fromEnvironment.startsWith("unix://")) {
    return fromEnvironment.slice("unix://".length);
  }
  try {
    const { stdout } = await execFile(dockerPath, [
      "context",
      "inspect",
      "--format",
      '{{(index .Endpoints "docker").Host}}',
    ]);
    const host = stdout.trim();
    if (host.startsWith("unix://")) {
      return host.slice("unix://".length);
    }
  } catch {
    // No Docker context host available: return null below.
  }
  return null;
}

export async function resolveProject(cli, primaryRoot, options) {
  const projects = await bbJson(cli, ["project", "list"]);
  const matches = [];
  for (const project of projects) {
    for (const source of project.sources ?? []) {
      if (source.type !== "local_path" || typeof source.path !== "string") {
        continue;
      }
      let sourcePath;
      try {
        sourcePath = await realpath(source.path);
      } catch {
        continue;
      }
      if (sourcePath === primaryRoot) {
        matches.push({ project, source });
      }
    }
  }
  const requested = options.values["project-id"];
  const selected = requested
    ? matches.filter(({ project }) => project.id === requested)
    : matches;
  if (selected.length === 0) {
    throw new CliError(
      requested
        ? `BB project ${requested} has no local source at ${primaryRoot}`
        : `No BB project has a local source at ${primaryRoot}. Add the repository as a BB project first.`,
    );
  }
  if (selected.length > 1) {
    throw new CliError(
      `More than one BB project maps to ${primaryRoot}; pass --project-id (${selected
        .map(({ project }) => project.id)
        .join(", ")})`,
    );
  }
  return selected[0];
}
