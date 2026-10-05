import path from "node:path";

import {
  NAME_PATTERN,
  SHELL_INTERPRETERS,
  SCRIPT_INTERPRETERS,
  deny,
  isPlainObject,
  assertString,
  assertOptionalBoolean,
  validateRepositoryRelativePath,
  assertArgv,
  assertEnvironment,
  knownPlaceholders,
  assertPlaceholders,
} from "./manifest-primitives.mjs";

function validateTarget(value, label) {
  if (value === undefined) {
    return null;
  }
  if (!isPlainObject(value)) {
    deny(`${label} must be an object`);
  }
  const target = {
    description:
      value.description === undefined ? null : assertString(value.description, `${label}.description`),
    pattern: null,
    required: assertOptionalBoolean(value.required, `${label}.required`),
    variants: null,
  };
  if (value.pattern !== undefined) {
    assertString(value.pattern, `${label}.pattern`);
    let expression;
    try {
      expression = new RegExp(value.pattern);
    } catch {
      deny(`${label}.pattern is not a valid regular expression`);
    }
    if (!value.pattern.startsWith("^") || !value.pattern.endsWith("$")) {
      deny(`${label}.pattern must be anchored with ^ and $`);
    }
    target.pattern = expression;
    target.patternSource = value.pattern;
  }
  if (value.variants !== undefined) {
    if (!isPlainObject(value.variants) || Object.keys(value.variants).length === 0) {
      deny(`${label}.variants must be a non-empty object`);
    }
    target.variants = value.variants;
  }
  if (target.pattern === null && target.variants === null) {
    deny(`${label} needs a pattern or variants`);
  }
  if (target.pattern !== null && target.variants !== null) {
    deny(`${label} may not combine a pattern with variants`);
  }
  return target;
}

export function validateContainerStep(manifest, value, label, { allowTarget }) {
  const role = assertString(value.container, `${label}.container`);
  if (!Object.hasOwn(manifest.containers, role)) {
    deny(`${label}.container ${JSON.stringify(role)} is not declared`);
  }
  const container = manifest.containers[role];
  const cwd =
    value.cwd === undefined
      ? container.root
      : validateRepositoryRelativePath(value.cwd, `${label}.cwd`, { allowRoot: true });
  const argv = assertArgv(value.argv, `${label}.argv`);
  const environment = assertEnvironment(value.env, `${label}.env`);
  const failOnStdout = assertOptionalBoolean(value.failOnStdout, `${label}.failOnStdout`);
  const allowed = knownPlaceholders(manifest, { allowTarget });
  const placeholders = assertPlaceholders(
    [...argv, ...Object.values(environment)],
    allowed,
    label,
  );
  return Object.freeze({
    kind: "container",
    container: role,
    cwd,
    argv,
    environment,
    failOnStdout,
    usesTarget: placeholders.has("target"),
  });
}

function validateHostStep(manifest, value, label, { allowTarget }) {
  const argv = assertArgv(value.argv, `${label}.argv`);
  const base = path.posix.basename(argv[0]);
  if (!SHELL_INTERPRETERS.has(base) && !SCRIPT_INTERPRETERS.has(base)) {
    deny(`${label}.argv host steps must start with a known interpreter`);
  }
  if (argv.length < 2) {
    deny(`${label}.argv host steps need a primary-checkout script`);
  }
  const script = validateRepositoryRelativePath(argv[1], `${label}.argv[1]`);
  const environment = assertEnvironment(value.env, `${label}.env`);
  const containers = value.containers === undefined ? [] : value.containers;
  if (!Array.isArray(containers)) {
    deny(`${label}.containers must be an array`);
  }
  for (const role of containers) {
    if (typeof role !== "string" || !Object.hasOwn(manifest.containers, role)) {
      deny(`${label}.containers references undeclared container ${JSON.stringify(role)}`);
    }
  }
  const allowed = knownPlaceholders(manifest, { allowTarget, host: true });
  const placeholders = assertPlaceholders(
    [...argv.slice(2), ...Object.values(environment)],
    allowed,
    label,
  );
  return Object.freeze({
    kind: "host",
    interpreter: base,
    script,
    argv: argv.slice(2),
    environment,
    containers: Object.freeze([...containers]),
    usesTarget: placeholders.has("target"),
  });
}

function validateStep(manifest, value, label, options) {
  if (!isPlainObject(value)) {
    deny(`${label} must be an object`);
  }
  if (value.kind === "host") {
    return validateHostStep(manifest, value, label, options);
  }
  if (value.kind !== undefined && value.kind !== "container") {
    deny(`${label}.kind must be "container" or "host"`);
  }
  return validateContainerStep(manifest, value, label, options);
}

export function validateOperation(manifest, name, value, { nested = false } = {}) {
  const label = `operations.${name}`;
  if (!isPlainObject(value)) {
    deny(`${label} must be an object`);
  }
  if (value.steps !== undefined) {
    if (nested) {
      deny(`${label} may not nest step lists`);
    }
    if (!Array.isArray(value.steps) || value.steps.length === 0) {
      deny(`${label}.steps must be a non-empty array`);
    }
    if (value.target !== undefined) {
      deny(`${label} step lists do not accept a target`);
    }
    const steps = value.steps.map((step, index) => {
      if (typeof step === "string") {
        return { reference: step };
      }
      return validateStep(manifest, step, `${label}.steps[${index}]`, { allowTarget: false });
    });
    return Object.freeze({ kind: "sequence", steps: Object.freeze(steps), target: null });
  }
  const target = validateTarget(value.target, `${label}.target`);
  const step = validateStep(manifest, value, label, { allowTarget: target?.pattern !== null && target !== null });
  if (target?.pattern && !step.usesTarget) {
    deny(`${label} declares a target pattern but never uses \${target}`);
  }
  let variants = null;
  if (target?.variants) {
    variants = {};
    for (const [variantName, variantValue] of Object.entries(target.variants)) {
      if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(variantName)) {
        deny(`${label}.target.variants name ${JSON.stringify(variantName)} is invalid`);
      }
      variants[variantName] = validateStep(
        manifest,
        variantValue,
        `${label}.target.variants.${variantName}`,
        { allowTarget: false },
      );
    }
  }
  return Object.freeze({
    kind: "single",
    step,
    target:
      target === null
        ? null
        : Object.freeze({
            description: target.description,
            pattern: target.pattern,
            patternSource: target.patternSource ?? null,
            required: target.required,
            variants: variants === null ? null : Object.freeze(variants),
          }),
  });
}

function assertSequenceReferences(operations) {
  for (const [name, operation] of Object.entries(operations)) {
    if (operation.kind !== "sequence") {
      continue;
    }
    for (const step of operation.steps) {
      if (step.reference === undefined) {
        continue;
      }
      const referenced = operations[step.reference];
      if (!referenced) {
        deny(`operations.${name} references unknown operation ${JSON.stringify(step.reference)}`);
      }
      if (referenced.kind !== "single") {
        deny(`operations.${name} may only reference single-step operations`);
      }
      if (referenced.target?.required) {
        deny(`operations.${name} may not reference an operation that requires a target`);
      }
    }
  }
}

export function validateOperations(manifest, declared) {
  if (!isPlainObject(declared ?? {})) {
    deny("operations must be an object");
  }
  const operations = {};
  for (const [name, value] of Object.entries(declared ?? {})) {
    if (!NAME_PATTERN.test(name) || name.length > 64) {
      deny(`operation name ${JSON.stringify(name)} is invalid`);
    }
    operations[name] = validateOperation(manifest, name, value);
  }
  assertSequenceReferences(operations);
  return operations;
}
