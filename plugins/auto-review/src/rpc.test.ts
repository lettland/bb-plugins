import { describe, expect, it } from "vitest";
import { createFakePluginHost, type CreateFakePluginHostOptions } from "@get-bb/plugin-sdk/testing";
import { registerAutoReviewCli } from "./cli.js";
import { createReviewContext } from "./context.js";
import { registerAutoReviewRpc } from "./rpc.js";

const PROJECTS = [
  { id: "p-b", name: "Beta" },
  { id: "p-c", name: "alpha" },
  { id: "p-a", name: "Beta" },
];

async function withHost(body: (host: ReturnType<typeof createFakePluginHost>) => Promise<void>) {
  const sdk = {
    projects: { list: async () => PROJECTS },
  } as unknown as CreateFakePluginHostOptions["sdk"];
  const host = createFakePluginHost({ pluginId: "auto-review", sdk });
  try {
    const ctx = await createReviewContext(host.bb);
    registerAutoReviewRpc(ctx);
    registerAutoReviewCli(host.bb, ctx.settings, () => ctx.globals);
    await body(host);
  } finally {
    await host.harness.dispose();
  }
}

describe("auto-review rpc: listProjectSettings", () => {
  it("reports defaults, stored overrides and reviewActive, sorted by name then id", async () => {
    await withHost(async (host) => {
      await host.bb.storage.kv.set("project:p-b", { autoApprovePlans: true });
      await host.bb.storage.kv.set("project:p-c", { enabled: false });
      expect(await host.harness.callRpc("listProjectSettings", null)).toEqual({
        projects: [
          { id: "p-c", name: "alpha", autoApprovePlans: false, reviewActive: false },
          { id: "p-a", name: "Beta", autoApprovePlans: false, reviewActive: true },
          { id: "p-b", name: "Beta", autoApprovePlans: true, reviewActive: true },
        ],
      });
    });
  });

  it("follows the global kill switch for reviewActive", async () => {
    await withHost(async (host) => {
      await host.harness.setSettings({ enabled: false });
      await host.bb.storage.kv.set("project:p-a", { enabled: true });
      const result = (await host.harness.callRpc("listProjectSettings", null)) as {
        projects: { id: string; reviewActive: boolean }[];
      };
      expect(result.projects.map((p) => [p.id, p.reviewActive])).toEqual([
        ["p-c", false],
        ["p-a", true],
        ["p-b", false],
      ]);
    });
  });
});

describe("auto-review rpc: setAutoApprovePlans", () => {
  it("writes, returns the stored value and preserves other keys", async () => {
    await withHost(async (host) => {
      await host.bb.storage.kv.set("project:p-a", { enabled: false, reviewMode: "self" });
      expect(
        await host.harness.callRpc("setAutoApprovePlans", {
          projectId: "p-a",
          autoApprovePlans: true,
        }),
      ).toEqual({ projectId: "p-a", autoApprovePlans: true });
      expect(await host.bb.storage.kv.get("project:p-a")).toEqual({
        enabled: false,
        reviewMode: "self",
        autoApprovePlans: true,
      });

      expect(
        await host.harness.callRpc("setAutoApprovePlans", {
          projectId: "p-a",
          autoApprovePlans: false,
        }),
      ).toEqual({ projectId: "p-a", autoApprovePlans: false });
    });
  });

  it("rejects an unknown project without writing", async () => {
    await withHost(async (host) => {
      await expect(
        host.harness.callRpc("setAutoApprovePlans", { projectId: "nope", autoApprovePlans: true }),
      ).rejects.toThrow("BB project was not found");
      expect(await host.bb.storage.kv.list("project:")).toEqual([]);
    });
  });

  it("rejects invalid input without writing", async () => {
    await withHost(async (host) => {
      for (const input of [
        { projectId: "", autoApprovePlans: true },
        { projectId: "p-a", autoApprovePlans: "yes" },
        { projectId: "p-a" },
        null,
      ]) {
        await expect(host.harness.callRpc("setAutoApprovePlans", input)).rejects.toThrow();
      }
      expect(await host.bb.storage.kv.list("project:")).toEqual([]);
    });
  });

  it("is visible to `bb auto-review show --project <id> --json`", async () => {
    await withHost(async (host) => {
      await host.harness.callRpc("setAutoApprovePlans", { projectId: "p-a", autoApprovePlans: true });
      const shown = await host.harness.runCli(["show", "--project", "p-a", "--json"], {});
      expect(JSON.parse(shown.stdout ?? "")).toMatchObject({
        projectOverride: { autoApprovePlans: true },
        effective: { autoApprovePlans: true },
      });
    });
  });
});

describe("auto-review rpc: logging", () => {
  it("logs the flip from both the GUI and the CLI", async () => {
    await withHost(async (host) => {
      await host.harness.callRpc("setAutoApprovePlans", { projectId: "p-a", autoApprovePlans: true });
      await host.harness.runCli(["auto-approve", "off", "--project", "p-a"], {});
      const info = host.harness.logEntries
        .filter((entry) => entry.level === "info")
        .map((entry) => entry.message);
      expect(info).toContain("plan auto-approve for project p-a: false -> true (via rpc)");
      expect(info).toContain("plan auto-approve for project p-a: true -> false (via cli (terminal))");
    });
  });
});
