import { describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { emptyStore, type FindingsStore } from "./findings-schema.js";
import {
  findingsKey,
  isThreadNotFound,
  readFindings,
  recordUnreported,
  writeFindings,
} from "./findings-store.js";

const T0 = 1_000_000;

/** A store with one open chain and a committed last report. */
function seeded(): FindingsStore {
  return {
    chains: {
      "null-deref": {
        key: "null-deref",
        title: "Null dereference",
        file: "src/a.ts",
        line: 10,
        severity: "medium",
        status: "open",
        firstSeenAt: T0,
        lastSeenAt: T0,
        raisedCount: 1,
        dismissCount: 0,
        reRaised: false,
        lastReviewId: 1,
      },
    },
    lastReport: {
      reviewId: 1,
      at: T0,
      outcome: "merged",
      summary: "done",
      counts: { open: 1, fixed: 0, falsePositive: 0 },
    },
    incidents: [],
  };
}

describe("isThreadNotFound", () => {
  it("is true only for a structured thread_not_found code or 404", () => {
    expect(isThreadNotFound(Object.assign(new Error("thread thr_1 not found"), { code: "thread_not_found" }))).toBe(true);
    expect(isThreadNotFound({ code: "thread_not_found" })).toBe(true);
    expect(isThreadNotFound({ status: 404 })).toBe(true);
  });

  it("keeps the findings on any other failure, however it is worded", () => {
    expect(isThreadNotFound(new Error("method not found: threads.get"))).toBe(false);
    expect(isThreadNotFound(new Error("not found: git"))).toBe(false);
    expect(isThreadNotFound(Object.assign(new Error("not found: git"), { code: "ENOENT" }))).toBe(false);
    expect(isThreadNotFound(new Error("thread thr_1 not found"))).toBe(false);
    expect(isThreadNotFound({ code: "not_found" })).toBe(false);
    expect(isThreadNotFound({ code: "thread_not_found_yet" })).toBe(false);
    expect(isThreadNotFound({ status: 500 })).toBe(false);
    expect(isThreadNotFound(new Error("connection reset"))).toBe(false);
    expect(isThreadNotFound(null)).toBe(false);
    expect(isThreadNotFound("not found")).toBe(false);
  });
});

describe("findings store", () => {
  async function withHost(body: (host: ReturnType<typeof createFakePluginHost>) => Promise<void>) {
    const host = createFakePluginHost({ pluginId: "auto-review" });
    try {
      await body(host);
    } finally {
      await host.harness.dispose();
    }
  }

  it("reads an empty store when none exists", async () => {
    await withHost(async (host) => {
      expect(await readFindings(host.bb, "thr_1")).toEqual(emptyStore());
    });
  });

  it("round-trips, and publishes to the thread's channel on every write", async () => {
    await withHost(async (host) => {
      const store = seeded();
      await writeFindings(host.bb, "thr_1", store);
      expect(await readFindings(host.bb, "thr_1")).toEqual(store);
      expect(host.harness.realtimeSignals.map((signal) => signal.channel)).toEqual([
        "auto-review:thread:thr_1",
      ]);
    });
  });

  it("resets an unparseable store with a warning", async () => {
    await withHost(async (host) => {
      await host.bb.storage.kv.set(findingsKey("thr_1"), { chains: "nope" });
      expect(await readFindings(host.bb, "thr_1")).toEqual(emptyStore());
      expect(host.harness.logEntries.some((entry) => entry.level === "warn")).toBe(true);
    });
  });

  it("does not overwrite a report already recorded for the same review", async () => {
    await withHost(async (host) => {
      await writeFindings(host.bb, "thr_1", seeded());
      await recordUnreported(host.bb, "thr_1", { reviewId: 1, outcome: "not-reported", summary: "s" });
      expect((await readFindings(host.bb, "thr_1")).lastReport?.outcome).toBe("merged");
      await recordUnreported(host.bb, "thr_1", { reviewId: 2, outcome: "stopped", summary: "s" });
      const after = await readFindings(host.bb, "thr_1");
      expect(after.lastReport).toMatchObject({ reviewId: 2, outcome: "stopped" });
      expect(Object.keys(after.chains)).toEqual(["null-deref"]);
    });
  });
});
