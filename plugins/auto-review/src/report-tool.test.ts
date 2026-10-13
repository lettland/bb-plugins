import { describe, expect, it } from "vitest";
import {
  createFakePluginHost,
  makePluginAgentConfigurationContext,
  type CreateFakePluginHostOptions,
} from "@get-bb/plugin-sdk/testing";
import { createReviewContext, type ReviewContext } from "./context.js";
import { readFindings } from "./findings-store.js";
import { registerPlanTools } from "./present-plan.js";
import { REPORT_REVIEW_TOOL_NAME, reportReview } from "./report-tool.js";

const THREAD_ID = "thr_1";
const CTX = { threadId: THREAD_ID, projectId: "project-1" };

interface Options {
  queuedRows?: Array<{ id: string }>;
  timelineThrows?: boolean;
}

async function withHost(
  options: Options,
  body: (host: ReturnType<typeof createFakePluginHost>, metadata: Record<string, unknown>) => Promise<void>,
) {
  const metadata: Record<string, unknown> = {};
  const sdk = {
    threads: {
      getPluginMetadata: async () => ({ ...metadata }),
      updatePluginMetadata: async (args: { set?: Record<string, unknown>; remove?: string[] }) => {
        Object.assign(metadata, args.set ?? {});
        for (const key of args.remove ?? []) {
          delete metadata[key];
        }
        return { ...metadata };
      },
      timeline: async () => {
        if (options.timelineThrows === true) {
          throw new Error("timeline down");
        }
        return { rows: [], maxSeq: 77 };
      },
      queuedMessages: { list: async () => options.queuedRows ?? [] },
    },
  } as unknown as CreateFakePluginHostOptions["sdk"];
  const host = createFakePluginHost({ pluginId: "auto-review", sdk, agentSkillIds: ["auto-review"] });
  try {
    registerPlanTools(await createReviewContext(host.bb));
    await body(host, metadata);
  } finally {
    await host.harness.dispose();
  }
}

const finding = (overrides: Record<string, unknown> = {}) => ({
  key: "null-deref",
  title: "Null dereference",
  file: "src/a.ts",
  line: 3,
  severity: "high",
  status: "open",
  ...overrides,
});

const call = (host: ReturnType<typeof createFakePluginHost>, input: unknown) =>
  host.harness.callAgentTool(REPORT_REVIEW_TOOL_NAME, input, CTX);

const REPORT = { outcome: "committed", summary: "done", findings: [finding()] };

function isRejected(result: Awaited<ReturnType<typeof call>>): boolean {
  return typeof result !== "string" && result.isError === true;
}

describe("ReportReview", () => {
  it("is rejected while the thread is idle, and records nothing", async () => {
    await withHost({}, async (host) => {
      expect(isRejected(await call(host, REPORT))).toBe(true);
      expect(await host.bb.storage.kv.list("findings:")).toEqual([]);
    });
  });

  it("is rejected while the review is still queued", async () => {
    await withHost({ queuedRows: [{ id: "qm-1" }] }, async (host, metadata) => {
      Object.assign(metadata, { phase: "pending-dispatch", pendingEntryId: "qm-1", dispatchedAt: 1 });
      expect(isRejected(await call(host, REPORT))).toBe(true);
      expect(metadata.phase).toBe("pending-dispatch");
      expect(await host.bb.storage.kv.list("findings:")).toEqual([]);
    });
  });

  it("is rejected in awaiting-review before the prompt was delivered (a thread latched before the upgrade)", async () => {
    await withHost({}, async (host, metadata) => {
      Object.assign(metadata, { phase: "awaiting-review", dispatchedAt: 1 });
      expect(isRejected(await call(host, REPORT))).toBe(true);
      expect(await host.bb.storage.kv.list("findings:")).toEqual([]);
    });
  });

  it("accepts a report against a delivered review and acknowledges it with counts", async () => {
    await withHost({}, async (host, metadata) => {
      Object.assign(metadata, { phase: "awaiting-review", dispatchedAt: 1, reviewDeliveredAt: 500 });
      const result = await call(host, {
        ...REPORT,
        findings: [finding(), finding({ key: "b", status: "fixed" })],
      });
      expect(typeof result).toBe("string");
      expect(result).toContain("committed (1 open, 1 fixed, 0 false positive)");
      const store = await readFindings(host.bb, THREAD_ID);
      expect(store.lastReport).toMatchObject({ reviewId: 500, outcome: "committed" });
      expect(Object.keys(store.chains).sort()).toEqual(["b", "null-deref"]);
      expect(host.harness.realtimeSignals.map((signal) => signal.channel)).toContain(
        "auto-review:thread:thr_1",
      );
    });
  });

  it("lets the last report of a review replace the earlier one", async () => {
    await withHost({}, async (host, metadata) => {
      Object.assign(metadata, { phase: "awaiting-review", reviewDeliveredAt: 500 });
      await call(host, { ...REPORT, findings: [finding({ key: "a" }), finding({ key: "b" })] });
      await call(host, { outcome: "merged", summary: "again", findings: [finding({ key: "a" })] });
      const store = await readFindings(host.bb, THREAD_ID);
      expect(Object.keys(store.chains)).toEqual(["a"]);
      expect(store.chains.a?.raisedCount).toBe(1);
      expect(store.lastReport).toMatchObject({ outcome: "merged", summary: "again" });
    });
  });

  it("names a repeated dismissal it left unchanged in the acknowledgement", async () => {
    await withHost({}, async (host, metadata) => {
      const fp = finding({ status: "false-positive", reason: "guarded upstream" });
      Object.assign(metadata, { phase: "awaiting-review", reviewDeliveredAt: 500 });
      await call(host, { ...REPORT, findings: [fp] });
      Object.assign(metadata, { phase: "awaiting-review", reviewDeliveredAt: 900 });
      const result = await call(host, { ...REPORT, findings: [fp] });
      expect(result).toContain("Ignored, unchanged: null-deref");
      expect((await readFindings(host.bb, THREAD_ID)).chains["null-deref"]?.dismissCount).toBe(1);
    });
  });

  it("promotes a queued review whose row is gone (a missed message.dispatched) and accepts", async () => {
    await withHost({ queuedRows: [] }, async (host, metadata) => {
      Object.assign(metadata, { phase: "pending-dispatch", pendingEntryId: "qm-1", dispatchedAt: 1 });
      const result = await call(host, REPORT);
      expect(typeof result).toBe("string");
      expect(metadata.phase).toBe("awaiting-review");
      expect(metadata.pendingEntryId).toBeUndefined();
      expect(typeof metadata.reviewDeliveredAt).toBe("number");
      expect(metadata.reviewDeliveredSeq).toBe(77);
      expect((await readFindings(host.bb, THREAD_ID)).lastReport?.reviewId).toBe(metadata.reviewDeliveredAt);
    });
  });

  it("promotes without a cursor when the timeline cannot be read", async () => {
    await withHost({ timelineThrows: true }, async (host, metadata) => {
      Object.assign(metadata, { phase: "pending-dispatch", pendingEntryId: "qm-1" });
      expect(isRejected(await call(host, REPORT))).toBe(false);
      expect(metadata.reviewDeliveredSeq).toBeUndefined();
      expect(typeof metadata.reviewDeliveredAt).toBe("number");
    });
  });

  it("validates its input like any tool: control characters stripped, bad input refused", async () => {
    await withHost({}, async (host, metadata) => {
      Object.assign(metadata, { phase: "awaiting-review", reviewDeliveredAt: 500 });
      await call(host, {
        outcome: "blocked",
        summary: "stop\nhere​",
        findings: [finding({ title: "evil‮title\n", reason: "r\u0000" })],
      });
      const store = await readFindings(host.bb, THREAD_ID);
      expect(store.lastReport?.summary).toBe("stophere");
      expect(store.chains["null-deref"]).toMatchObject({ title: "eviltitle", reason: "r" });
      await expect(call(host, { outcome: "not-reported", summary: "x" })).rejects.toThrow();
      await expect(call(host, { ...REPORT, findings: [finding({ file: "a b" })] })).rejects.toThrow();
    });
  });

  it("can be called directly with a parsed report", async () => {
    await withHost({}, async (host, metadata) => {
      Object.assign(metadata, { phase: "awaiting-review", reviewDeliveredAt: 500 });
      const review = { bb: host.bb } as ReviewContext;
      const result = await reportReview(
        review,
        { outcome: "no-changes", summary: "nothing", findings: [] },
        { ...CTX, signal: new AbortController().signal },
      );
      expect(typeof result).toBe("string");
      expect((await readFindings(host.bb, THREAD_ID)).lastReport).toMatchObject({ outcome: "no-changes" });
    });
  });

  it("is registered with a description that limits when to call it", async () => {
    await withHost({}, async (host) => {
      const configured = await host.harness.resolveAgentConfiguration(
        makePluginAgentConfigurationContext({
          thread: { id: THREAD_ID, parentThreadId: null },
          origin: { kind: null, pluginId: null },
          provider: { id: "claude-code" },
        }),
      );
      const tool = configured.tools.find((entry) => entry.name === REPORT_REVIEW_TOOL_NAME);
      expect(tool?.description).toContain("Only call this when an [bb auto-review] prompt asks you to");
      expect(tool?.description).toContain("never by value");
    });
  });
});
