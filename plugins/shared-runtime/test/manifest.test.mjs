import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  DEFAULT_WORKTREE_CONTAINER_ROOT,
  describeOperations,
  expandDependencies,
  listOperationNames,
  manifestDigest,
  readManifest,
  substitutePlaceholders,
  validateManifest,
  validateRepositoryRelativePath,
} from "../src/manifest.mjs";

const execFileAsync = promisify(execFile);
const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixturePath = path.join(pluginRoot, "test", "fixtures", "example.bb-runtime.json");

async function fixtureDocument() {
  return JSON.parse(await readFile(fixturePath, "utf8"));
}

function minimal(overrides = {}) {
  return {
    version: 1,
    isolation: { builder: "app" },
    containers: {
      app: { service: "app", mounts: [{ host: ".", container: "/app" }] },
    },
    operations: {
      tests: { container: "app", argv: ["npm", "test"] },
    },
    ...overrides,
  };
}

test("the example fixture manifest validates and describes every operation", async () => {
  const manifest = validateManifest(await fixtureDocument());
  assert.equal(manifest.isolation.builder, "worker");
  assert.equal(manifest.isolation.probe, "api");
  assert.deepEqual(Object.keys(manifest.containers), ["worker", "web", "api"]);
  assert.equal(manifest.containers.api.root, "src/api");
  assert.equal(manifest.worktrees.containerRoot, "/bb-worktrees");
  assert.equal(manifest.search.defaultPath, "src");
  const described = describeOperations(manifest);
  assert.ok(described.some((line) => line.startsWith("api_unit (requires target matching")));
  assert.ok(described.some((line) => line === "go_full (sequence: go_format_check, go_vet, go_tests)"));
  assert.ok(described.some((line) => line.includes('go_tests (target one of "timeline_postgres")')));
  assert.equal(manifest.git.generators.length, 2);
  assert.equal(manifest.git.hardlinks.length, 1);
});

test("manifest validation refuses shell evaluation and unknown placeholders", () => {
  assert.throws(
    () =>
      validateManifest(
        minimal({ operations: { bad: { container: "app", argv: ["bash", "-c", "rm -rf /"] } } }),
      ),
    /may not evaluate inline shell text/,
  );
  assert.throws(
    () =>
      validateManifest(
        minimal({ operations: { bad: { container: "app", argv: ["node", "-e", "1"] } } }),
      ),
    /may not evaluate inline script text/,
  );
  assert.throws(
    () =>
      validateManifest(
        minimal({ operations: { bad: { container: "app", argv: ["npm", "${nope}"] } } }),
      ),
    /unknown placeholder "nope"/,
  );
  assert.throws(
    () =>
      validateManifest(
        minimal({ operations: { bad: { container: "missing", argv: ["npm"] } } }),
      ),
    /is not declared/,
  );
  assert.throws(
    () => validateManifest(minimal({ operations: { "Bad-Name": { container: "app", argv: ["x"] } } })),
    /operation name "Bad-Name" is invalid/,
  );
  assert.throws(
    () => validateManifest(minimal({ version: 2 })),
    /version must be 1/,
  );
  assert.equal(
    validateManifest(minimal({ isolation: undefined })).isolation,
    null,
    "the minimal manifest declares container operations and no isolation section",
  );
  assert.throws(
    () =>
      validateManifest(
        minimal({
          operations: {
            unit: {
              container: "app",
              argv: ["npm", "test"],
              target: { pattern: "^[a-z]+$" },
            },
          },
        }),
      ),
    /never uses \$\{target\}/,
  );
  assert.throws(
    () =>
      validateManifest(
        minimal({
          operations: {
            unit: {
              container: "app",
              argv: ["npm", "test", "${target}"],
              target: { pattern: "[a-z]+" },
            },
          },
        }),
      ),
    /anchored/,
  );
  assert.throws(
    () =>
      validateManifest(
        minimal({
          operations: {
            a: { container: "app", argv: ["npm"] },
            all: { steps: ["a", "missing"] },
          },
        }),
      ),
    /references unknown operation "missing"/,
  );
  assert.throws(
    () =>
      validateManifest(
        minimal({
          operations: {
            unit: { container: "app", argv: ["npm", "${target}"], target: { pattern: "^x$", required: true } },
            all: { steps: ["unit"] },
          },
        }),
      ),
    /may not reference an operation that requires a target/,
  );
  assert.throws(
    () =>
      validateManifest(
        minimal({ lifecycle: { ensure: ["docker", "compose", "up"] } }),
      ),
    /must start with a known interpreter/,
  );
  assert.throws(
    () => validateManifest(minimal({ dependencies: [{ path: "../vendor", link: "/x" }] })),
    /escapes the repository/,
  );
  assert.throws(
    () => validateManifest(minimal({ dependencies: [{ path: "apps/*/node_modules", mirror: "/app/node_modules" }] })),
    /must repeat every wildcard segment/,
  );
});

test("host steps are limited to primary-checkout scripts under a known interpreter", () => {
  const manifest = validateManifest(
    minimal({
      operations: {
        integration: {
          container: "app",
          argv: ["npm", "test"],
          target: {
            variants: {
              postgres: {
                kind: "host",
                argv: ["bash", "scripts/integration.sh", "--fast"],
                containers: ["app"],
                env: { WORKDIR: "${root.app}" },
              },
            },
          },
        },
      },
    }),
  );
  const variant = manifest.operations.integration.target.variants.postgres;
  assert.equal(variant.kind, "host");
  assert.equal(variant.script, "scripts/integration.sh");
  assert.deepEqual(variant.argv, ["--fast"]);
  assert.throws(
    () =>
      validateManifest(
        minimal({
          operations: {
            bad: { kind: "host", argv: ["python", "/etc/passwd"] },
          },
        }),
      ),
    /must be a repository-relative POSIX path/,
  );
  assert.throws(
    () =>
      validateManifest(
        minimal({
          operations: {
            bad: { kind: "host", argv: ["custom-binary", "scripts/x.sh"] },
          },
        }),
      ),
    /must start with a known interpreter/,
  );
});

test("placeholder substitution is explicit and fails closed", () => {
  assert.equal(
    substitutePlaceholders("--require=${runtime}/preload.cjs", { runtime: "/x/assets" }),
    "--require=/x/assets/preload.cjs",
  );
  assert.throws(
    () => substitutePlaceholders("${missing}", {}, "argv"),
    /argv references unresolved placeholder "missing"/,
  );
});

test("dependency wildcards expand against the primary checkout only", async () => {
  const manifest = validateManifest(
    minimal({
      dependencies: [
        { path: "vendor", link: "/app/vendor" },
        { path: "apps/*/node_modules", mirror: "/app/apps/*/node_modules", local: [".vite"] },
      ],
    }),
  );
  const tree = {
    "/primary/apps": [
      { name: "web", isDirectory: () => true },
      { name: "api", isDirectory: () => true },
      { name: ".hidden", isDirectory: () => true },
      { name: "README.md", isDirectory: () => false },
    ],
  };
  const existing = new Set(["/primary/apps/web/node_modules"]);
  const expanded = await expandDependencies(manifest, "/primary", {
    readDirectory: async (directory) => {
      if (!tree[directory]) {
        const error = new Error("missing");
        error.code = "ENOENT";
        throw error;
      }
      return tree[directory];
    },
    pathExists: async (target) => existing.has(target),
  });
  assert.deepEqual(
    expanded.map((entry) => [entry.kind, entry.relativePath, entry.containerTarget]),
    [
      ["link", "vendor", "/app/vendor"],
      ["mirror", "apps/web/node_modules", "/app/apps/web/node_modules"],
    ],
  );
});

test("readManifest hashes the exact committed bytes", async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "shared-runtime-manifest-")));
  try {
    await assert.rejects(readManifest(root), /manifest missing/);
    const content = `${JSON.stringify(minimal(), null, 2)}\n`;
    await writeFile(path.join(root, ".bb-runtime.json"), content);
    const loaded = await readManifest(root);
    assert.equal(loaded.digest, manifestDigest(content));
    assert.equal(loaded.manifest.operations.tests.step.container, "app");
    await writeFile(path.join(root, ".bb-runtime.json"), "{ not json");
    await assert.rejects(readManifest(root), /not valid JSON/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("readManifest accepts a trusted manifest outside the repository root", async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "shared-runtime-root-")));
  const manifestRoot = await realpath(
    await mkdtemp(path.join(tmpdir(), "shared-runtime-external-manifest-")),
  );
  try {
    const manifestPath = path.join(manifestRoot, "example.json");
    const content = `${JSON.stringify(minimal(), null, 2)}\n`;
    await writeFile(manifestPath, content);
    const loaded = await readManifest(root, manifestPath);
    assert.equal(loaded.path, manifestPath);
    assert.equal(loaded.digest, manifestDigest(content));
    await assert.rejects(readManifest(root, "relative.json"), /path must be absolute/u);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(manifestRoot, { recursive: true, force: true });
  }
});

test("the CLI validates a manifest and prints a compose overlay without a registry", async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "shared-runtime-cli-")));
  try {
    await writeFile(path.join(root, ".bb-runtime.json"), await readFile(fixturePath));
    const cli = path.join(pluginRoot, "bin", "bb-shared-runtime.mjs");
    const validated = await execFileAsync(process.execPath, [cli, "validate", "--json"], { cwd: root });
    const summary = JSON.parse(validated.stdout);
    assert.deepEqual(summary.containers, ["worker", "web", "api"]);
    assert.ok(summary.operations.includes("api_static"));
    const overlay = await execFileAsync(process.execPath, [cli, "compose-overlay"], { cwd: root });
    assert.match(overlay.stdout, /^services:$/m);
    assert.match(overlay.stdout, /^  api:$/m);
    assert.match(overlay.stdout, /BB_WORKTREES_ROOT[^\n]*:\/bb-worktrees$/m);
    assert.match(overlay.stdout, /BB_PRIMARY_ROOT[^\n]*\/src\/api:\/srv\/api$/m);
    const help = await execFileAsync(process.execPath, [cli], { cwd: root });
    assert.match(help.stdout, /Usage: bb-shared-runtime/);
    await assert.rejects(
      execFileAsync(process.execPath, [cli, "bogus"], { cwd: root }),
      /Unknown command: bogus/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

const app = (extra = {}) => ({ container: "app", argv: ["npm", "test"], ...extra });
const withOperation = (operation, extra = {}) =>
  minimal({ operations: { tests: app(), probe: operation }, ...extra });
const withContainer = (entry) => minimal({ containers: { app: minimal().containers.app, other: entry } });
const withGit = (git) => minimal({ git });

const invalidManifests = [
  ["a non-object document", null, /document must be a JSON object/],
  ["an array document", [], /document must be a JSON object/],
  ["an empty name", minimal({ name: " " }), /name must be a non-empty string/],
  ["a NUL in a string", minimal({ name: "a\0b" }), /name must be a non-empty string/],

  ["no containers", minimal({ containers: {} }), /containers must declare at least one container/],
  ["containers as an array", minimal({ containers: [] }), /containers must declare at least one container/],
  ["an invalid role", minimal({ containers: { App: minimal().containers.app } }), /containers role "App" is invalid/],
  ["a non-object container", withContainer("svc"), /containers\.other must be an object/],
  ["a missing service", withContainer({ mounts: [{ host: ".", container: "/x" }] }), /containers\.other\.service must be a non-empty string/],
  ["an invalid service", withContainer({ service: "-svc", mounts: [{ host: ".", container: "/x" }] }), /containers\.other\.service is invalid/],
  ["no mounts", withContainer({ service: "svc", mounts: [] }), /containers\.other\.mounts must list at least one mount/],
  ["a non-object mount", withContainer({ service: "svc", mounts: ["."] }), /containers\.other\.mounts\[0\] must be an object/],
  ["an absolute mount host", withContainer({ service: "svc", mounts: [{ host: "/etc", container: "/x" }] }), /mounts\[0\]\.host must be a repository-relative POSIX path/],
  ["a relative mount target", withContainer({ service: "svc", mounts: [{ host: ".", container: "x" }] }), /mounts\[0\]\.container must be an absolute container path/],
  ["a backslash mount target", withContainer({ service: "svc", mounts: [{ host: ".", container: "/x\\y" }] }), /mounts\[0\]\.container must be an absolute container path/],
  ["an escaping container root", withContainer({ service: "svc", root: "a/../../b", mounts: [{ host: ".", container: "/x" }] }), /containers\.other\.root escapes the repository/],
  ["an empty container name", withContainer({ service: "svc", containerName: "", mounts: [{ host: ".", container: "/x" }] }), /containers\.other\.containerName must be a non-empty string/],

  ["scratch as an array", minimal({ scratch: [] }), /scratch must be an object/],
  ["an invalid scratch name", minimal({ scratch: { Cache: {} } }), /scratch name "Cache" is invalid/],
  ["a scalar scratch entry", minimal({ scratch: { cache: "yes" } }), /scratch\.cache must be an object with an optional env array/],
  ["a scratch env object", minimal({ scratch: { cache: { env: {} } } }), /scratch\.cache must be an object with an optional env array/],
  ["a lowercase scratch variable", minimal({ scratch: { cache: { env: ["gocache"] } } }), /scratch\.cache\.env entries must be environment variable names/],

  ["lifecycle as an array", minimal({ lifecycle: [] }), /lifecycle must be an object/],
  ["an unknown lifecycle operation", minimal({ lifecycle: { restart: ["bash", "x.sh"] } }), /lifecycle\.restart is not a lifecycle operation/],
  ["an empty lifecycle argv", minimal({ lifecycle: { ensure: [] } }), /lifecycle\.ensure must be a non-empty argument array/],
  ["a lifecycle without a script", minimal({ lifecycle: { ensure: ["bash"] } }), /lifecycle\.ensure may not evaluate inline shell text/],
  ["a script lifecycle without a script", minimal({ lifecycle: { stop: ["node"] } }), /lifecycle\.stop needs a script relative to the manifest's script root/],
  ["a lifecycle script at the root", minimal({ lifecycle: { stop: ["bash", "."] } }), /lifecycle\.stop\[1\] may not be the repository root/],
  ["a lifecycle placeholder", minimal({ lifecycle: { stop: ["bash", "stop.sh", "${env}"] } }), /lifecycle\.stop arguments may not use placeholders/],

  ["a non-object worktrees block", minimal({ worktrees: {} }), /worktrees\.containerRoot must be a non-empty string/],
  ["a relative worktree root", minimal({ worktrees: { containerRoot: "bb" } }), /worktrees\.containerRoot must be an absolute container path/],
  ["an option-like search path", minimal({ search: { defaultPath: "-src" } }), /search\.defaultPath must be a repository-relative POSIX path/],
  ["a compose env file at the root", minimal({ compose: { envFile: "." } }), /compose\.envFile may not be the repository root/],
  ["an empty compose variable", minimal({ compose: { projectVariable: "" } }), /compose\.projectVariable must be a non-empty string/],
  ["a lowercase compose variable", minimal({ compose: { projectVariable: "project" } }), /compose\.projectVariable must be an environment variable name/],

  ["isolation as a string", minimal({ isolation: "app" }), /isolation must be an object/],
  ["an undeclared isolation builder", minimal({ isolation: { builder: "go" } }), /isolation\.builder "go" is not a declared container/],
  ["an empty isolation probe", minimal({ isolation: { builder: "app", probe: "" } }), /isolation\.probe must be a non-empty string/],
  ["an undeclared isolation probe", minimal({ isolation: { builder: "app", probe: "php" } }), /isolation\.probe "php" is not a declared container/],

  ["dependencies as an object", minimal({ dependencies: {} }), /dependencies must be an array/],
  ["a scalar dependency", minimal({ dependencies: ["vendor"] }), /dependencies\[0\] must be an object/],
  ["a partial wildcard", minimal({ dependencies: [{ path: "apps/web*/node_modules", mirror: "/a/*/n" }] }), /dependencies\[0\]\.path wildcards must be whole path segments/],
  ["a link and a mirror", minimal({ dependencies: [{ path: "vendor", link: "/v", mirror: "/v" }] }), /dependencies\[0\] may not be both a link and a mirror/],
  ["a link missing a wildcard", minimal({ dependencies: [{ path: "apps/*/vendor", link: "/app/vendor" }] }), /dependencies\[0\]\.link must repeat every wildcard segment of path/],
  ["a link with local caches", minimal({ dependencies: [{ path: "vendor", link: "/app/vendor", local: [".cache"] }] }), /dependencies\[0\]\.local is only valid for mirrors/],
  ["a dependency without a target", minimal({ dependencies: [{ path: "vendor" }] }), /dependencies\[0\] needs a link or mirror target/],
  ["a relative mirror", minimal({ dependencies: [{ path: "vendor", mirror: "vendor" }] }), /dependencies\[0\]\.mirror must be an absolute container path/],
  ["local caches as a string", minimal({ dependencies: [{ path: "vendor", mirror: "/v", local: ".cache" }] }), /dependencies\[0\]\.local must be an array/],
  ["a nested local cache", minimal({ dependencies: [{ path: "vendor", mirror: "/v", local: ["a/b"] }] }), /dependencies\[0\]\.local entries must be single directory names/],
  ["a parent local cache", minimal({ dependencies: [{ path: "vendor", mirror: "/v", local: [".."] }] }), /dependencies\[0\]\.local entries must be single directory names/],

  ["operations as an array", minimal({ operations: [] }), /operations must be an object/],
  ["an overlong operation name", minimal({ operations: { ["a".repeat(65)]: app() } }), /operation name "a{65}" is invalid/],
  ["a scalar operation", withOperation("npm test"), /operations\.probe must be an object/],
  ["an empty step list", withOperation({ steps: [] }), /operations\.probe\.steps must be a non-empty array/],
  ["a step list with a target", withOperation({ steps: ["tests"], target: { pattern: "^x$" } }), /operations\.probe step lists do not accept a target/],
  ["a scalar inline step", withOperation({ steps: [42] }), /operations\.probe\.steps\[0\] must be an object/],
  ["an unknown step kind", withOperation({ kind: "remote", argv: ["x"] }), /operations\.probe\.kind must be "container" or "host"/],
  ["a missing container", withOperation({ argv: ["npm"] }), /operations\.probe\.container must be a non-empty string/],
  ["a string argv", withOperation(app({ argv: "npm test" })), /operations\.probe\.argv must be a non-empty argument array/],
  ["a numeric argument", withOperation(app({ argv: ["npm", 1] })), /operations\.probe\.argv\[1\] must be a string/],
  ["an option as the program", withOperation(app({ argv: ["--version"] })), /operations\.probe\.argv program is invalid/],
  ["an empty program", withOperation(app({ argv: [""] })), /operations\.probe\.argv program is invalid/],
  ["an interactive shell", withOperation(app({ argv: ["/bin/sh", "-i"] })), /may not evaluate inline shell text/],
  ["a python eval", withOperation(app({ argv: ["python3", "-e", "x"] })), /may not evaluate inline script text/],
  ["an escaping cwd", withOperation(app({ cwd: "../x" })), /operations\.probe\.cwd escapes the repository/],
  ["env as an array", withOperation(app({ env: [] })), /operations\.probe\.env must be an object/],
  ["a lowercase env name", withOperation(app({ env: { path: "/x" } })), /operations\.probe\.env name "path" is invalid/],
  ["a numeric env value", withOperation(app({ env: { N: 1 } })), /operations\.probe\.env\.N must be a string/],
  ["an unknown env placeholder", withOperation(app({ env: { N: "${home}" } })), /operations\.probe references unknown placeholder "home"/],
  ["a string failOnStdout", withOperation(app({ failOnStdout: "true" })), /operations\.probe\.failOnStdout must be a boolean/],
  ["a target placeholder without a target", withOperation(app({ argv: ["npm", "${target}"] })), /references unknown placeholder "target"/],

  ["a scalar target", withOperation(app({ target: "x" })), /operations\.probe\.target must be an object/],
  ["an empty target description", withOperation(app({ argv: ["npm", "${target}"], target: { pattern: "^x$", description: "" } })), /operations\.probe\.target\.description must be a non-empty string/],
  ["a string target requirement", withOperation(app({ argv: ["npm", "${target}"], target: { pattern: "^x$", required: "yes" } })), /operations\.probe\.target\.required must be a boolean/],
  ["an invalid target pattern", withOperation(app({ argv: ["npm", "${target}"], target: { pattern: "^(x$" } })), /operations\.probe\.target\.pattern is not a valid regular expression/],
  ["empty target variants", withOperation(app({ target: { variants: {} } })), /operations\.probe\.target\.variants must be a non-empty object/],
  ["a target without a matcher", withOperation(app({ target: { required: true } })), /operations\.probe\.target needs a pattern or variants/],
  ["a pattern with variants", withOperation(app({ argv: ["npm", "${target}"], target: { pattern: "^x$", variants: { a: app() } } })), /may not combine a pattern with variants/],
  ["an invalid variant name", withOperation(app({ target: { variants: { "-a": app() } } })), /operations\.probe\.target\.variants name "-a" is invalid/],
  ["a target placeholder in a variant", withOperation(app({ target: { variants: { a: app({ argv: ["npm", "${target}"] }) } } })), /target\.variants\.a references unknown placeholder "target"/],

  ["a host step without a script", withOperation({ kind: "host", argv: ["bash"] }), /may not evaluate inline shell text/],
  ["a script host step without a script", withOperation({ kind: "host", argv: ["ruby"] }), /operations\.probe\.argv host steps need a script relative to the manifest's script root/],
  ["host containers as a string", withOperation({ kind: "host", argv: ["bash", "x.sh"], containers: "app" }), /operations\.probe\.containers must be an array/],
  ["an undeclared host container", withOperation({ kind: "host", argv: ["bash", "x.sh"], containers: ["db"] }), /operations\.probe\.containers references undeclared container "db"/],

  ["a reference to a step list", minimal({ operations: { tests: app(), all: { steps: ["tests"] }, meta: { steps: ["all"] } } }), /operations\.meta may only reference single-step operations/],

  ["git as an array", withGit([]), /git must be an object/],
  ["prepareCommit as an array", withGit({ prepareCommit: [] }), /git\.prepareCommit must be an object/],
  ["generators as an object", withGit({ prepareCommit: { generators: {} } }), /git\.prepareCommit\.generators must be an array/],
  ["a host generator", withGit({ prepareCommit: { generators: [{ kind: "host", argv: ["bash", "g.sh"] }] } }), /git\.prepareCommit\.generators\[0\] must be a container step/],
  ["a scalar generator", withGit({ prepareCommit: { generators: ["make"] } }), /git\.prepareCommit\.generators\[0\] must be a container step/],
  ["a root generator requirement", withGit({ prepareCommit: { generators: [app({ requires: "." })] } }), /generators\[0\]\.requires may not be the repository root/],
  ["generator stages as a string", withGit({ prepareCommit: { generators: [app({ stages: "out" })] } }), /git\.prepareCommit\.generators\[0\]\.stages must be an array/],
  ["an escaping generator stage", withGit({ prepareCommit: { generators: [app({ stages: ["../out"] })] } }), /generators\[0\]\.stages\[0\] escapes the repository/],
  ["a string tolerance flag", withGit({ prepareCommit: { generators: [app({ tolerateMissingExecutable: 1 })] } }), /generators\[0\]\.tolerateMissingExecutable must be a boolean/],
  ["hardlinks as an object", withGit({ prepareCommit: { hardlinks: {} } }), /git\.prepareCommit\.hardlinks must be an array/],
  ["a scalar hardlink", withGit({ prepareCommit: { hardlinks: ["a"] } }), /git\.prepareCommit\.hardlinks\[0\] must be an object/],
  ["an absolute hardlink target", withGit({ prepareCommit: { hardlinks: [{ source: "a", target: "/b" }] } }), /hardlinks\[0\]\.target must be a repository-relative POSIX path/],
  ["an empty isolation builder", minimal({ isolation: { builder: "" } }), /isolation\.builder must be a non-empty string/],
  ["an undeclared isolation probe without a builder", minimal({ isolation: { probe: "php" } }), /isolation\.probe "php" is not a declared container/],
  ["an undeclared isolation builder beside a valid probe", minimal({ isolation: { builder: "go", probe: "app" } }), /isolation\.builder "go" is not a declared container/],
];

test("manifest validation rejects each malformed section with a precise message", () => {
  for (const [label, document, expected] of invalidManifests) {
    assert.throws(
      () => validateManifest(document),
      (error) => {
        assert.ok(error instanceof Error, label);
        assert.match(error.message, /^Shared runtime manifest invalid: /, label);
        assert.match(error.message, expected, label);
        return true;
      },
      label,
    );
  }
});

test("isolation is optional and its builder and probe are each optional", () => {
  assert.equal(
    validateManifest(minimal({ isolation: undefined, operations: {}, git: { prepareCommit: { generators: [app()] } } })).isolation,
    null,
    "a generator without isolation",
  );
  assert.equal(
    validateManifest(minimal({ isolation: undefined, operations: { all: { steps: [{ kind: "host", argv: ["bash", "x.sh"] }] } } })).isolation,
    null,
    "a step list without isolation",
  );
  assert.deepEqual(validateManifest(minimal({ isolation: { probe: "app" } })).isolation, { builder: null, probe: "app" });
  assert.deepEqual(validateManifest(minimal({ isolation: { builder: "app" } })).isolation, { builder: "app", probe: null });
  assert.deepEqual(validateManifest(minimal({ isolation: {} })).isolation, { builder: null, probe: null });
});

test("a Python-only stack validates without any isolation section", () => {
  // Regression, BB thread thr_69ubadfky5: a Python-only stack could not run any
  // operation because the plugin compiled its launcher with Go inside the project.
  const manifest = validateManifest({
    version: 1,
    containers: { python: { service: "python", mounts: [{ host: ".", container: "/app" }] } },
    operations: {
      tests: { container: "python", argv: ["pytest", "-q"] },
      lint: { container: "python", argv: ["ruff", "check", "."] },
    },
  });
  assert.equal(manifest.isolation, null);
  assert.deepEqual(Object.keys(manifest.operations), ["tests", "lint"]);
});

test("repository-relative paths normalise safely", () => {
  assert.equal(validateRepositoryRelativePath("./src//app/", "p"), "src/app");
  assert.equal(validateRepositoryRelativePath("./", "p", { allowRoot: true }), ".");
  assert.throws(() => validateRepositoryRelativePath("a\\b", "p"), /p must be a repository-relative POSIX path/);
  assert.throws(() => validateRepositoryRelativePath("a/..", "p"), /p may not be the repository root/);
  assert.throws(() => validateRepositoryRelativePath("a/../..", "p"), /p escapes the repository/);
  assert.throws(() => validateRepositoryRelativePath(7, "p"), /p must be a non-empty string/);
});

test("host placeholders and defaults are resolved by section", () => {
  const manifest = validateManifest(
    minimal({
      name: "Fixture",
      worktrees: { containerRoot: "/wt/" },
      // Retired CodeGraph block, still present in committed manifests: ignored.
      codegraph: { enabled: "yes" },
      compose: { envFile: "docker/.env", projectVariable: "COMPOSE_PROJECT" },
      scratch: { cache: null, "go-mod": { env: ["GOMODCACHE"] } },
      containers: {
        app: { service: "app.svc", root: "src", containerName: "fixed", mounts: [{ host: ".", container: "/" }] },
      },
      operations: {
        host: { kind: "host", argv: ["bash", "scripts/it.sh", "${worktreeRoot}", "${root.app}"], containers: ["app"] },
        cwd: { container: "app", argv: ["ls"], env: { OUT: "${scratch.go-mod}" } },
      },
    }),
  );
  assert.equal(manifest.name, "Fixture");
  assert.equal(manifest.worktrees.containerRoot, "/wt");
  assert.equal("codegraph" in manifest, false);
  assert.deepEqual(manifest.compose, { envFile: "docker/.env", projectVariable: "COMPOSE_PROJECT" });
  assert.deepEqual(manifest.scratch.cache.environment, []);
  assert.deepEqual(manifest.scratch["go-mod"].environment, ["GOMODCACHE"]);
  assert.equal(manifest.containers.app.containerName, "fixed");
  assert.equal(manifest.containers.app.mounts[0].container, "/");
  const collapsed = validateManifest(
    minimal({ containers: { app: { service: "app", mounts: [{ host: ".", container: "/srv/app/../data/" }] } } }),
  );
  assert.equal(collapsed.containers.app.mounts[0].container, "/srv/data", "absolute container paths normalise");
  assert.equal(manifest.operations.cwd.step.cwd, "src", "container steps default to the container root");
  assert.equal(manifest.operations.host.step.usesTarget, false);
  assert.deepEqual(manifest.operations.host.step.argv, ["${worktreeRoot}", "${root.app}"]);
  assert.throws(
    () =>
      validateManifest(
        minimal({ operations: { bad: { container: "app", argv: ["ls", "${worktreeRoot}"] } } }),
      ),
    /operations\.bad references unknown placeholder "worktreeRoot"/,
    "worktreeRoot is only available to host steps",
  );

  const defaults = validateManifest({
    version: 1,
    containers: { app: { service: "app", mounts: [{ host: ".", container: "/app" }] } },
  });
  assert.equal(defaults.name, null);
  assert.equal(defaults.isolation, null);
  assert.equal(defaults.worktrees.containerRoot, DEFAULT_WORKTREE_CONTAINER_ROOT);
  assert.equal(defaults.search.defaultPath, ".");
  assert.deepEqual(defaults.compose, { envFile: null, projectVariable: null });
  assert.deepEqual(defaults.lifecycle, {});
  assert.deepEqual(defaults.operations, {});
  assert.deepEqual(defaults.git, { generators: [], hardlinks: [] });
  assert.deepEqual(listOperationNames(defaults), []);
});

test("operation descriptions name inline steps, targets, and descriptions", () => {
  const manifest = validateManifest(
    minimal({
      operations: {
        tests: app(),
        unit: {
          ...app({ argv: ["npm", "test", "--", "${target}"] }),
          target: { pattern: "^[a-z]+$", description: "package name" },
        },
        all: {
          steps: [
            "tests",
            { container: "app", argv: ["npm", "run", "build"] },
            { kind: "host", argv: ["bash", "scripts/smoke.sh"] },
            { kind: "host", argv: ["bash", "scripts/deploy.sh", "--dry-run"] },
          ],
        },
      },
    }),
  );
  assert.equal(manifest.operations.unit.step.usesTarget, true);
  assert.deepEqual(describeOperations(manifest), [
    "all (sequence: tests, container:npm, host:scripts/smoke.sh, host:scripts/deploy.sh)",
    "tests",
    "unit (accepts target matching ^[a-z]+$: package name)",
  ]);
});

test("dependency wildcard expansion skips unreadable levels and surfaces other failures", async () => {
  const manifest = validateManifest(
    minimal({ dependencies: [{ path: "apps/*/packages/*/node_modules", mirror: "/app/apps/*/packages/*/node_modules" }] }),
  );
  const directory = (name) => ({ name, isDirectory: () => true });
  const tree = {
    "/primary/apps": [directory("web"), directory("api"), directory("docs")],
    "/primary/apps/web/packages": [directory("ui")],
  };
  const failures = { "/primary/apps/api/packages": "ENOTDIR", "/primary/apps/docs/packages": "ENOENT" };
  const readDirectory = async (target) => {
    if (failures[target]) {
      throw Object.assign(new Error(failures[target]), { code: failures[target] });
    }
    return tree[target];
  };
  const expanded = await expandDependencies(manifest, "/primary", {
    readDirectory,
    pathExists: async () => true,
  });
  assert.deepEqual(
    expanded.map((entry) => [entry.relativePath, entry.containerTarget]),
    [["apps/web/packages/ui/node_modules", "/app/apps/web/packages/ui/node_modules"]],
  );

  failures["/primary/apps/docs/packages"] = "EACCES";
  await assert.rejects(
    expandDependencies(manifest, "/primary", { readDirectory, pathExists: async () => true }),
    { code: "EACCES" },
  );
});
