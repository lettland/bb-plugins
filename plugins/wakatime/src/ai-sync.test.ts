import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSyncScheduler, SYNC_WINDOW_MS } from "./ai-sync.js";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("createSyncScheduler", () => {
  it("keeps scheduling after a run rejects", async () => {
    const run = vi.fn<() => Promise<void>>().mockRejectedValueOnce(new Error("settings down")).mockResolvedValue(undefined);
    const scheduler = createSyncScheduler(run);
    scheduler.request();
    await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(SYNC_WINDOW_MS);
    scheduler.request();
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("runs no queued follow-up after dispose", async () => {
    let finish!: () => void;
    const run = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)));
    const scheduler = createSyncScheduler(run);
    scheduler.request();
    await vi.advanceTimersByTimeAsync(SYNC_WINDOW_MS);
    scheduler.request();
    await vi.advanceTimersByTimeAsync(SYNC_WINDOW_MS);
    scheduler.dispose();
    finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledTimes(1);
  });
});
