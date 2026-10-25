import assert from "node:assert/strict";
import * as realFs from "node:fs";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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

async function waitFor(predicate, label, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("timed out waiting for " + label);
}

test("a background refresh failure without a logger is swallowed", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "registry-mocks-nolog-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const projectsRoot = path.join(root, "projects");
  await mkdir(projectsRoot, { recursive: true, mode: 0o700 });
  const policyPath = path.join(projectsRoot, "proj_alpha.json");
  let watcherEvents = 0;
  watchImpl = (directory, options, listener) =>
    realFs.watch(directory, options, (...event) => {
      watcherEvents += 1;
      listener(...event);
    });
  const registry = createRegistry({ runtimeRoot: root });
  try {
    await registry.load();
    assert.equal(registry.entries().length, 0);
    await writeFile(policyPath, "{}\n", { mode: 0o600 });
    await waitFor(() => watcherEvents > 0, "the projects watcher to fire");
    await chmod(projectsRoot, 0o000);
    // The debounced refresh now fails on the unreadable directory; give
    // the failure its 250ms window, then require that nothing surfaced.
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.deepEqual(registry.problems(), []);
    assert.deepEqual(registry.entries(), []);
  } finally {
    registry.dispose();
    await chmod(projectsRoot, 0o700);
  }
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
