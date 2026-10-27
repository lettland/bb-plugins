import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  body: (host: ReturnType<typeof createFakePluginHost>, metadata: Record<string, unknown>, review: Awaited<ReturnType<typeof createReviewContext>>, dropTimeline: () => void, setChildren: (next: unknown[]) => void) => Promise<void>,
) {
  const metadata: Record<string, unknown> = {};
  let timelineDown = false;
  let children: unknown[] = [];
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
      list: async () => children,
    },
  } as unknown as CreateFakePluginHostOptions["sdk"];
  const host = createFakePluginHost({ pluginId: "auto-review", sdk, agentSkillIds: ["auto-review"] });
  try {
    const review = await createReviewContext(host.bb);
    review.globals.reviewMode = "devkit";
    registerPlanTools(review);
    await body(host, metadata, review, () => {
      timelineDown = true;
    }, (next) => {
      children = next;
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

describe("PresentPlan's light tier", () => {
  const lines = (count: number) => Array.from({ length: count }, (_, index) => `line ${index}`).join("\n");
  /** A reviewer child that already finished, created after any arm in these tests. */
  const child = (id: string) => ({
    id,
    title: "review: security",
    createdAt: Date.now(),
    parentThreadId: THREAD_ID,
    originPluginId: null,
    status: "idle",
    archivedAt: 1,
    deletedAt: null,
  });
  const lastFire = (host: ReturnType<typeof createFakePluginHost>) =>
    host.bb.storage.kv.get(`lastfire:${CTX.projectId}:${THREAD_ID}`) as Promise<Record<string, unknown> | null>;

  it("arms with the tier from the plan file, and a null plan is never light", async () => {
    const dir = await mkdtemp(join(tmpdir(), "auto-review-plan-"));
    try {
      const short = join(dir, "short.md");
      await writeFile(short, lines(40));
      await withHost(async (host, metadata) => {
        await host.harness.callAgentTool("PresentPlan", { planFilePath: short }, CTX);
        expect(metadata.presentPlanLight).toBe(true);
      });
      const long = join(dir, "long.md");
      await writeFile(long, lines(41));
      await withHost(async (host, metadata) => {
        await host.harness.callAgentTool("PresentPlan", { planFilePath: long }, CTX);
        expect(metadata.presentPlanLight).toBe(false);
      });
      await withHost(async (host, metadata) => {
        // PLAN does not exist, so `readPlanFile` returns null: standard tier.
        await host.harness.callAgentTool("PresentPlan", { planFilePath: PLAN }, CTX);
        expect(metadata.presentPlanLight).toBe(false);
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("keeps the armed tier across a redo, and records the tally at the release fire point", async () => {
    const dir = await mkdtemp(join(tmpdir(), "auto-review-plan-"));
    try {
      const short = join(dir, "short.md");
      await writeFile(short, lines(40));
      await withHost(async (host, metadata, _review, _dropTimeline, setChildren) => {
        await host.harness.callAgentTool("PresentPlan", { planFilePath: short }, CTX);
        expect(metadata.presentPlanLight).toBe(true);
        // Armed light and still light, the redo's recompute keeps two lenses.
        const redo = await host.harness.callAgentTool("PresentPlan", { planFilePath: short }, CTX);
        expect(redo).toBe(presentPlanRedoMessage("devkit", true));
        expect(metadata.presentPlanLight).toBe(true);
        setChildren([child("r0"), child("r1"), child("r2"), child("r3")]);
        const released = await host.harness.callAgentTool("PresentPlan", { planFilePath: short }, CTX);
        expect(released).toContain("released without a complete calibrated review");
        expect(await lastFire(host)).toMatchObject({
          outcome: "stood-down",
          reason: "plan-review-incomplete",
          planReviewTier: "light",
          planReviewerCount: 4,
        });
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("never sizes a redo lighter than its arm: a shrunk standard plan keeps no light block", async () => {
    const dir = await mkdtemp(join(tmpdir(), "auto-review-plan-"));
    try {
      const plan = join(dir, "plan.md");
      await writeFile(plan, lines(41));
      await withHost(async (host, metadata) => {
        await host.harness.callAgentTool("PresentPlan", { planFilePath: plan }, CTX);
        expect(metadata.presentPlanLight).toBe(false);
        await writeFile(plan, lines(20));
        // The redo re-reads the file, but an armed standard stays standard.
        const redo = await host.harness.callAgentTool("PresentPlan", { planFilePath: plan }, CTX);
        expect(redo).toBe(presentPlanRedoMessage("devkit"));
        expect(metadata.presentPlanLight).toBe(false);
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("warns past the light budget at release: four children over the budget of three", async () => {
    const dir = await mkdtemp(join(tmpdir(), "auto-review-plan-"));
    try {
      const short = join(dir, "short.md");
      await writeFile(short, lines(40));
      await withHost(async (host, metadata, _review, _dropTimeline, setChildren) => {
        // Skip the redo by arming with the flag already set, so the second call releases.
        Object.assign(metadata, {
          presentPlanArmedAt: Date.now(),
          presentPlanArmedPath: short,
          presentPlanArmedSeq: 77,
          presentPlanLight: true,
          presentPlanRedone: true,
        });
        setChildren([child("r0"), child("r1"), child("r2"), child("r3")]);
        await host.harness.callAgentTool("PresentPlan", { planFilePath: short }, CTX);
        expect(await lastFire(host)).toMatchObject({
          outcome: "stood-down",
          reason: "plan-review-incomplete",
          planReviewTier: "light",
          planReviewerCount: 4,
        });
        expect(metadata.presentPlanLight).toBeUndefined();
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("does not count plugin-origin helpers past the threshold", async () => {
    const dir = await mkdtemp(join(tmpdir(), "auto-review-plan-"));
    try {
      const short = join(dir, "short.md");
      await writeFile(short, lines(40));
      await withHost(async (host, metadata, _review, _dropTimeline, setChildren) => {
        // Skip the redo by arming with the flag already set, so the second call releases.
        Object.assign(metadata, {
          presentPlanArmedAt: Date.now(),
          presentPlanArmedPath: short,
          presentPlanArmedSeq: 77,
          presentPlanLight: true,
          presentPlanRedone: true,
        });
        setChildren(
          Array.from({ length: 8 }, (_, index) => ({
            ...child(`h${index}`),
            originPluginId: "advisor",
          })),
        );
        await host.harness.callAgentTool("PresentPlan", { planFilePath: short }, CTX);
        expect(await lastFire(host)).toMatchObject({
          reason: "plan-review-incomplete",
          planReviewTier: "light",
          planReviewerCount: 0,
        });
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
