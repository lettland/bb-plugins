import path from "node:path";

import { PRIMARY_ROOT_PLACEHOLDER } from "./manifest.mjs";
import {
  deny,
  normalizeAbsolute,
  samePath,
  assertEnvironmentId,
  requireManifest,
} from "./runtime-common.mjs";

function directWorktreePath(policy, environmentId) {
  assertEnvironmentId(environmentId, "environment id");
  return path.join(policy.worktreeRoot, environmentId, policy.worktreeDirectoryName);
}

function worktreeContainerRoot(policy, environmentId) {
  const manifest = requireManifest(policy);
  return path.posix.join(
    manifest.worktrees.containerRoot,
    environmentId,
    policy.worktreeDirectoryName,
  );
}

export function validateWorkspace({
  policy,
  context,
  resolvedEnvironmentPath,
  resolvedGitCommonDir,
}) {
  if (context.projectId !== policy.projectId) {
    deny("project mismatch");
  }
  if (context.hostId !== policy.trustedHostId) {
    deny("host mismatch");
  }
  if (!context.environmentPath) {
    deny("environment path is missing");
  }
  if (!samePath(resolvedGitCommonDir, policy.gitCommonDir)) {
    deny("foreign repository");
  }

  const primaryRoot = normalizeAbsolute(policy.primaryRoot);
  if (samePath(resolvedEnvironmentPath, primaryRoot)) {
    if (context.workspaceProvisionType !== "unmanaged") {
      deny("primary checkout has an invalid provision type");
    }
    return {
      branchName: context.branchName,
      containerRoot: null,
      environmentId: context.environmentId,
      hostRoot: primaryRoot,
      kind: "primary",
    };
  }

  if (context.workspaceProvisionType !== "managed-worktree") {
    deny("non-primary environment is not a managed worktree");
  }
  const expected = directWorktreePath(policy, context.environmentId);
  if (!samePath(context.environmentPath, expected)) {
    deny("environment path is outside its assigned worktree");
  }
  if (!samePath(resolvedEnvironmentPath, expected)) {
    deny("resolved environment path escaped or is nested");
  }

  return {
    branchName: context.branchName,
    containerRoot: worktreeContainerRoot(policy, context.environmentId),
    environmentId: context.environmentId,
    hostRoot: expected,
    kind: "managed-worktree",
  };
}

function containerName(policy, role) {
  const name = policy.containers?.[role];
  if (typeof name !== "string" || name === "") {
    deny(`container role ${JSON.stringify(role)} is not installed for this project`);
  }
  return name;
}

export function dockerExec(policy, container, workdir, executable, args = [], options = {}) {
  const environment = options.environment ?? {};
  const environmentArgs = Object.entries(environment).flatMap(([name, value]) => [
    "--env",
    `${name}=${value}`,
  ]);
  return {
    command: policy.dockerPath,
    args: [
      "exec",
      ...environmentArgs,
      "--workdir",
      workdir,
      containerName(policy, container),
      executable,
      ...args,
    ],
    rejectNonEmptyStdout: options.rejectNonEmptyStdout === true,
  };
}

function relativeInside(root, target, label) {
  const relative = path.relative(normalizeAbsolute(root), normalizeAbsolute(target));
  if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`)) {
    deny(`${label} is outside its expected root`);
  }
  return relative;
}

function toPosixRelative(relative) {
  return relative.split(path.sep).join("/");
}

function containerMountPath(policy, mount) {
  return mount.container === PRIMARY_ROOT_PLACEHOLDER
    ? normalizeAbsolute(policy.primaryRoot)
    : mount.container;
}

export function hostPathInContainer(policy, hostPath, role) {
  const manifest = requireManifest(policy);
  const container = manifest.containers[role];
  if (!container) {
    deny(`container role ${JSON.stringify(role)} is not declared`);
  }
  const absolute = normalizeAbsolute(hostPath);
  const primaryRoot = normalizeAbsolute(policy.primaryRoot);
  if (absolute === primaryRoot || absolute.startsWith(`${primaryRoot}${path.sep}`)) {
    const relative = toPosixRelative(path.relative(primaryRoot, absolute));
    let best = null;
    for (const mount of container.mounts) {
      const hostPrefix = mount.host === "." ? "" : `${mount.host}/`;
      const matches =
        mount.host === "." || relative === mount.host || relative.startsWith(hostPrefix);
      if (!matches) {
        continue;
      }
      if (best === null || mount.host.length > best.host.length) {
        best = mount;
      }
    }
    if (best === null) {
      deny(`primary checkout path is not mounted in container ${role}`);
    }
    const remainder =
      best.host === "." ? relative : relative === best.host ? "" : relative.slice(best.host.length + 1);
    return path.posix.join(containerMountPath(policy, best), remainder);
  }
  const relative = relativeInside(policy.worktreeRoot, absolute, "worktree path");
  return path.posix.join(manifest.worktrees.containerRoot, toPosixRelative(relative));
}
