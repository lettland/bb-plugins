import { assertEnvironmentId } from "./runtime-common.mjs";
import { withProjectLock } from "./project-lock.mjs";

function defaultLockWaitReporter(message) {
  process.stderr.write(`${message}\n`);
}

export function captureLockWaitMessages(options = {}) {
  const messages = [];
  return {
    messages,
    options: {
      ...options,
      onLockWait: (message) => {
        messages.push(message);
        options.onLockWait?.(message);
      },
    },
  };
}

export function prependLockWaitMessages(results, messages) {
  if (messages.length === 0) {
    return results;
  }
  const list = Array.isArray(results) ? results : [results];
  return [{ stdout: "", stderr: `${messages.join("\n")}\n` }, ...list];
}

export function operationLockOptions(options, workspace, operation, mode, label) {
  return {
    label,
    lockAdapter: options.lockAdapter,
    mode,
    onWait: options.onLockWait ?? defaultLockWaitReporter,
    owner: {
      environmentId: workspace.environmentId ?? workspace.kind ?? "primary",
      operation,
    },
    signal: options.signal,
  };
}

export function workspaceLockKey(policy, workspace) {
  if (workspace.kind === "primary") {
    return `${policy.projectId}:environment:primary`;
  }
  assertEnvironmentId(workspace.environmentId, "workspace environment id");
  return `${policy.projectId}:environment:${workspace.environmentId}`;
}

export async function withQualityOperationLocks(
  policy,
  workspace,
  operationName,
  operation,
  options,
  projectLockMode = "shared",
) {
  return withProjectLock(
    workspaceLockKey(policy, workspace),
    () =>
      withProjectLock(
        policy.projectId,
        operation,
        operationLockOptions(
          options,
          workspace,
          operationName,
          projectLockMode,
          "shared dependency lock",
        ),
      ),
    operationLockOptions(
      options,
      workspace,
      operationName,
      "exclusive",
      "worktree operation lock",
    ),
  );
}
