// @vitest-environment jsdom
import type { ExperimentalTabRegistration } from "@get-bb/plugin-sdk";
import { cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { labelsByProject } from "../test-fixtures.js";

const app = await loadPluginApp(() => import("../app"));
const PROJECT_ID = "01HZZZZZZZZZZZZZZZZZZZZZP1";
const navigationView = app.tabs.find(
  (
    tab,
  ): tab is Extract<
    ExperimentalTabRegistration,
    { context: { kind: "nav-panel" }; availability: "fixed" }
  > =>
    tab.context.kind === "nav-panel" &&
    tab.availability === "fixed" &&
    tab.id === "navigation",
)!;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("tasks icon names", () => {
  it("renders the Recently closed entries with registered artwork", async () => {
    const tasksRegistration = app.navPanels[0]!;
    const slot = renderSlot(
      { ...tasksRegistration, component: navigationView.component },
      { subPath: "all" },
      {
        rpc: {
          listProjects: () => ({ projects: [] }),
          listFolders: () => ({ folders: [] }),
          sidebarSummary: () => ({ projects: [] }),
          sidebarOpenTaskCount: () => ({ openTaskCount: 0 }),
          listAllTasks: () => ({ tasks: [] }),
        },
      },
    );

    const row = await slot.findByText("Recently closed");
    const icon = row.parentElement?.querySelector("[data-icon]");
    expect(icon?.getAttribute("data-icon")).toBe("TimeSchedule");
  });

  it("renders the Recently closed empty state with registered artwork", async () => {
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: `recent/${PROJECT_ID}` },
      {
        rpc: {
          listProjects: () => ({
            projects: [
              {
                id: PROJECT_ID,
                name: "Operating",
                prefix: "OPS",
                nextTaskNumber: 1,
                color: "blue",
                folderId: null,
                linkedBbProjectId: null,
                createdAt: "2026-09-14T00:00:00.000Z",
              },
            ],
          }),
          listAllTasks: () => ({ tasks: [] }),
          listTaskCardMeta: () => ({ cards: [] }),
          labelsByProject: labelsByProject([]),
        },
      },
    );

    await slot.findByText("No recently closed tasks");
    expect(
      slot.container.querySelector("[data-icon=TimeSchedule]"),
    ).not.toBeNull();
    expect(slot.container.querySelector("[data-icon=Zap]")).toBeNull();
  });
});
