import fs from "node:fs";
import path from "node:path";

import {
  ISOLATION_SELF_TEST_OPERATION,
  deny,
  requireManifest,
  assertManifestCurrent,
} from "./runtime-common.mjs";
import { assertManagedQualityWorkspace } from "./isolation-scratch.mjs";
import { buildContainerPlan, isolationProbeRole } from "./container-plan.mjs";
import { buildSearchInvocation } from "./git-invocation.mjs";
import { runInvocation } from "./invocation-runner.mjs";
import { ensureIsolationLauncher } from "./isolation-launcher.mjs";
import {
  resetContainerScratch,
  planContainers,
  executeIsolationSelfTest,
} from "./container-scratch.mjs";
import { prepareWorktreeDependencies } from "./worktree-dependencies.mjs";
import {
  captureLockWaitMessages,
  prependLockWaitMessages,
  withQualityOperationLocks,
} from "./operation-locks.mjs";

export async function executeContainerOperation(policy, workspace, operation, options = {}) {
  assertManagedQualityWorkspace(workspace);
  assertManifestCurrent(policy);
  const plan =
    operation === ISOLATION_SELF_TEST_OPERATION
      ? null
      : buildContainerPlan(policy, workspace, operation, {
          target: options.target,
        });
  const lockWaits = captureLockWaitMessages(options);
  const results = await withQualityOperationLocks(
    policy,
    workspace,
    operation,
    async () => {
      const run = options.run ?? runInvocation;
      await ensureIsolationLauncher(policy, {
        run,
        signal: options.signal,
      });
      if (operation === ISOLATION_SELF_TEST_OPERATION) {
        const cleanupScratch = await resetContainerScratch(
          policy,
          workspace,
          [isolationProbeRole(policy)],
          run,
          options.signal,
        );
        try {
          return await executeIsolationSelfTest(policy, workspace, run, options.signal);
        } finally {
          await cleanupScratch();
        }
      }
      await prepareWorktreeDependencies(policy, workspace);
      const cleanupScratch = await resetContainerScratch(
        policy,
        workspace,
        planContainers(policy, plan),
        run,
        options.signal,
      );
      try {
        const results = [];
        for (const invocation of plan) {
          const result = await run(invocation, { signal: options.signal });
          if (invocation.rejectNonEmptyStdout && result.stdout.trim() !== "") {
            throw new Error(`format check failed; files need formatting:\n${result.stdout}`);
          }
          results.push(result);
        }
        return results;
      } finally {
        await cleanupScratch();
      }
    },
    lockWaits.options,
  );
  return prependLockWaitMessages(results, lockWaits.messages);
}

async function assertSearchPathInsideWorkspace(hostRoot, searchPath) {
  let target;
  try {
    target = await fs.promises.realpath(path.resolve(hostRoot, searchPath));
  } catch (error) {
    if (error.code === "ENOENT") {
      return;
    }
    throw error;
  }
  const root = await fs.promises.realpath(hostRoot);
  if (target !== root && !target.startsWith(root + path.sep)) {
    deny("path escapes the workspace");
  }
}

export async function executeSearch(policy, workspace, input, options = {}) {
  const manifest = requireManifest(policy);
  const invocation = buildSearchInvocation(
    workspace.hostRoot,
    input,
    manifest.search.defaultPath,
  );
  await assertSearchPathInsideWorkspace(workspace.hostRoot, invocation.args.at(-1));
  return runInvocation(invocation, options);
}

export function formatResults(results) {
  const list = Array.isArray(results) ? results : [results];
  return list
    .map((result) => [result.stdout, result.stderr].filter(Boolean).join(""))
    .join("\n")
    .trim() || "Completed successfully with no output.";
}
