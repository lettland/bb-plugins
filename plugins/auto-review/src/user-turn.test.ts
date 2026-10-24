import { describe, expect, it, vi } from "vitest";
import type { ReviewContext } from "./context.js";
import { userTurnQueued, userTurnRunning } from "./user-turn.js";

const lookups = vi.hoisted(() => ({
  userTurnRunningSince: vi.fn(),
}));
vi.mock("./detect.js", async (original) => ({
  ...(await original<typeof import("./detect.js")>()),
  ...lookups,
}));

function context(status: string, rows: readonly Record<string, unknown>[]) {
  const warnings: string[] = [];
  const ctx = {
    bb: {
      sdk: {
        threads: {
          get: async () => ({ status }),
          queuedMessages: { list: async () => rows },
        },
      },
      log: { warn: (message: string) => warnings.push(message) },
    },
  } as unknown as ReviewContext;
  return { ctx, warnings };
}

const row = (over: Record<string, unknown> = {}) => ({
  id: "qm_1",
  initiator: "user",
  origin: "user",
  failureReason: null,
  sendAt: null,
  ...over,
});

describe("userTurnQueued", () => {
  it("a busy thread counts as queued without the user asking", async () => {
    const { ctx } = context("active", []);
    expect(await userTurnQueued(ctx, "thr")).toEqual({ busy: true, queued: true, userQueued: false });
  });

  it("a due user row counts as the user's queue", async () => {
    const { ctx } = context("idle", [row()]);
    expect(await userTurnQueued(ctx, "thr")).toEqual({ busy: false, queued: true, userQueued: true });
  });

  it("a row scheduled for later is not queued yet", async () => {
    const { ctx } = context("idle", [row({ sendAt: Date.now() + 60_000 })]);
    expect(await userTurnQueued(ctx, "thr")).toEqual({ busy: false, queued: false, userQueued: false });
  });

  it("a failed row, a plugin row and a plugin-origin row do not count", async () => {
    const failed = context("idle", [row({ failureReason: "gone" })]);
    expect(await userTurnQueued(failed.ctx, "thr").then((r) => r.userQueued)).toBe(false);
    const plugin = context("idle", [row({ initiator: "plugin" })]);
    expect(await userTurnQueued(plugin.ctx, "thr").then((r) => r.userQueued)).toBe(false);
    const origin = context("idle", [row({ origin: "plugin" })]);
    expect(await userTurnQueued(origin.ctx, "thr").then((r) => r.userQueued)).toBe(false);
  });
});

describe("userTurnRunning", () => {
  it("is true only when a user turn is running after the cursor", async () => {
    const none = context("idle", []);
    lookups.userTurnRunningSince.mockResolvedValueOnce(null);
    expect(await userTurnRunning(none.ctx, "thr", 5)).toBe(false);
    const running = context("idle", []);
    lookups.userTurnRunningSince.mockResolvedValueOnce(9);
    expect(await userTurnRunning(running.ctx, "thr", 5)).toBe(true);
  });

  it("a failed read carries the review, whatever the error", async () => {
    const error = context("idle", []);
    lookups.userTurnRunningSince.mockRejectedValueOnce(new Error("read failed"));
    expect(await userTurnRunning(error.ctx, "thr", 5)).toBe(true);
    expect(error.warnings[0]).toContain("read failed");
    const notAnError = context("idle", []);
    lookups.userTurnRunningSince.mockRejectedValueOnce("kaboom");
    expect(await userTurnRunning(notAnError.ctx, "thr", 5)).toBe(true);
    expect(notAnError.warnings[0]).toContain("kaboom");
  });
});
