import { deny } from "./runtime-common.mjs";

export const memoryLocks = new Map();
let lockSequence = 0;

export function nextLockSequence() {
  lockSequence += 1;
  return lockSequence;
}

export function lockMode(options) {
  const mode = options.mode ?? "exclusive";
  if (mode !== "shared" && mode !== "exclusive") {
    deny(`unsupported lock mode ${JSON.stringify(mode)}`);
  }
  return mode;
}

export function createLockOwner(options, mode) {
  const supplied = options.owner ?? {};
  return {
    createdAt: Date.now(),
    environmentId:
      typeof supplied.environmentId === "string" && supplied.environmentId !== ""
        ? supplied.environmentId
        : "unknown environment",
    id: `${process.pid}-${Date.now()}-${nextLockSequence()}`,
    mode,
    operation:
      typeof supplied.operation === "string" && supplied.operation !== ""
        ? supplied.operation
        : "an operation",
    pid: process.pid,
  };
}

function lockWaitMessage(label, owner) {
  const createdAt = Number.isFinite(owner?.createdAt)
    ? new Date(owner.createdAt).toISOString()
    : "an unknown time";
  const environmentId =
    typeof owner?.environmentId === "string" && owner.environmentId !== ""
      ? owner.environmentId
      : `pid ${owner?.pid ?? "unknown"}`;
  const operation =
    typeof owner?.operation === "string" && owner.operation !== ""
      ? owner.operation
      : "an operation";
  return `Shared runtime waiting for ${label} held by ${environmentId} running ${operation} since ${createdAt}.`;
}

export function reportLockWait(options, owner) {
  if (typeof options.onWait === "function") {
    options.onWait(lockWaitMessage(options.label ?? "lock", owner));
  }
}

function memoryLockState(lockAdapter, key) {
  const existing = lockAdapter.get(key);
  if (existing?.kind === "platform-rw-lock") {
    return existing;
  }
  const state = {
    kind: "platform-rw-lock",
    queue: [],
    readers: new Map(),
    writer: null,
  };
  lockAdapter.set(key, state);
  return state;
}

function waitingMemoryOwner(state, request) {
  if (state.writer !== null) {
    return state.writer.owner;
  }
  const reader = state.readers.values().next().value;
  if (reader) {
    return reader.owner;
  }
  return state.queue.find((queued) => queued !== request)?.owner ?? null;
}

function drainMemoryLock(lockAdapter, key, state) {
  if (state.writer !== null || state.queue.length === 0) {
    return;
  }
  const first = state.queue[0];
  if (first.mode === "exclusive") {
    if (state.readers.size !== 0) {
      return;
    }
    state.queue.shift();
    state.writer = first;
    first.grant();
    return;
  }
  while (state.queue[0]?.mode === "shared") {
    const reader = state.queue.shift();
    state.readers.set(reader.owner.id, reader);
    reader.grant();
  }
  if (
    state.writer === null &&
    state.readers.size === 0 &&
    state.queue.length === 0 &&
    lockAdapter.get(key) === state
  ) {
    lockAdapter.delete(key);
  }
}

export async function waitForMemoryLock(key, lockAdapter, options) {
  const mode = lockMode(options);
  const owner = createLockOwner(options, mode);
  const state = memoryLockState(lockAdapter, key);
  return new Promise((resolve, reject) => {
    let granted = false;
    let released = false;
    const request = {
      grant() {
        granted = true;
        options.signal?.removeEventListener("abort", abort);
        resolve(async () => {
          if (released) {
            return;
          }
          released = true;
          if (mode === "exclusive" && state.writer === request) {
            state.writer = null;
          } else {
            state.readers.delete(owner.id);
          }
          drainMemoryLock(lockAdapter, key, state);
          if (
            state.writer === null &&
            state.readers.size === 0 &&
            state.queue.length === 0 &&
            lockAdapter.get(key) === state
          ) {
            lockAdapter.delete(key);
          }
        });
      },
      mode,
      owner,
    };
    const abort = () => {
      if (granted) {
        return;
      }
      const index = state.queue.indexOf(request);
      if (index !== -1) {
        state.queue.splice(index, 1);
      }
      drainMemoryLock(lockAdapter, key, state);
      if (
        state.writer === null &&
        state.readers.size === 0 &&
        state.queue.length === 0 &&
        lockAdapter.get(key) === state
      ) {
        lockAdapter.delete(key);
      }
      reject(options.signal?.reason ?? new Error("operation aborted while waiting for lock"));
    };
    if (options.signal?.aborted) {
      abort();
      return;
    }
    options.signal?.addEventListener("abort", abort, { once: true });
    state.queue.push(request);
    drainMemoryLock(lockAdapter, key, state);
    if (!granted) {
      reportLockWait(options, waitingMemoryOwner(state, request));
    }
  });
}
