import { deny, requireManifest } from "./runtime-common.mjs";
import { assertManagedQualityWorkspace } from "./isolation-scratch.mjs";
import {
  buildGitInvocation,
  buildFastForwardPrimaryPlan,
  buildRebasePrimaryInvocation,
  buildRebasePrimaryPreflightPlan,
  buildRebaseRecoveryInvocation,
} from "./git-invocation.mjs";
import { withProjectLock } from "./project-lock.mjs";
import { runInvocation } from "./invocation-runner.mjs";
import { ensureIsolationLauncher } from "./isolation-launcher.mjs";
import { resetContainerScratch, prepareCommitOutputs } from "./container-scratch.mjs";
import {
  captureLockWaitMessages,
  prependLockWaitMessages,
  operationLockOptions,
  withQualityOperationLocks,
  workspaceLockKey,
} from "./operation-locks.mjs";

function commitPreparationContainers(policy) {
  const manifest = requireManifest(policy);
  return [...new Set(manifest.git.generators.map((generator) => generator.step.container))];
}

async function runFastForwardPrimary(policy, workspace, run, signal) {
  const [branchInvocation, mergeInvocation] = buildFastForwardPrimaryPlan(policy, workspace);
  const branchResult = await run(branchInvocation, { signal });
  const primaryBranch = branchResult.stdout.trim();
  if (primaryBranch !== "main" && primaryBranch !== "master") {
    deny(`primary checkout is on non-mainline branch ${JSON.stringify(primaryBranch)}`);
  }
  const mergeResult = await run(mergeInvocation, { signal });
  return [branchResult, mergeResult];
}

async function runRebasePrimary(policy, workspace, run, signal) {
  const { branchName, invocations } = buildRebasePrimaryPreflightPlan(policy, workspace);
  const [primaryBranchInvocation, worktreeBranchInvocation, statusInvocation] = invocations;
  const primaryBranchResult = await run(primaryBranchInvocation, { signal });
  const primaryBranch = primaryBranchResult.stdout.trim();
  const worktreeBranchResult = await run(worktreeBranchInvocation, { signal });
  if (worktreeBranchResult.stdout.trim() !== branchName) {
    deny("managed worktree branch does not match its authorized BB branch");
  }
  const statusResult = await run(statusInvocation, { signal });
  if (statusResult.stdout.trim() !== "") {
    deny("primary rebase requires a clean managed worktree");
  }
  const rebaseResult = await run(
    buildRebasePrimaryInvocation(policy, workspace, primaryBranch),
    { signal },
  );
  return [primaryBranchResult, worktreeBranchResult, statusResult, rebaseResult];
}

async function prepareCommit(policy, workspace, run, signal) {
  assertManagedQualityWorkspace(workspace);
  const containers = commitPreparationContainers(policy);
  if (containers.length > 0) {
    await ensureIsolationLauncher(policy, { run, signal });
  }
  const cleanupScratch =
    containers.length > 0
      ? await resetContainerScratch(policy, workspace, containers, run, signal)
      : async () => {
          // No container scratch was reset, so there is nothing to clean up.
        };
  try {
    await prepareCommitOutputs(policy, workspace, run, signal);
  } finally {
    await cleanupScratch();
  }
}

async function runGitOperation(policy, workspace, input, options) {
  const run = options.run ?? runInvocation;
  const { signal } = options;
  if (input?.operation === "fast_forward_primary") {
    return runFastForwardPrimary(policy, workspace, run, signal);
  }
  if (input?.operation === "rebase_primary") {
    return runRebasePrimary(policy, workspace, run, signal);
  }
  if (input?.operation === "rebase_continue" || input?.operation === "rebase_abort") {
    return run(buildRebaseRecoveryInvocation(workspace, input.operation), { signal });
  }
  if (input?.operation === "commit") {
    await prepareCommit(policy, workspace, run, signal);
  }
  return run(buildGitInvocation(workspace.hostRoot, input), { signal });
}

function projectLockModeFor(operationName) {
  if (operationName === "rebase_primary" || operationName === "fast_forward_primary") {
    return "exclusive";
  }
  return operationName === "commit" ? "shared" : null;
}

export async function executeGit(policy, workspace, input, options = {}) {
  const operationName = input?.operation ?? "git";
  const lockWaits = captureLockWaitMessages(options);
  const execute = () => runGitOperation(policy, workspace, input, options);
  const projectLockMode = projectLockModeFor(operationName);
  const result =
    projectLockMode === null
      ? await withProjectLock(
          workspaceLockKey(policy, workspace),
          execute,
          operationLockOptions(
            lockWaits.options,
            workspace,
            operationName,
            "exclusive",
            "worktree operation lock",
          ),
        )
      : await withQualityOperationLocks(
          policy,
          workspace,
          operationName,
          execute,
          lockWaits.options,
          projectLockMode,
        );
  return prependLockWaitMessages(result, lockWaits.messages);
}
