import assert from "node:assert/strict";
import * as realFs from "node:fs";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { mock } from "node:test";

// Two registry behaviours cannot be produced on a supported host: a kernel
// without O_NOFOLLOW, and an fs.watch error event whose timing is
// platform-dependent. The node:fs seam below injects both while everything
// else stays real; registry.mjs is imported against the mock.
const mockConstants = { ...realFs.constants };
let watchImpl = realFs.watch;

mock.module("node:fs", {
  namedExports: {
    ...realFs,
    constants: mockConstants,
    watch: (...args) => watchImpl(...args),
  },
});

const { createRegistry, loadPolicy } = await import("../src/registry.mjs");

test.afterEach(() => {
  mockConstants.O_NOFOLLOW = realFs.constants.O_NOFOLLOW;
  watchImpl = realFs.watch;
});

test("a host without O_NOFOLLOW refuses to load policies", async (t) => {
  mockConstants.O_NOFOLLOW = 0;
  await assert.rejects(
    loadPolicy("/tmp/registry-mocks/projects/proj_alpha.json"),
    /host does not expose no-follow policy opening/,
  );
});

test("a host whose O_NOFOLLOW is not a number refuses to load policies", async (t) => {
  mockConstants.O_NOFOLLOW = "not-a-number";
  await assert.rejects(
    loadPolicy("/tmp/registry-mocks/projects/proj_alpha.json"),
    /host does not expose no-follow policy opening/,
  );
});

test("a background refresh failure without a logger is swallowed", async (t) => {
  const runtimeRoot = path.join(tmpdir(), "registry-mocks-nolog-");
  const projectsRoot = path.join(runtimeRoot, "projects");
  await mkdir(projectsRoot, { recursive: true, mode: 0o700 });
  const policyPath = path.join(projectsRoot, "proj_alpha.json");
  const registry = createRegistry({ runtimeRoot });
  await registry.load();
  await writeFile(policyPath, "{}\n", { mode: 0o600 });
  await chmod(projectsRoot, 0o000);
  try {
    // The watcher debounce is 250ms; give the failing refresh time to run.
    await new Promise((resolve) => setTimeout(resolve, 700));
  } finally {
    await chmod(projectsRoot, 0o700);
  }
  registry.dispose();
});

test("a failed directory watcher is re-armed on the next load", async (t) => {
  const watches = [];
  let reportWatcherError;
  watchImpl = (directory, options, listener) => {
    watches.push(directory);
    return {
      on(event, callback) {
        assert.equal(event, "error");
        reportWatcherError = callback;
      },
      close() {},
    };
  };
  const registry = createRegistry({ runtimeRoot: "/tmp/registry-mocks-absent" });
  await registry.load();
  assert.equal(watches.length, 1);
  assert.equal(typeof reportWatcherError, "function");

  reportWatcherError(new Error("watch failed"));
  await registry.load();
  assert.equal(watches.length, 2, "the watcher was replaced after its error");
  registry.dispose();
  assert.deepEqual(registry.entries(), []);
});
