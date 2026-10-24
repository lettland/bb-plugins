import { describe, expect, it } from "vitest";
import {
  createFakePluginHost,
  type CreateFakePluginHostOptions,
} from "@get-bb/plugin-sdk/testing";
import { createReviewContext } from "./context.js";
import { registerPlanTools } from "./present-plan.js";
import { presentPlanRedoMessage, PRESENT_PLAN_REVIEWED_MESSAGE } from "./prompt.js";

const THREAD_ID = "thr_1";
const CTX = { threadId: THREAD_ID, projectId: "project-1" };
const PLAN = "/w/docs/plans/p.md";

async function withHost(
  body: (host: ReturnType<typeof createFakePluginHost>, metadata: Record<string, unknown>, review: Awaited<ReturnType<typeof createReviewContext>>, dropTimeline: () => void) => Promise<void>,
) {
  const metadata: Record<string, unknown> = {};
  let timelineDown = false;
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
        if (timelineDown) {
          throw new Error("timeline down");
        }
        return { rows: [], maxSeq: 77 };
      },
      events: { list: async () => [] },
      queuedMessages: { list: async () => [] },
    },
  } as unknown as CreateFakePluginHostOptions["sdk"];
  const host = createFakePluginHost({ pluginId: "auto-review", sdk, agentSkillIds: ["auto-review"] });
  try {
    const review = await createReviewContext(host.bb);
    review.globals.reviewMode = "devkit";
    registerPlanTools(review);
    await body(host, metadata, review, () => {
      timelineDown = true;
    });
  } finally {
    await host.harness.dispose();
  }
}

describe("PresentPlan without a readable cursor", () => {
  it("arms a plan with the time and path but no cursor, and clears a stale redo flag", async () => {
    await withHost(async (host, metadata, _review, dropTimeline) => {
      Object.assign(metadata, { presentPlanRedone: true, presentPlanArmedSeq: 5 });
      dropTimeline();
      const result = await host.harness.callAgentTool("PresentPlan", { planFilePath: PLAN }, CTX);
      expect(typeof result).toBe("string");
      expect(typeof metadata.presentPlanArmedAt).toBe("number");
      expect(metadata.presentPlanArmedPath).toBe(PLAN);
      expect(metadata.presentPlanArmedSeq).toBeUndefined();
      expect(metadata.presentPlanRedone).toBeUndefined();
    });
  });

  it("a second armed call without a cursor is redone once, staying armed with no cursor", async () => {
    await withHost(async (host, metadata, _review, dropTimeline) => {
      await host.harness.callAgentTool("PresentPlan", { planFilePath: PLAN }, CTX);
      expect(metadata.presentPlanArmedSeq).toBe(77);
      dropTimeline();
      const result = await host.harness.callAgentTool("PresentPlan", { planFilePath: PLAN }, CTX);
      expect(result).toBe(presentPlanRedoMessage("devkit"));
      expect(metadata.presentPlanRedone).toBe(true);
      expect(metadata.presentPlanArmedSeq).toBeUndefined();
      expect(typeof metadata.presentPlanArmedAt).toBe("number");
    });
  });

  it("a third call releases the redo instead of looping, and stands the review down", async () => {
    await withHost(async (host, metadata, _review, dropTimeline) => {
      await host.harness.callAgentTool("PresentPlan", { planFilePath: PLAN }, CTX);
      dropTimeline();
      await host.harness.callAgentTool("PresentPlan", { planFilePath: PLAN }, CTX);
      const result = await host.harness.callAgentTool("PresentPlan", { planFilePath: PLAN }, CTX);
      expect(result).toBe(PRESENT_PLAN_REVIEWED_MESSAGE);
      expect(metadata.presentPlanArmedSeq).toBeUndefined();
      expect(metadata.presentPlanArmedPath).toBeUndefined();
      expect(metadata.presentPlanRedone).toBeUndefined();
    });
  });
});
