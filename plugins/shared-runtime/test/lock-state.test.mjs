import assert from "node:assert/strict";
import test from "node:test";

import { lockMode, reportLockWait, waitForMemoryLock } from "../src/lock-state.mjs";

test("an unsupported lock mode is denied", () => {
  assert.throws(() => lockMode({ mode: "sneaky" }), /unsupported lock mode/);
  assert.equal(lockMode({}), "exclusive");
  assert.equal(lockMode({ mode: "shared" }), "shared");
});

test("releasing a memory lock twice is a no-op the second time", async () => {
  const lockAdapter = new Map();
  const release = await waitForMemoryLock("key", lockAdapter, {});
  await release();
  await release();
  assert.equal(lockAdapter.size, 0, "the lock state is removed after the last release");
});

test("an already-aborted memory lock wait leaves no lock state behind", async () => {
  const lockAdapter = new Map();
  await assert.rejects(
    waitForMemoryLock("key", lockAdapter, { signal: AbortSignal.abort() }),
    { name: "AbortError" },
  );
  assert.equal(lockAdapter.size, 0, "the aborted request cleaned up its state");
});

test("an aborted memory lock wait behind a writer is rejected without the lock", async () => {
  const lockAdapter = new Map();
  const release = await waitForMemoryLock("key", lockAdapter, { mode: "exclusive" });
  const controller = new AbortController();
  const waiter = waitForMemoryLock("key", lockAdapter, {
    mode: "exclusive",
    signal: controller.signal,
  });
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  await assert.rejects(waiter, { name: "AbortError" });
  await release();
  assert.equal(lockAdapter.size, 0);
});

test("a memory waiter behind a reader reports the reader and is granted after release", async () => {
  const lockAdapter = new Map();
  const release = await waitForMemoryLock("key", lockAdapter, { mode: "shared" });
  const waits = [];
  const waiter = waitForMemoryLock("key", lockAdapter, {
    mode: "exclusive",
    signal: new AbortController().signal,
    onWait: (message) => waits.push(message),
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(waits[0], /held by unknown environment running an operation/);
  await release();
  await waiter;
});

