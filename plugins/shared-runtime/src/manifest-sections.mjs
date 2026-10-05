import path from "node:path";

import {
  DEFAULT_WORKTREE_CONTAINER_ROOT,
  PRIMARY_ROOT_PLACEHOLDER,
  ROLE_PATTERN,
  SERVICE_PATTERN,
  SHELL_INTERPRETERS,
  SCRIPT_INTERPRETERS,
  LIFECYCLE_OPERATIONS,
  deny,
  isPlainObject,
  assertString,
  assertOptionalBoolean,
  validateRepositoryRelativePath,
  assertAbsoluteContainerPath,
  assertArgv,
} from "./manifest-primitives.mjs";
import { validateContainerStep } from "./manifest-operations.mjs";

export function validateDependency(value, index) {
  const label = `dependencies[${index}]`;
  if (!isPlainObject(value)) {
    deny(`${label} must be an object`);
  }
  const dependencyPath = validateRepositoryRelativePath(value.path, `${label}.path`);
  const wildcardCount = dependencyPath.split("/").filter((segment) => segment === "*").length;
  if (dependencyPath.split("/").some((segment) => segment.includes("*") && segment !== "*")) {
    deny(`${label}.path wildcards must be whole path segments`);
  }
  if (value.link !== undefined && value.mirror !== undefined) {
    deny(`${label} may not be both a link and a mirror`);
  }
  if (value.link !== undefined) {
    const link = assertAbsoluteContainerPath(value.link, `${label}.link`);
    if (wildcardCount !== link.split("/").filter((segment) => segment === "*").length) {
      deny(`${label}.link must repeat every wildcard segment of path`);
    }
    if (value.local !== undefined) {
      deny(`${label}.local is only valid for mirrors`);
    }
    return Object.freeze({ kind: "link", path: dependencyPath, target: link, local: Object.freeze([]) });
  }
  if (value.mirror === undefined) {
    deny(`${label} needs a link or mirror target`);
  }
  const mirror = assertAbsoluteContainerPath(value.mirror, `${label}.mirror`);
  if (wildcardCount !== mirror.split("/").filter((segment) => segment === "*").length) {
    deny(`${label}.mirror must repeat every wildcard segment of path`);
  }
  const local = value.local === undefined ? [] : value.local;
  if (!Array.isArray(local)) {
    deny(`${label}.local must be an array`);
  }
  for (const entry of local) {
    if (typeof entry !== "string" || entry === "" || entry.includes("/") || entry === "." || entry === "..") {
      deny(`${label}.local entries must be single directory names`);
    }
  }
  return Object.freeze({ kind: "mirror", path: dependencyPath, target: mirror, local: Object.freeze([...local]) });
}

export function validateContainers(value) {
  if (!isPlainObject(value) || Object.keys(value).length === 0) {
    deny("containers must declare at least one container");
  }
  const containers = {};
  for (const [role, entry] of Object.entries(value)) {
    if (!ROLE_PATTERN.test(role)) {
      deny(`containers role ${JSON.stringify(role)} is invalid`);
    }
    if (!isPlainObject(entry)) {
      deny(`containers.${role} must be an object`);
    }
    const service = assertString(entry.service, `containers.${role}.service`);
    if (!SERVICE_PATTERN.test(service)) {
      deny(`containers.${role}.service is invalid`);
    }
    if (!Array.isArray(entry.mounts) || entry.mounts.length === 0) {
      deny(`containers.${role}.mounts must list at least one mount`);
    }
    const mounts = entry.mounts.map((mount, index) => {
      const label = `containers.${role}.mounts[${index}]`;
      if (!isPlainObject(mount)) {
        deny(`${label} must be an object`);
      }
      const host = validateRepositoryRelativePath(mount.host, `${label}.host`, { allowRoot: true });
      const container =
        mount.container === PRIMARY_ROOT_PLACEHOLDER
          ? PRIMARY_ROOT_PLACEHOLDER
          : assertAbsoluteContainerPath(mount.container, `${label}.container`);
      return Object.freeze({ host, container });
    });
    const root =
      entry.root === undefined
        ? "."
        : validateRepositoryRelativePath(entry.root, `containers.${role}.root`, { allowRoot: true });
    containers[role] = Object.freeze({
      service,
      mounts: Object.freeze(mounts),
      root,
      containerName:
        entry.containerName === undefined
          ? null
          : assertString(entry.containerName, `containers.${role}.containerName`),
    });
  }
  return Object.freeze(containers);
}

export function validateScratch(value) {
  if (value === undefined) {
    return Object.freeze({});
  }
  if (!isPlainObject(value)) {
    deny("scratch must be an object");
  }
  const scratch = {};
  for (const [name, entry] of Object.entries(value)) {
    if (!/^[a-z][a-z0-9-]*$/.test(name)) {
      deny(`scratch name ${JSON.stringify(name)} is invalid`);
    }
    const environment = entry?.env === undefined ? [] : entry.env;
    if (!isPlainObject(entry ?? {}) || !Array.isArray(environment)) {
      deny(`scratch.${name} must be an object with an optional env array`);
    }
    for (const variable of environment) {
      if (typeof variable !== "string" || !/^[A-Z_][A-Z0-9_]*$/.test(variable)) {
        deny(`scratch.${name}.env entries must be environment variable names`);
      }
    }
    scratch[name] = Object.freeze({ environment: Object.freeze([...environment]) });
  }
  return Object.freeze(scratch);
}

export function validateLifecycle(value) {
  if (value === undefined) {
    return Object.freeze({});
  }
  if (!isPlainObject(value)) {
    deny("lifecycle must be an object");
  }
  const lifecycle = {};
  for (const [operation, argv] of Object.entries(value)) {
    if (!LIFECYCLE_OPERATIONS.includes(operation)) {
      deny(`lifecycle.${operation} is not a lifecycle operation`);
    }
    const validated = assertArgv(argv, `lifecycle.${operation}`);
    const base = path.posix.basename(validated[0]);
    if (!SHELL_INTERPRETERS.has(base) && !SCRIPT_INTERPRETERS.has(base)) {
      deny(`lifecycle.${operation} must start with a known interpreter`);
    }
    if (validated.length < 2) {
      deny(`lifecycle.${operation} needs a primary-checkout script`);
    }
    validateRepositoryRelativePath(validated[1], `lifecycle.${operation}[1]`);
    for (const argument of validated.slice(2)) {
      if (argument.includes("${")) {
        deny(`lifecycle.${operation} arguments may not use placeholders`);
      }
    }
    lifecycle[operation] = Object.freeze(validated);
  }
  return Object.freeze(lifecycle);
}

export function validateGit(manifest, value) {
  const result = { generators: [], hardlinks: [] };
  if (value === undefined) {
    return Object.freeze({ generators: Object.freeze([]), hardlinks: Object.freeze([]) });
  }
  if (!isPlainObject(value)) {
    deny("git must be an object");
  }
  const prepare = value.prepareCommit;
  if (prepare !== undefined) {
    if (!isPlainObject(prepare)) {
      deny("git.prepareCommit must be an object");
    }
    const generators = prepare.generators === undefined ? [] : prepare.generators;
    if (!Array.isArray(generators)) {
      deny("git.prepareCommit.generators must be an array");
    }
    result.generators = generators.map((generator, index) => {
      const label = `git.prepareCommit.generators[${index}]`;
      if (!isPlainObject(generator) || generator.kind === "host") {
        deny(`${label} must be a container step`);
      }
      const step = validateContainerStep(manifest, generator, label, { allowTarget: false });
      const requires =
        generator.requires === undefined
          ? null
          : validateRepositoryRelativePath(generator.requires, `${label}.requires`);
      const stages = generator.stages === undefined ? [] : generator.stages;
      if (!Array.isArray(stages)) {
        deny(`${label}.stages must be an array`);
      }
      return Object.freeze({
        step,
        requires,
        stages: Object.freeze(
          stages.map((entry, stageIndex) =>
            validateRepositoryRelativePath(entry, `${label}.stages[${stageIndex}]`),
          ),
        ),
        tolerateMissingExecutable: assertOptionalBoolean(
          generator.tolerateMissingExecutable,
          `${label}.tolerateMissingExecutable`,
        ),
      });
    });
    const hardlinks = prepare.hardlinks === undefined ? [] : prepare.hardlinks;
    if (!Array.isArray(hardlinks)) {
      deny("git.prepareCommit.hardlinks must be an array");
    }
    result.hardlinks = hardlinks.map((entry, index) => {
      const label = `git.prepareCommit.hardlinks[${index}]`;
      if (!isPlainObject(entry)) {
        deny(`${label} must be an object`);
      }
      return Object.freeze({
        source: validateRepositoryRelativePath(entry.source, `${label}.source`),
        target: validateRepositoryRelativePath(entry.target, `${label}.target`),
      });
    });
  }
  return Object.freeze({
    generators: Object.freeze(result.generators),
    hardlinks: Object.freeze(result.hardlinks),
  });
}

export function validateWorktrees(worktrees) {
  return Object.freeze({
    containerRoot:
      worktrees === undefined
        ? DEFAULT_WORKTREE_CONTAINER_ROOT
        : assertAbsoluteContainerPath(worktrees?.containerRoot, "worktrees.containerRoot"),
  });
}

export function validateSearch(search) {
  return Object.freeze({
    defaultPath:
      search?.defaultPath === undefined
        ? "."
        : validateRepositoryRelativePath(search.defaultPath, "search.defaultPath", {
            allowRoot: true,
          }),
  });
}

export function validateCompose(compose) {
  const settings = Object.freeze({
    envFile:
      compose?.envFile === undefined
        ? null
        : validateRepositoryRelativePath(compose.envFile, "compose.envFile"),
    projectVariable:
      compose?.projectVariable === undefined
        ? null
        : assertString(compose.projectVariable, "compose.projectVariable"),
  });
  if (settings.projectVariable !== null && !/^[A-Z_][A-Z0-9_]*$/.test(settings.projectVariable)) {
    deny("compose.projectVariable must be an environment variable name");
  }
  return settings;
}

export function validateIsolation(isolation, containers) {
  if (isolation === undefined) {
    return null;
  }
  if (!isPlainObject(isolation)) {
    deny("isolation must be an object");
  }
  const builder = assertString(isolation.builder, "isolation.builder");
  if (!Object.hasOwn(containers, builder)) {
    deny(`isolation.builder ${JSON.stringify(builder)} is not a declared container`);
  }
  let probe = builder;
  if (isolation.probe !== undefined) {
    probe = assertString(isolation.probe, "isolation.probe");
    if (!Object.hasOwn(containers, probe)) {
      deny(`isolation.probe ${JSON.stringify(probe)} is not a declared container`);
    }
  }
  return Object.freeze({ builder, probe });
}
