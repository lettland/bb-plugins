import { describe, expect, it } from "vitest";
import { createFakePluginHost, type CreateFakePluginHostOptions } from "@get-bb/plugin-sdk/testing";
import { showFindings } from "./cli-findings.js";
import { emptyStore, findingsKey, type FindingsStore } from "./findings.js";

const store: FindingsStore = {
  ...emptyStore(),
  chains: {
    a: {
      key: "a",
      title: "A",
      file: "src/a.ts",
      line: 2,
      severity: "blocker",
      status: "false-positive",
      reason: "r",
      firstSeenAt: 1,
      lastSeenAt: 1,
      raisedCount: 3,
      dismissCount: 2,
      reRaised: false,
      lastReviewId: 1,
    },
  },
};

async function withHost(body: (host: ReturnType<typeof createFakePluginHost>) => Promise<void>) {
  const sdk = {
    threads: {
      get: async ({ threadId }: { threadId: string }) => {
        if (threadId === "ghost") {
          throw new Error("thread not found");
        }
        return { id: threadId };
      },
    },
  } as unknown as CreateFakePluginHostOptions["sdk"];
  const host = createFakePluginHost({ pluginId: "auto-review", sdk });
  try {
    await body(host);
  } finally {
    await host.harness.dispose();
  }
}

describe("showFindings", () => {
  it("flags a blocker dismissed more than once", async () => {
    await withHost(async (host) => {
      await host.bb.storage.kv.set(findingsKey("thr_1"), store);
      const result = await showFindings(host.bb, {}, { threadId: "thr_1", clear: false, wantsJson: false });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("dismissed 2x — worth a second look");
      expect(result.stdout).toContain("src/a.ts:2");
    });
  });

  it("refuses --clear in a thread, and without an id, as JSON errors on request", async () => {
    await withHost(async (host) => {
      const inThread = await showFindings(host.bb, { threadId: "thr_1" }, { threadId: "thr_1", clear: true, wantsJson: true });
      expect(inThread.exitCode).toBe(2);
      expect(JSON.parse(inThread.stdout ?? "")).toMatchObject({ ok: false, command: "findings" });
      const noId = await showFindings(host.bb, {}, { threadId: undefined, clear: true, wantsJson: false });
      expect(noId.exitCode).toBe(2);
    });
  });

  it("reports an unknown thread", async () => {
    await withHost(async (host) => {
      const result = await showFindings(host.bb, {}, { threadId: "ghost", clear: false, wantsJson: false });
      expect(result).toEqual({ exitCode: 1, stderr: "Thread ghost not found or unavailable.\n" });
    });
  });
});
