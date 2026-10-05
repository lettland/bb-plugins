import path from "node:path";
import { lstat, mkdir, readlink, readdir, realpath, rm, symlink } from "node:fs/promises";

import { expandDependencies } from "./manifest.mjs";
import {
  deny,
  assertNonEmptyString,
  assertManifestCurrent,
  pathExists,
} from "./runtime-common.mjs";
import { validateWorkspace } from "./workspace.mjs";
import { runInvocation } from "./invocation-runner.mjs";

export async function resolveWorkspace(policy, context) {
  const resolvedEnvironmentPath = await realpath(
    assertNonEmptyString(context.environmentPath, "environment path"),
  );
  const gitResult = await runInvocation({
    command: "/usr/bin/git",
    args: [
      "-C",
      resolvedEnvironmentPath,
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
    ],
  });
  const resolvedGitCommonDir = await realpath(gitResult.stdout.trim());
  return validateWorkspace({
    policy,
    context,
    resolvedEnvironmentPath,
    resolvedGitCommonDir,
  });
}

export async function ensureContainerSymlink(linkPath, target) {
  try {
    const current = await lstat(linkPath);
    if (!current.isSymbolicLink()) {
      deny(`dependency path is not a symbolic link: ${linkPath}`);
    }
    const currentTarget = await readlink(linkPath);
    if (currentTarget !== target) {
      deny(`dependency link has an unexpected target: ${linkPath}`);
    }
    return;
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }
  await mkdir(path.dirname(linkPath), { recursive: true });
  await symlink(target, linkPath, "dir");
}

async function ensureContainerDependencyDirectory(
  directoryPath,
  sharedTarget,
  sharedSource,
  localDirectories = [],
) {
  try {
    const current = await lstat(directoryPath);
    if (current.isSymbolicLink()) {
      const currentTarget = await readlink(directoryPath);
      if (currentTarget !== sharedTarget) {
        deny(`dependency link has an unexpected target: ${directoryPath}`);
      }
      await rm(directoryPath);
    } else if (!current.isDirectory()) {
      deny(`dependency path is not a directory: ${directoryPath}`);
    }
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }

  await mkdir(directoryPath, { recursive: true });
  const sharedEntries = new Set(
    (await readdir(sharedSource, { withFileTypes: true })).map((entry) => entry.name),
  );
  const localDirectoryNames = new Set(localDirectories);

  for (const entry of await readdir(directoryPath, { withFileTypes: true })) {
    if (localDirectoryNames.has(entry.name) || sharedEntries.has(entry.name)) {
      continue;
    }
    const stalePath = path.join(directoryPath, entry.name);
    if (!entry.isSymbolicLink()) {
      deny(`dependency mirror contains an unexpected entry: ${stalePath}`);
    }
    const staleTarget = await readlink(stalePath);
    if (staleTarget !== path.posix.join(sharedTarget, entry.name)) {
      deny(`dependency link has an unexpected target: ${stalePath}`);
    }
    await rm(stalePath);
  }

  for (const entryName of sharedEntries) {
    if (localDirectoryNames.has(entryName)) {
      continue;
    }
    await ensureContainerSymlink(
      path.join(directoryPath, entryName),
      path.posix.join(sharedTarget, entryName),
    );
  }

  for (const localDirectoryName of localDirectoryNames) {
    const localPath = path.join(directoryPath, localDirectoryName);
    try {
      const current = await lstat(localPath);
      if (current.isSymbolicLink()) {
        const expectedTarget = path.posix.join(sharedTarget, localDirectoryName);
        if ((await readlink(localPath)) !== expectedTarget) {
          deny(`dependency link has an unexpected target: ${localPath}`);
        }
        await rm(localPath);
      } else if (!current.isDirectory()) {
        deny(`local dependency cache is not a directory: ${localPath}`);
      }
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
    }
    await mkdir(localPath, { recursive: true, mode: 0o700 });
  }
}

export async function prepareWorktreeDependencies(policy, workspace) {
  if (workspace.kind !== "managed-worktree") {
    return;
  }
  const manifest = assertManifestCurrent(policy);
  const dependencies = await expandDependencies(manifest, policy.primaryRoot, {
    pathExists,
    readDirectory: (directory) => readdir(directory, { withFileTypes: true }),
  });
  for (const dependency of dependencies) {
    const worktreePath = path.join(workspace.hostRoot, dependency.relativePath);
    if (dependency.kind === "link") {
      await ensureContainerSymlink(worktreePath, dependency.containerTarget);
      continue;
    }
    await ensureContainerDependencyDirectory(
      worktreePath,
      dependency.containerTarget,
      path.join(policy.primaryRoot, dependency.relativePath),
      [...dependency.local],
    );
  }
}
