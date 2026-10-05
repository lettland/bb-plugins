import { ISOLATION_SELF_TEST_OPERATION, pluginRoot } from "./runtime-common.mjs";
import { hostPathInContainer, validateWorkspace } from "./workspace.mjs";
import { buildContainerPlan, buildIsolationSelfTestInvocation, buildPrecommitGenerationPlan } from "./container-plan.mjs";
import {
  buildFastForwardPrimaryPlan,
  buildGitInvocation,
  buildRebasePrimaryInvocation,
  buildRebasePrimaryPreflightPlan,
  buildRebaseRecoveryInvocation,
  buildSearchInvocation,
} from "./git-invocation.mjs";
import { readProcessIdentity } from "./process-identity.mjs";
import { memoryLocks } from "./lock-state.mjs";
import {
  inspectOwnerClaim,
  installOwnerClaim,
  recoverOwnerClaim,
  scavengeInitializationDebris,
} from "./lock-claims.mjs";
import { withProjectLock } from "./project-lock.mjs";
import { invocationExitIsAccepted, runInvocation } from "./invocation-runner.mjs";
import { ensureIsolationLauncher, ensureRuntimeAssets, launcherBuildInvocation } from "./isolation-launcher.mjs";
import {
  ensureContainerSymlink,
  prepareWorktreeDependencies,
  resolveWorkspace,
} from "./worktree-dependencies.mjs";
import {
  captureLockWaitMessages,
  prependLockWaitMessages,
  withQualityOperationLocks,
} from "./operation-locks.mjs";
import { executeContainerOperation, executeSearch, formatResults } from "./execute-container.mjs";
import { executeGit } from "./execute-git.mjs";
import { RUNTIME_ROOT_NAME, defaultRuntimeRoot } from "./registry.mjs";

export {
  ISOLATION_SELF_TEST_OPERATION,
  RUNTIME_ROOT_NAME,
  buildContainerPlan,
  buildFastForwardPrimaryPlan,
  buildGitInvocation,
  buildIsolationSelfTestInvocation,
  buildPrecommitGenerationPlan,
  buildRebasePrimaryInvocation,
  buildRebasePrimaryPreflightPlan,
  buildRebaseRecoveryInvocation,
  buildSearchInvocation,
  captureLockWaitMessages,
  defaultRuntimeRoot,
  ensureContainerSymlink,
  ensureIsolationLauncher,
  ensureRuntimeAssets,
  executeContainerOperation,
  executeGit,
  executeSearch,
  formatResults,
  hostPathInContainer,
  launcherBuildInvocation,
  pluginRoot,
  prependLockWaitMessages,
  prepareWorktreeDependencies,
  resolveWorkspace,
  runInvocation,
  validateWorkspace,
  withProjectLock,
};

export const _testing = Object.freeze({
  inspectOwnerClaim,
  installOwnerClaim,
  invocationExitIsAccepted,
  memoryLocks,
  readProcessIdentity,
  recoverOwnerClaim,
  scavengeInitializationDebris,
  withQualityOperationLocks,
});
