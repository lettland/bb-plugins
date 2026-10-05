import path from "node:path";

import {
  isolationRuntimeDirectory,
  isolationLauncherName,
  runtimeAssetsDirectoryName,
  deny,
  assertEnvironmentId,
  requireManifest,
} from "./runtime-common.mjs";
import { dockerExec, hostPathInContainer } from "./workspace.mjs";

export function isolationLauncherPath(policy, role) {
  return hostPathInContainer(
    policy,
    path.join(policy.primaryRoot, isolationRuntimeDirectory, isolationLauncherName),
    role,
  );
}

export function runtimeAssetsPath(policy, role) {
  return hostPathInContainer(
    policy,
    path.join(policy.primaryRoot, isolationRuntimeDirectory, runtimeAssetsDirectoryName),
    role,
  );
}

export function builtinScratchPaths(workspace) {
  assertEnvironmentId(workspace.environmentId, "workspace environment id");
  const name = `bb-runtime-${workspace.environmentId}`;
  return [
    path.posix.join("/tmp", name),
    path.posix.join("/var/tmp", name),
    path.posix.join("/dev/shm", name),
  ];
}

export function namedScratchPath(workspace, scratchName) {
  assertEnvironmentId(workspace.environmentId, "workspace environment id");
  return path.posix.join("/var/tmp", `bb-runtime-${scratchName}-${workspace.environmentId}`);
}

function namedScratchPaths(policy, workspace) {
  const manifest = requireManifest(policy);
  return Object.keys(manifest.scratch).map((name) => namedScratchPath(workspace, name));
}

export function allScratchPaths(policy, workspace) {
  return [...namedScratchPaths(policy, workspace), ...builtinScratchPaths(workspace)];
}

export function scratchEnvironment(policy, workspace) {
  const manifest = requireManifest(policy);
  const builtin = builtinScratchPaths(workspace);
  const environment = {
    TMP: builtin[0],
    TEMP: builtin[0],
    TMPDIR: builtin[0],
  };
  for (const [name, entry] of Object.entries(manifest.scratch)) {
    for (const variable of entry.environment) {
      environment[variable] = namedScratchPath(workspace, name);
    }
  }
  return environment;
}

export function assertManagedQualityWorkspace(workspace) {
  if (workspace.kind !== "managed-worktree" || workspace.containerRoot === null) {
    deny("quality operations require an isolated managed worktree");
  }
}

export function isolatedDockerExec(
  policy,
  workspace,
  container,
  workdir,
  executable,
  args = [],
  options = {},
) {
  assertManagedQualityWorkspace(workspace);
  return dockerExec(
    policy,
    container,
    workdir,
    isolationLauncherPath(policy, container),
    [
      "--workspace",
      workspace.containerRoot,
      ...allScratchPaths(policy, workspace).flatMap((scratch) => ["--scratch", scratch]),
      "--",
      executable,
      ...args,
    ],
    {
      ...options,
      environment: {
        ...scratchEnvironment(policy, workspace),
        ...options.environment,
      },
    },
  );
}

export function containerPathFor(policy, workspace, role, relative) {
  if (workspace.containerRoot !== null) {
    return relative === "." ? workspace.containerRoot : path.posix.join(workspace.containerRoot, relative);
  }
  return hostPathInContainer(
    policy,
    relative === "." ? policy.primaryRoot : path.join(policy.primaryRoot, relative),
    role,
  );
}
