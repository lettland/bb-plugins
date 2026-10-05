import path from "node:path";

import { substitutePlaceholders } from "./manifest.mjs";
import {
  deny,
  assertNonEmptyString,
  normalizeAbsolute,
  requireManifest,
  assertManifestCurrent,
} from "./runtime-common.mjs";
import { dockerExec } from "./workspace.mjs";
import {
  isolationLauncherPath,
  runtimeAssetsPath,
  allScratchPaths,
  builtinScratchPaths,
  namedScratchPath,
  scratchEnvironment,
  assertManagedQualityWorkspace,
  isolatedDockerExec,
  containerPathFor,
} from "./isolation-scratch.mjs";
import { validateManagedWorktreeBranch } from "./git-invocation.mjs";

function placeholderVariables(policy, workspace, role, { cwd = null, target = null } = {}) {
  const manifest = requireManifest(policy);
  const builtin = builtinScratchPaths(workspace);
  const variables = {
    env: workspace.environmentId,
    envSlug: workspace.environmentId.replaceAll("_", "-"),
    tmp: builtin[0],
    primaryRoot: normalizeAbsolute(policy.primaryRoot),
    hostRoot: workspace.hostRoot,
    docker: policy.dockerPath,
    worktreeRoot: normalizeAbsolute(policy.worktreeRoot),
  };
  for (const name of Object.keys(manifest.scratch)) {
    variables[`scratch.${name}`] = namedScratchPath(workspace, name);
  }
  for (const otherRole of Object.keys(manifest.containers)) {
    variables[`launcher.${otherRole}`] = isolationLauncherPath(policy, otherRole);
    variables[`runtime.${otherRole}`] = runtimeAssetsPath(policy, otherRole);
    variables[`root.${otherRole}`] = containerPathFor(policy, workspace, otherRole, ".");
  }
  if (role !== null) {
    variables.root = containerPathFor(policy, workspace, role, ".");
    variables.runtime = runtimeAssetsPath(policy, role);
    variables.launcher = isolationLauncherPath(policy, role);
    if (cwd !== null) {
      variables.cwd = containerPathFor(policy, workspace, role, cwd);
    }
  }
  if (target !== null) {
    variables.target = target;
  }
  return variables;
}

function substituteAll(values, variables, label) {
  return values.map((value) => substitutePlaceholders(value, variables, label));
}

function substituteEnvironment(environment, variables, label) {
  return Object.fromEntries(
    Object.entries(environment).map(([name, value]) => [
      name,
      substitutePlaceholders(value, variables, `${label}.${name}`),
    ]),
  );
}

function compileContainerStep(policy, workspace, step, label, target = null) {
  const variables = placeholderVariables(policy, workspace, step.container, {
    cwd: step.cwd,
    target,
  });
  const argv = substituteAll(step.argv, variables, `${label}.argv`);
  const environment = substituteEnvironment(step.environment, variables, `${label}.env`);
  if (target !== null && !step.usesTarget) {
    argv.push(target);
  }
  return isolatedDockerExec(
    policy,
    workspace,
    step.container,
    variables.cwd,
    argv[0],
    argv.slice(1),
    { environment, rejectNonEmptyStdout: step.failOnStdout },
  );
}

const hostInterpreters = Object.freeze({
  bash: "/bin/bash",
  sh: "/bin/sh",
});

function compileHostStep(policy, workspace, step, label, target = null) {
  assertManagedQualityWorkspace(workspace);
  const variables = placeholderVariables(policy, workspace, null, { target });
  const interpreter = hostInterpreters[step.interpreter];
  if (!interpreter) {
    deny(`${label} uses unsupported host interpreter ${JSON.stringify(step.interpreter)}`);
  }
  const argv = substituteAll(step.argv, variables, `${label}.argv`);
  if (target !== null && !step.usesTarget) {
    argv.push(target);
  }
  return {
    command: interpreter,
    args: [path.join(normalizeAbsolute(policy.primaryRoot), step.script), ...argv],
    containers: [...step.containers],
    cwd: workspace.hostRoot,
    environment: substituteEnvironment(step.environment, variables, `${label}.env`),
    rejectNonEmptyStdout: false,
  };
}

function compileStep(policy, workspace, step, label, target = null) {
  return step.kind === "host"
    ? compileHostStep(policy, workspace, step, label, target)
    : compileContainerStep(policy, workspace, step, label, target);
}

function validateOperationTarget(operation, name, target) {
  if (target === undefined || target === null) {
    if (operation.target?.required) {
      deny(`${name} requires a target`);
    }
    return null;
  }
  if (typeof target !== "string" || target === "" || target.includes("\0") || target.length > 500) {
    deny(`${name} target is invalid`);
  }
  if (operation.target === null) {
    deny(`${name} does not accept a target`);
  }
  if (operation.target.variants) {
    if (!Object.hasOwn(operation.target.variants, target)) {
      deny(
        `${name} target must be one of ${Object.keys(operation.target.variants)
          .map((value) => JSON.stringify(value))
          .join(", ")}`,
      );
    }
    return target;
  }
  if (target.startsWith("-") || !operation.target.pattern.test(target)) {
    deny(`${name} target does not match ${operation.target.patternSource}`);
  }
  return target;
}

export function buildContainerPlan(policy, workspace, operation, input = {}) {
  assertManagedQualityWorkspace(workspace);
  const manifest = assertManifestCurrent(policy);
  if (typeof operation !== "string" || !Object.hasOwn(manifest.operations, operation)) {
    deny(`unsupported operation ${JSON.stringify(operation)}`);
  }
  const definition = manifest.operations[operation];
  if (definition.kind === "sequence") {
    if (input?.target !== undefined) {
      deny(`${operation} does not accept a target`);
    }
    return definition.steps.map((step, index) => {
      if (step.reference !== undefined) {
        const referenced = manifest.operations[step.reference];
        return compileStep(policy, workspace, referenced.step, `operations.${step.reference}`);
      }
      return compileStep(policy, workspace, step, `operations.${operation}.steps[${index}]`);
    });
  }
  const target = validateOperationTarget(definition, operation, input?.target);
  if (target !== null && definition.target.variants) {
    return [
      compileStep(
        policy,
        workspace,
        definition.target.variants[target],
        `operations.${operation}.target.variants.${target}`,
      ),
    ];
  }
  return [compileStep(policy, workspace, definition.step, `operations.${operation}`, target)];
}

export function isolationProbeRole(policy) {
  const manifest = requireManifest(policy);
  if (manifest.isolation === null) {
    deny("isolation builder is not declared");
  }
  return manifest.isolation.probe ?? manifest.isolation.builder;
}

export function buildIsolationSelfTestInvocation(
  policy,
  workspace,
  selectedProbe,
  primaryProbe,
  siblingProbe,
  siblingScratchProbe,
) {
  assertManagedQualityWorkspace(workspace);
  const branchName = validateManagedWorktreeBranch(workspace);
  for (const [value, label] of [
    [selectedProbe, "selected isolation probe"],
    [primaryProbe, "primary isolation probe"],
    [siblingProbe, "sibling isolation probe"],
    [siblingScratchProbe, "sibling scratch isolation probe"],
  ]) {
    assertNonEmptyString(value, label);
    if (!path.posix.isAbsolute(value)) {
      deny(`${label} must be an absolute container path`);
    }
  }
  const role = isolationProbeRole(policy);
  return dockerExec(
    policy,
    role,
    workspace.containerRoot,
    isolationLauncherPath(policy, role),
    [
      "--workspace",
      workspace.containerRoot,
      ...allScratchPaths(policy, workspace).flatMap((scratch) => ["--scratch", scratch]),
      "--self-test",
      "--allow-write",
      selectedProbe,
      "--deny-write",
      primaryProbe,
      "--deny-write",
      siblingProbe,
      "--deny-write",
      siblingScratchProbe,
      "--git-workspace",
      workspace.containerRoot,
      "--git-ref",
      `refs/heads/${branchName}`,
    ],
    { environment: scratchEnvironment(policy, workspace) },
  );
}

export function buildPrecommitGenerationPlan(policy, workspace, { available = null } = {}) {
  assertManagedQualityWorkspace(workspace);
  const manifest = assertManifestCurrent(policy);
  const plan = [];
  manifest.git.generators.forEach((generator, index) => {
    if (generator.requires !== null && available !== null && !available.has(generator.requires)) {
      return;
    }
    plan.push({
      generator,
      invocation: compileContainerStep(
        policy,
        workspace,
        generator.step,
        `git.prepareCommit.generators[${index}]`,
      ),
    });
  });
  return plan;
}
