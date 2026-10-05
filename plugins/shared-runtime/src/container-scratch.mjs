import path from "node:path";
import { link, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";

import { assertManifestCurrent, pathExists } from "./runtime-common.mjs";
import { dockerExec, hostPathInContainer } from "./workspace.mjs";
import { builtinScratchPaths, allScratchPaths } from "./isolation-scratch.mjs";
import {
  isolationProbeRole,
  buildIsolationSelfTestInvocation,
  buildPrecommitGenerationPlan,
} from "./container-plan.mjs";
import { buildGitInvocation } from "./git-invocation.mjs";
import { runtimeDirectoryPath } from "./isolation-launcher.mjs";

export async function resetContainerScratch(policy, workspace, containers, run, signal) {
  const scratchPaths = allScratchPaths(policy, workspace);
  const builtin = builtinScratchPaths(workspace);
  for (const container of containers) {
    await run(
      dockerExec(policy, container, "/", "rm", ["-rf", "--", ...builtin]),
      { signal },
    );
    await run(
      dockerExec(policy, container, "/", "mkdir", ["-p", "-m", "700", "--", ...scratchPaths]),
      { signal },
    );
  }
  return async () => {
    for (const container of containers) {
      await run(
        dockerExec(policy, container, "/", "rm", ["-rf", "--", ...builtin]),
        { signal },
      );
    }
  };
}

export function planContainers(policy, plan) {
  return Object.keys(policy.containers).filter((container) =>
    plan.some(
      (invocation) =>
        invocation.args.includes(policy.containers[container]) ||
        invocation.containers?.includes(container),
    ),
  );
}

function executableIsMissing(error) {
  const result = error?.result;
  if (result?.code !== 126 && result?.code !== 127) {
    return false;
  }
  return /(?:executable file not found|not found|no such file)/i.test(
    `${result.stderr ?? ""}\n${result.stdout ?? ""}`,
  );
}

async function ensureHardLink(workspace, relativeSource, relativeTarget) {
  const source = path.join(workspace.hostRoot, relativeSource);
  const target = path.join(workspace.hostRoot, relativeTarget);
  let sourceStat;
  try {
    sourceStat = await stat(source);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return false;
    }
    throw error;
  }
  try {
    const targetStat = await stat(target);
    if (sourceStat.dev === targetStat.dev && sourceStat.ino === targetStat.ino) {
      return false;
    }
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }
  await mkdir(path.dirname(target), { recursive: true });
  const temporaryTarget = `${target}.bb-link-${process.pid}`;
  await rm(temporaryTarget, { force: true });
  try {
    await link(source, temporaryTarget);
    await rename(temporaryTarget, target);
  } finally {
    await rm(temporaryTarget, { force: true });
  }
  return true;
}

export async function prepareCommitOutputs(policy, workspace, run, signal) {
  const manifest = assertManifestCurrent(policy);
  if (manifest.git.generators.length === 0 && manifest.git.hardlinks.length === 0) {
    return;
  }
  const available = new Set();
  for (const generator of manifest.git.generators) {
    if (generator.requires !== null && (await pathExists(path.join(workspace.hostRoot, generator.requires)))) {
      available.add(generator.requires);
    }
  }
  const plan = buildPrecommitGenerationPlan(policy, workspace, { available });
  const paths = [];
  for (const { generator, invocation } of plan) {
    try {
      await run(invocation, { signal });
    } catch (error) {
      if (generator.tolerateMissingExecutable && executableIsMissing(error)) {
        continue;
      }
      throw error;
    }
    for (const stagePath of generator.stages) {
      if (await pathExists(path.join(workspace.hostRoot, stagePath))) {
        paths.push(stagePath);
      }
    }
  }
  for (const hardlink of manifest.git.hardlinks) {
    if (await ensureHardLink(workspace, hardlink.source, hardlink.target)) {
      paths.push(hardlink.target);
    }
  }
  if (paths.length > 0) {
    await run(
      buildGitInvocation(workspace.hostRoot, {
        operation: "add",
        paths: [...new Set(paths)],
      }),
      { signal },
    );
  }
}

export async function executeIsolationSelfTest(policy, workspace, run, signal) {
  const role = isolationProbeRole(policy);
  const runtimeDirectory = runtimeDirectoryPath(policy);
  await mkdir(runtimeDirectory, { recursive: true, mode: 0o700 });
  const primaryDirectory = await mkdtemp(path.join(runtimeDirectory, "isolation-primary-"));
  const siblingDirectory = await mkdtemp(
    path.join(policy.worktreeRoot, ".bb-runtime-isolation-sibling-"),
  );
  const selectedDirectory = await mkdtemp(
    path.join(workspace.hostRoot, ".bb-runtime-isolation-selected-"),
  );
  const primaryProbe = path.join(primaryDirectory, "unchanged.txt");
  const siblingProbe = path.join(siblingDirectory, "unchanged.txt");
  const selectedProbe = path.join(selectedDirectory, "selected.txt");
  const siblingScratchDirectory = path.posix.join("/tmp", "bb-runtime-env_sibling");
  const siblingScratchProbe = path.posix.join(siblingScratchDirectory, "unchanged.txt");
  const expected = "unchanged\n";
  try {
    await run(dockerExec(policy, role, "/", "mkdir", ["-p", "--", siblingScratchDirectory]), {
      signal,
    });
    await run(dockerExec(policy, role, "/", "touch", [siblingScratchProbe]), { signal });
    await Promise.all([
      writeFile(primaryProbe, expected, { mode: 0o600 }),
      writeFile(siblingProbe, expected, { mode: 0o600 }),
      writeFile(selectedProbe, expected, { mode: 0o600 }),
    ]);
    const invocation = buildIsolationSelfTestInvocation(
      policy,
      workspace,
      hostPathInContainer(policy, selectedProbe, role),
      hostPathInContainer(policy, primaryProbe, role),
      hostPathInContainer(policy, siblingProbe, role),
      siblingScratchProbe,
    );
    const result = await run(invocation, { signal });
    const [primaryAfter, siblingAfter, selectedAfter] = await Promise.all([
      readFile(primaryProbe, "utf8"),
      readFile(siblingProbe, "utf8"),
      readFile(selectedProbe, "utf8"),
    ]);
    if (
      primaryAfter !== expected ||
      siblingAfter !== expected ||
      selectedAfter !== `${expected}allowed\n`
    ) {
      throw new Error("isolation probe modified a protected checkout");
    }
    return [result];
  } finally {
    await run(dockerExec(policy, role, "/", "rm", ["-rf", "--", siblingScratchDirectory]), {
      signal,
    });
    await rm(primaryDirectory, { recursive: true, force: true });
    await rm(siblingDirectory, { recursive: true, force: true });
    await rm(selectedDirectory, { recursive: true, force: true });
  }
}
