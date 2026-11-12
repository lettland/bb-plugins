// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { createElement } from "react";
import { installTestPluginRuntime, loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { PluginRpcTestHandlers, RenderSlotOptions } from "@get-bb/plugin-sdk/testing/app";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type {
  PluginPendingInteractionProps,
  PluginPendingInteractionRegistration,
  PluginSettingsSectionRegistration,
  PluginThreadHeaderActionProps,
  PluginThreadHeaderActionRegistration,
} from "@get-bb/plugin-sdk";
import type { AutoReviewRpcContract, ProjectSetting, ThreadReview } from "./src/rpc-contract.js";

// The test rpc harness wraps every handler throw in a PluginRpcCallError, an
// Error subclass, so a rejection that is not an Error can only reach the app
// by intercepting useRpc itself. Quirk learned under @get-bb/plugin-sdk
// 0.6.79 (dist/testing/app.js).
const rpcStringRejection = vi.hoisted(() => ({ current: null as string | null }));
vi.mock("@get-bb/plugin-sdk/app", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@get-bb/plugin-sdk/app")>();
  return {
    ...actual,
    useRpc: () => {
      if (rpcStringRejection.current === null) return actual.useRpc();
      const message = rpcStringRejection.current;
      return { call: () => Promise.reject(message) };
    },
  };
});

let approveSection: PluginSettingsSectionRegistration;
let badgeSlot: PluginThreadHeaderActionRegistration;
let planFormSlot: PluginPendingInteractionRegistration;

beforeAll(async () => {
  installTestPluginRuntime();
  const app = await loadPluginApp(() => import("./app"));
  approveSection = app.settingsSections.find((section) => section.id === "project-auto-approve")!;
  badgeSlot = app.threadHeaderActions.find((action) => action.id === "review-status")!;
  planFormSlot = app.pendingInteractions.find((form) => form.id === "plan-approval")!;
});

// Vitest globals are off, so Testing Library does not clean up by itself.
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  rpcStringRejection.current = null;
});

function project(overrides: Partial<ProjectSetting> = {}): ProjectSetting {
  return {
    id: "prj_1",
    name: "Project one",
    autoApprovePlans: false,
    reviewOverride: "default",
    reviewActive: true,
    ...overrides,
  };
}

function review(overrides: Partial<ThreadReview> = {}): ThreadReview {
  return {
    status: "committed",
    at: null,
    openCount: 0,
    reRaisedCount: 0,
    omittedFromPrompt: 0,
    lastIncident: null,
    ...overrides,
  };
}

type Handlers = Partial<PluginRpcTestHandlers<AutoReviewRpcContract>>;

function baseHandlers(): PluginRpcTestHandlers<AutoReviewRpcContract> {
  return {
    listProjectSettings: () => ({ projects: [], globalEnabled: true }),
    setAutoApprovePlans: (input) => ({
      projectId: input.projectId,
      autoApprovePlans: input.autoApprovePlans,
    }),
    setProjectReview: (input) => ({
      projectId: input.projectId,
      reviewOverride: input.review,
      reviewActive: input.review !== "off",
    }),
    threadReview: () => review(),
  };
}

function renderSection(handlers: Handlers = {}) {
  const options: RenderSlotOptions<AutoReviewRpcContract> = {
    rpc: { ...baseHandlers(), ...handlers } as PluginRpcTestHandlers<AutoReviewRpcContract>,
  };
  return renderSlot<object, AutoReviewRpcContract>(approveSection, {}, options);
}

function renderBadge(handlers: Handlers = {}, props: Partial<PluginThreadHeaderActionProps> = {}) {
  return renderSlot<PluginThreadHeaderActionProps, AutoReviewRpcContract>(
    badgeSlot,
    { threadId: "thr_1", projectId: "prj_1", isCompactViewport: false, ...props },
    {
      rpc: { ...baseHandlers(), ...handlers } as PluginRpcTestHandlers<AutoReviewRpcContract>,
    },
  );
}

describe("registration", () => {
  it("registers the settings section and the thread header action", () => {
    expect(approveSection.title).toBe("Per-project settings");
    expect(approveSection.description).toBe(
      "Auto-review: Default follows the global Enabled switch; On or Off overrides it for that project. Plan auto-approve: off by default. When on for a project, a plan auto-review has reviewed is approved for you: the agent starts implementing without waiting for your approval.",
    );
    expect(badgeSlot.title).toBe("Auto-review");
  });
});

describe("Per-project settings section", () => {
  it("shows a loading note while the first load is in flight", () => {
    renderSection({ listProjectSettings: () => new Promise(() => {}) });
    expect(screen.getByText("Loading projects…")).toBeTruthy();
  });

  it("lists each project with its switch and the off note", async () => {
    renderSection({
      listProjectSettings: () => ({
        projects: [
          project({ id: "prj_on", name: "Alpha", autoApprovePlans: true }),
          project({ id: "prj_off", name: "Beta", reviewActive: false }),
        ],
        globalEnabled: true,
      }),
    });
    await screen.findByText("Alpha");
    const rows = screen.getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    expect((screen.getByLabelText("Alpha") as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText("Beta") as HTMLInputElement).checked).toBe(false);
    expect(
      within(rows[0]!).queryByText("auto-review is off for this project, so this has no effect"),
    ).toBeNull();
    expect(
      within(rows[1]!).getByText("auto-review is off for this project, so this has no effect"),
    ).toBeTruthy();
    expect(within(rows[1]!).getByText("prj_off")).toBeTruthy();
  });

  it("offers Retry when the first load fails", async () => {
    let calls = 0;
    renderSection({
      listProjectSettings: () => {
        calls++;
        if (calls === 1) throw new Error("boom");
        return { projects: [project()], globalEnabled: true };
      },
    });
    expect((await screen.findByRole("alert")).textContent).toContain(
      "Could not load projects: boom",
    );
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
    expect(screen.queryByText("Project one")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("Project one")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(calls).toBe(2);
  });

  it("reports an empty project list", async () => {
    renderSection();
    expect(await screen.findByText("No projects.")).toBeTruthy();
  });

  it("keeps the last good list under a failed refresh, with Retry", async () => {
    let calls = 0;
    const view = renderSection({
      listProjectSettings: () => {
        calls++;
        if (calls === 2) throw new Error("server unavailable");
        return { projects: [project()], globalEnabled: true };
      },
    });
    expect(await screen.findByText("Project one")).toBeTruthy();
    window.dispatchEvent(new Event("focus"));
    expect((await screen.findByRole("alert")).textContent).toContain(
      "Could not load projects: server unavailable",
    );
    expect(screen.getByText("Project one")).toBeTruthy();
    expect(view.rpcCalls.filter((call) => call.method === "listProjectSettings")).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(screen.getByText("Project one")).toBeTruthy();
  });

  it("hides the empty-state note while a refresh has failed", async () => {
    let calls = 0;
    renderSection({
      listProjectSettings: () => {
        calls++;
        if (calls > 1) throw new Error("server unavailable");
        return { projects: [], globalEnabled: true };
      },
    });
    expect(await screen.findByText("No projects.")).toBeTruthy();
    window.dispatchEvent(new Event("focus"));
    expect((await screen.findByRole("alert")).textContent).toContain(
      "Could not load projects: server unavailable",
    );
    expect(screen.queryByText("No projects.")).toBeNull();
  });

  it("ignores a list response a newer load superseded", async () => {
    const pending: Array<{ resolve: (value: { projects: ProjectSetting[]; globalEnabled: boolean }) => void }> = [];
    const view = renderSection({
      listProjectSettings: () => new Promise((resolve) => { pending.push({ resolve }); }),
    });
    expect(screen.getByText("Loading projects…")).toBeTruthy();
    window.dispatchEvent(new Event("focus"));
    await act(async () => {});
    expect(view.rpcCalls.filter((call) => call.method === "listProjectSettings")).toHaveLength(2);
    await act(async () => {
      pending[1]!.resolve({ projects: [project({ id: "prj_new", name: "New" })], globalEnabled: true });
    });
    expect(await screen.findByText("New")).toBeTruthy();
    await act(async () => {
      pending[0]!.resolve({ projects: [project({ id: "prj_old", name: "Old" })], globalEnabled: true });
    });
    expect(screen.getByText("New")).toBeTruthy();
    expect(screen.queryByText("Old")).toBeNull();
  });

  it("ignores a list failure a newer load superseded", async () => {
    const pending: Array<{
      resolve: (value: { projects: ProjectSetting[]; globalEnabled: boolean }) => void;
      reject: (error: unknown) => void;
    }> = [];
    renderSection({
      listProjectSettings: () => new Promise((resolve, reject) => { pending.push({ resolve, reject }); }),
    });
    window.dispatchEvent(new Event("focus"));
    await act(async () => {});
    await act(async () => {
      pending[1]!.resolve({ projects: [project({ name: "New" })], globalEnabled: true });
    });
    expect(await screen.findByText("New")).toBeTruthy();
    await act(async () => { pending[0]!.reject(new Error("late boom")); });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText("New")).toBeTruthy();
  });

  it("stores the new value and updates only that row", async () => {
    const view = renderSection({
      listProjectSettings: () => ({
        projects: [project({ id: "prj_a", name: "Alpha" }), project({ id: "prj_b", name: "Beta" })],
        globalEnabled: true,
      }),
    });
    fireEvent.click(await screen.findByLabelText("Alpha"));
    expect(view.rpcCalls).toContainEqual({
      method: "setAutoApprovePlans",
      input: { projectId: "prj_a", autoApprovePlans: true },
    });
    expect(((await screen.findByLabelText("Alpha")) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText("Beta") as HTMLInputElement).checked).toBe(false);
  });

  it("disables the switch while the write is in flight", async () => {
    let stored!: (value: { projectId: string; autoApprovePlans: boolean }) => void;
    renderSection({
      listProjectSettings: () => ({ projects: [project()], globalEnabled: true }),
      setAutoApprovePlans: () =>
        new Promise((resolve) => { stored = resolve; }),
    });
    fireEvent.click(await screen.findByLabelText("Project one"));
    expect((screen.getByLabelText("Project one") as HTMLInputElement).disabled).toBe(true);
    await act(async () => { stored({ projectId: "prj_1", autoApprovePlans: true }); });
    const box = screen.getByLabelText("Project one") as HTMLInputElement;
    expect(box.disabled).toBe(false);
    expect(box.checked).toBe(true);
  });

  it("re-reads and flags the row when the write fails", async () => {
    let loads = 0;
    const view = renderSection({
      listProjectSettings: () => {
        loads++;
        return { projects: [project()], globalEnabled: true };
      },
      setAutoApprovePlans: () => { throw new Error("denied"); },
    });
    const box = await screen.findByLabelText("Project one");
    fireEvent.click(box);
    expect((await screen.findByRole("alert")).textContent).toBe("denied");
    expect(loads).toBe(2);
    const reverted = screen.getByLabelText("Project one") as HTMLInputElement;
    expect(reverted.checked).toBe(false);
    expect(reverted.disabled).toBe(false);
    expect(view.rpcCalls.filter((call) => call.method === "setAutoApprovePlans")).toHaveLength(1);
  });

  it("words a rejection that is not an Error as-is", async () => {
    renderSection({
      listProjectSettings: () => ({ projects: [project()], globalEnabled: true }),
      setAutoApprovePlans: () => { throw "rejected"; },
    });
    fireEvent.click(await screen.findByLabelText("Project one"));
    expect((await screen.findByRole("alert")).textContent).toBe("rejected");
  });

  it("words a first-load rejection that is not an Error as-is", async () => {
    rpcStringRejection.current = "boom-not-an-error";
    renderSection();
    expect((await screen.findByRole("alert")).textContent).toContain(
      "Could not load projects: boom-not-an-error",
    );
  });

  it("clears a row error once a reload succeeds", async () => {
    let loads = 0;
    renderSection({
      listProjectSettings: () => {
        loads++;
        return { projects: [project()], globalEnabled: true };
      },
      setAutoApprovePlans: () => { throw new Error("denied"); },
    });
    fireEvent.click(await screen.findByLabelText("Project one"));
    expect(await screen.findByRole("alert")).toBeTruthy();
    window.dispatchEvent(new Event("focus"));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect((screen.getByLabelText("Project one") as HTMLInputElement).checked).toBe(false);
    expect(loads).toBe(3);
  });

  it("shows each row's override and the global label in the Auto-review select", async () => {
    renderSection({
      listProjectSettings: () => ({
        projects: [
          project({ id: "prj_d", name: "Alpha" }),
          project({ id: "prj_on", name: "Beta", reviewOverride: "on" }),
          project({ id: "prj_off", name: "Gamma", reviewOverride: "off", reviewActive: false }),
        ],
        globalEnabled: false,
      }),
    });
    await screen.findByText("Alpha");
    const rows = screen.getAllByRole("listitem");
    const selects = rows.map((row) => within(row).getByLabelText("Auto-review") as HTMLSelectElement);
    expect(selects.map((select) => select.value)).toEqual(["default", "on", "off"]);
    expect(within(rows[0]!).getByRole("option", { name: "Default (global: off)" })).toBeTruthy();
    expect(within(rows[0]!).getByRole("option", { name: "On" })).toBeTruthy();
    expect(within(rows[0]!).getByRole("option", { name: "Off" })).toBeTruthy();
  });

  it("labels Default with the global switch when it is on", async () => {
    renderSection({
      listProjectSettings: () => ({ projects: [project()], globalEnabled: true }),
    });
    expect(await screen.findByRole("option", { name: "Default (global: on)" })).toBeTruthy();
  });

  it("stores a changed override and refreshes the select and the no-effect note together", async () => {
    const note = "auto-review is off for this project, so this has no effect";
    const view = renderSection({
      listProjectSettings: () => ({
        projects: [project({ id: "prj_a", name: "Alpha" }), project({ id: "prj_b", name: "Beta" })],
        globalEnabled: true,
      }),
    });
    const rows = await screen.findAllByRole("listitem");
    const select = within(rows[0]!).getByLabelText("Auto-review") as HTMLSelectElement;
    expect(within(rows[0]!).queryByText(note)).toBeNull();
    fireEvent.change(select, { target: { value: "off" } });
    expect(view.rpcCalls).toContainEqual({
      method: "setProjectReview",
      input: { projectId: "prj_a", review: "off" },
    });
    await waitFor(() => expect(within(rows[0]!).getByText(note)).toBeTruthy());
    expect((within(rows[0]!).getByLabelText("Auto-review") as HTMLSelectElement).value).toBe("off");
    expect((within(rows[0]!).getByLabelText("Auto-review") as HTMLSelectElement).disabled).toBe(false);
    expect((within(rows[1]!).getByLabelText("Auto-review") as HTMLSelectElement).value).toBe("default");
    expect(within(rows[1]!).queryByText(note)).toBeNull();

    fireEvent.change(within(rows[0]!).getByLabelText("Auto-review"), { target: { value: "on" } });
    await waitFor(() => expect(within(rows[0]!).queryByText(note)).toBeNull());
    expect((within(rows[0]!).getByLabelText("Auto-review") as HTMLSelectElement).value).toBe("on");
  });

  it("re-reads and flags the row when the override write fails", async () => {
    let loads = 0;
    const view = renderSection({
      listProjectSettings: () => {
        loads++;
        return { projects: [project()], globalEnabled: true };
      },
      setProjectReview: () => { throw new Error("malformed"); },
    });
    const select = await screen.findByLabelText("Auto-review");
    fireEvent.change(select, { target: { value: "off" } });
    expect((await screen.findByRole("alert")).textContent).toBe("malformed");
    expect(loads).toBe(2);
    const reverted = screen.getByLabelText("Auto-review") as HTMLSelectElement;
    expect(reverted.value).toBe("default");
    expect(reverted.disabled).toBe(false);
    expect(view.rpcCalls.filter((call) => call.method === "setProjectReview")).toHaveLength(1);
  });
});

describe("Review badge", () => {
  it("renders nothing while the review is loading", () => {
    const view = renderBadge({ threadReview: () => new Promise(() => {}) });
    expect(view.container.innerHTML).toBe("");
  });

  it("renders nothing when no review has run", async () => {
    const view = renderBadge({ threadReview: () => review({ status: "none" }) });
    await waitFor(() => expect(view.rpcCalls).toHaveLength(1));
    await act(async () => {});
    expect(view.container.innerHTML).toBe("");
  });

  it("hides the badge when its load fails", async () => {
    const view = renderBadge({
      threadReview: () => { throw new Error("down"); },
    });
    await waitFor(() => expect(view.rpcCalls).toHaveLength(1));
    await act(async () => {});
    expect(view.container.innerHTML).toBe("");
  });

  it("shows the label, colour, and open count in the text and the aria state", async () => {
    renderBadge({ threadReview: () => review({ status: "committed", openCount: 2 }) });
    const button = await screen.findByRole("button");
    expect(button.textContent).toBe("Committed · 2 open");
    // A committed outcome is the review agent's claim, so it reads agent-reported.
    expect(button.getAttribute("aria-label")).toBe(
      "Auto-review (agent-reported): Committed, 2 open",
    );
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(button.getAttribute("aria-controls")).toBeNull();
    expect(button.style.color).toBe("var(--ink)");
  });

  it("marks agent-reported outcomes and colours them destructive", async () => {
    renderBadge({ threadReview: () => review({ status: "blocked", openCount: 1 }) });
    const button = await screen.findByRole("button");
    // A committed outcome is the review agent's claim, so it reads agent-reported too.
    expect(button.getAttribute("aria-label")).toBe("Auto-review (agent-reported): Blocked, 1 open");
    expect(button.style.color).toBe("var(--destructive-text)");
    expect(button.textContent).toBe("Blocked · 1 open");
  });

  it("colours an in-flight review softly and labels it plainly", async () => {
    renderBadge({ threadReview: () => review({ status: "pending" }) });
    const button = await screen.findByRole("button");
    expect(button.textContent).toBe("Review pending");
    expect(button.getAttribute("aria-label")).toBe("Auto-review: Review pending");
    expect(button.style.color).toBe("color-mix(in oklch, var(--ink) 68%, var(--canvas))");
  });

  it("ages the relative time through minutes, hours, and days", async () => {
    const now = Date.now();
    const at = (ageMs: number) => review({ status: "committed", at: now - ageMs });
    renderBadge({ threadReview: () => at(20_000) });
    expect((await screen.findByRole("button")).textContent).toBe("Committed · just now");
    cleanup();
    renderBadge({ threadReview: () => at(95_000) });
    expect((await screen.findByRole("button")).textContent).toBe("Committed · 1m ago");
    cleanup();
    renderBadge({ threadReview: () => at(5 * 3_600_000) });
    expect((await screen.findByRole("button")).textContent).toBe("Committed · 5h ago");
    cleanup();
    renderBadge({ threadReview: () => at(50 * 3_600_000) });
    expect((await screen.findByRole("button")).textContent).toBe("Committed · 2d ago");
  });

  it("hides the time for a pending review, a missing timestamp, and a compact viewport", async () => {
    renderBadge({
      threadReview: () => review({ status: "pending", at: Date.now() - 95_000 }),
    });
    expect((await screen.findByRole("button")).textContent).toBe("Review pending");
    cleanup();
    renderBadge({ threadReview: () => review({ status: "committed", at: null }) });
    expect((await screen.findByRole("button")).textContent).toBe("Committed");
    cleanup();
    renderBadge({}, { isCompactViewport: true });
    expect((await screen.findByRole("button")).textContent).toBe("");
  });

  it("refreshes the relative time every 30 seconds and stops on unmount", async () => {
    vi.useFakeTimers();
    try {
      const view = renderBadge({
        threadReview: () => review({ status: "committed", at: Date.now() - 95_000 }),
      });
      await act(async () => {});
      expect(screen.getByRole("button").textContent).toBe("Committed · 1m ago");
      expect(vi.getTimerCount()).toBe(1);
      await act(async () => { vi.advanceTimersByTime(30_000); });
      expect(screen.getByRole("button").textContent).toBe("Committed · 2m ago");
      view.unmount();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("collapses to the dot on a compact viewport and schedules no refresh", async () => {
    vi.useFakeTimers();
    try {
      const view = renderBadge({}, { isCompactViewport: true });
      await act(async () => {});
      expect(vi.getTimerCount()).toBe(0);
      const button = screen.getByRole("button");
      expect(button.textContent).toBe("");
      expect(button.style.padding).toBe("0px");
      fireEvent.click(button);
      expect(screen.getByRole("region", { name: "Auto-review details" })).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("opens a popover with the full review details", async () => {
    const at = 1_700_000_000_000;
    renderBadge({
      threadReview: () =>
        review({
          status: "merged",
          at,
          openCount: 1,
          reRaisedCount: 2,
          lastIncident: { at: 1_690_000_000_000, kind: "merge-conflict", detail: "two commits clashed" },
        }),
    });
    const button = await screen.findByRole("button");
    fireEvent.click(button);
    const popover = screen.getByRole("region", { name: "Auto-review details" });
    expect(button.getAttribute("aria-expanded")).toBe("true");
    expect(button.getAttribute("aria-controls")).toBe(popover.id);
    expect(popover.textContent).toContain("Merged · 1 open");
    expect(popover.textContent).toContain(new Date(at).toLocaleString());
    expect(popover.textContent).toContain(
      "Reported by the review agent, not verified against git.",
    );
    expect(popover.textContent).toContain("Earlier incident (");
    expect(popover.textContent).toContain(new Date(1_690_000_000_000).toLocaleString());
    expect(popover.textContent).toContain("merge-conflict: two commits clashed");
    expect(popover.textContent).toContain("2 re-raised");
    expect(popover.textContent).toContain("Details: bb auto-review findings thr_1");
  });

  it("omits empty popover sections and words a current incident as current", async () => {
    renderBadge({
      threadReview: () =>
        review({
          status: "not-reported",
          at: null,
          lastIncident: { at: 1_690_000_000_000, kind: "report-lost", detail: "not on disk" },
        }),
    });
    const button = await screen.findByRole("button");
    fireEvent.click(button);
    const popover = screen.getByRole("region", { name: "Auto-review details" });
    expect(popover.textContent).not.toContain("Reported by the review agent");
    expect(popover.textContent).toContain("Incident (");
    expect(popover.textContent).toContain("not on disk");
    expect(popover.textContent).not.toContain("re-raised");
  });

  it("anchors the popover beside the badge, clamped into the viewport", async () => {
    renderBadge();
    const button = await screen.findByRole("button");
    fireEvent.click(button);
    const popover = screen.getByRole("region", { name: "Auto-review details" });
    expect(popover.style.top).toBe("4px");
    expect(popover.style.right).toBe("736px");
  });

  it("closes on an outside pointerdown and stays open for one inside", async () => {
    renderBadge();
    const button = await screen.findByRole("button");
    fireEvent.click(button);
    expect(screen.getByRole("region", { name: "Auto-review details" })).toBeTruthy();
    fireEvent.pointerDown(button);
    expect(screen.getByRole("region", { name: "Auto-review details" })).toBeTruthy();
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("region", { name: "Auto-review details" })).toBeNull();
    expect(button.getAttribute("aria-expanded")).toBe("false");
  });

  it("closes when the badge is clicked again while open", async () => {
    renderBadge();
    const button = await screen.findByRole("button");
    fireEvent.click(button);
    expect(screen.getByRole("region", { name: "Auto-review details" })).toBeTruthy();
    fireEvent.click(button);
    expect(screen.queryByRole("region", { name: "Auto-review details" })).toBeNull();
    expect(button.getAttribute("aria-expanded")).toBe("false");
  });

  it("closes on Escape while the body has focus and refocuses the badge", async () => {
    renderBadge();
    const button = await screen.findByRole("button");
    fireEvent.click(button);
    expect(document.activeElement).toBe(document.body);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("region", { name: "Auto-review details" })).toBeNull();
    expect(document.activeElement).toBe(button);
  });

  it("closes on Escape while the badge itself has focus", async () => {
    renderBadge();
    const button = await screen.findByRole("button");
    fireEvent.click(button);
    button.focus();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("region", { name: "Auto-review details" })).toBeNull();
  });

  it("ignores Escape while focus is elsewhere", async () => {
    renderBadge();
    const button = await screen.findByRole("button");
    fireEvent.click(button);
    const elsewhere = document.createElement("textarea");
    document.body.appendChild(elsewhere);
    elsewhere.focus();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.getByRole("region", { name: "Auto-review details" })).toBeTruthy();
    elsewhere.remove();
  });

  it("ignores other keys while the popover is open", async () => {
    renderBadge();
    const button = await screen.findByRole("button");
    fireEvent.click(button);
    fireEvent.keyDown(document, { key: "Enter" });
    expect(screen.getByRole("region", { name: "Auto-review details" })).toBeTruthy();
  });

  it("re-reads when a realtime publish arrives for the thread", async () => {
    const view = renderBadge();
    await screen.findByRole("button");
    expect(view.rpcCalls).toHaveLength(1);
    await view.emitRealtime("auto-review:thread:thr_1", null);
    await waitFor(() => expect(view.rpcCalls).toHaveLength(2));
  });

  it("re-reads when the realtime connection is re-established, not while it stays connected", async () => {
    const view = renderBadge();
    await screen.findByRole("button");
    expect(view.rpcCalls).toHaveLength(1);
    await view.setRealtimeConnectionState("reconnecting");
    await view.setRealtimeConnectionState("connected");
    await waitFor(() => expect(view.rpcCalls).toHaveLength(2));
  });

  it("closes the popover and re-reads when the thread changes", async () => {
    const view = renderBadge({
      threadReview: (input) =>
        review(input.threadId === "thr_1" ? { status: "committed" } : { status: "pending" }),
    });
    const button = await screen.findByRole("button");
    fireEvent.click(button);
    expect(screen.getByRole("region", { name: "Auto-review details" })).toBeTruthy();
    view.rerender(
      createElement(badgeSlot.component, {
        threadId: "thr_2",
        projectId: "prj_1",
        isCompactViewport: false,
      }),
    );
    expect(screen.queryByRole("region", { name: "Auto-review details" })).toBeNull();
    expect((await screen.findByRole("button")).textContent).toBe("Review pending");
    expect(view.rpcCalls).toContainEqual({ method: "threadReview", input: { threadId: "thr_2" } });
  });

  it("ignores a review response an older load left stale", async () => {
    const pending: Array<{ resolve: (value: ThreadReview) => void }> = [];
    const view = renderBadge({
      threadReview: () => new Promise((resolve) => { pending.push({ resolve }); }),
    });
    view.rerender(
      createElement(badgeSlot.component, {
        threadId: "thr_2",
        projectId: "prj_1",
        isCompactViewport: false,
      }),
    );
    await act(async () => {});
    expect(pending).toHaveLength(2);
    await act(async () => { pending[1]!.resolve(review({ status: "committed" })); });
    expect((await screen.findByRole("button")).textContent).toBe("Committed");
    await act(async () => { pending[0]!.resolve(review({ status: "blocked" })); });
    expect(screen.getByRole("button").textContent).toBe("Committed");
  });

  it("ignores a review failure an older load left stale", async () => {
    const pending: Array<{
      resolve: (value: ThreadReview) => void;
      reject: (error: unknown) => void;
    }> = [];
    const view = renderBadge({
      threadReview: () => new Promise((resolve, reject) => { pending.push({ resolve, reject }); }),
    });
    view.rerender(
      createElement(badgeSlot.component, {
        threadId: "thr_2",
        projectId: "prj_1",
        isCompactViewport: false,
      }),
    );
    await act(async () => {});
    await act(async () => { pending[1]!.resolve(review({ status: "committed" })); });
    expect((await screen.findByRole("button")).textContent).toBe("Committed");
    await act(async () => { pending[0]!.reject(new Error("late")); });
    expect(screen.getByRole("button").textContent).toBe("Committed");
  });
});

const planPayload = (over: Record<string, unknown> = {}) => ({
  planFilePath: "/w/docs/plans/p.md",
  reviewed: true,
  planText: "# Plan\n\n1. first step\n",
  planSha256: "a".repeat(64),
  truncated: false,
  ...over,
});

describe("Plan approval form", () => {
  function renderForm(
    payload: unknown = planPayload(),
    over: Partial<Pick<PluginPendingInteractionProps, "submit" | "cancel">> = {},
  ) {
    const submit = vi.fn<PluginPendingInteractionProps["submit"]>(async () => undefined);
    const cancel = vi.fn<PluginPendingInteractionProps["cancel"]>(async () => undefined);
    renderSlot<PluginPendingInteractionProps>(planFormSlot, {
      interaction: {
        id: "pint-1",
        threadId: "thr_1",
        title: "Plan approval",
        payload: payload as never,
        createdAt: 1,
        expiresAt: null,
      },
      submit,
      cancel,
      ...over,
    });
    return { submit, cancel };
  }

  it("registers the renderer the backend opens", () => {
    expect(planFormSlot.id).toBe("plan-approval");
  });

  it("shows the plan path and that the review completed, with all three actions", () => {
    renderForm();
    expect(screen.getByText("/w/docs/plans/p.md")).toBeTruthy();
    expect(screen.getByText("auto-review completed its review of this plan.")).toBeTruthy();
    expect(screen.getAllByRole("button").map((button) => button.textContent)).toEqual([
      "Approve",
      "Request changes",
      "Cancel",
    ]);
  });

  it("styles every action as a button with a pointer, not bare text", () => {
    renderForm();
    for (const name of ["Approve", "Request changes", "Cancel"]) {
      const classes = screen.getByRole("button", { name }).className.split(" ");
      expect(classes).toEqual(expect.arrayContaining(["cursor-pointer", "rounded-md", "h-8"]));
    }
    expect(screen.getByRole("button", { name: "Approve" }).className).toContain("bg-foreground");
    expect(screen.getByRole("button", { name: "Request changes" }).className).toContain("border-input");
  });

  it("says when the review could not be confirmed", () => {
    renderForm(planPayload({ planFilePath: "/w/p.md", reviewed: false }));
    expect(screen.getByText("auto-review could not confirm that its review of this plan completed.")).toBeTruthy();
  });

  describe("the plan text", () => {
    it("renders the plan in a bordered, labelled, focusable scroll box with a bounded height, above the path and the reviewed line", () => {
      renderForm();
      const box = screen.getByRole("region", { name: "Plan text" });
      expect(box.getAttribute("tabindex")).toBe("0");
      expect(box.style.maxHeight).toBe("min(40vh, 320px)");
      expect(box.style.overflow).toBe("auto");
      expect(box.style.border).toContain("1px solid");
      expect(within(box).getByTestId("bb-markdown").textContent).toBe("# Plan\n\n1. first step\n");
      const path = screen.getByText("/w/docs/plans/p.md");
      const reviewed = screen.getByText("auto-review completed its review of this plan.");
      expect(box.compareDocumentPosition(path) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(path.compareDocumentPosition(reviewed) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it("shows the truncation notice only when the text was cut, between the box and the path", () => {
      const notice = "The plan is longer than the form can show; the rest is in the file below.";
      renderForm(planPayload({ truncated: true }));
      const shown = screen.getByText(notice);
      expect(shown.compareDocumentPosition(screen.getByText("/w/docs/plans/p.md")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(screen.getByRole("region", { name: "Plan text" }).compareDocumentPosition(shown) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      cleanup();
      renderForm();
      expect(screen.queryByText(notice)).toBeNull();
    });

    it("shows a notice and the path, with no text box, for a plan this host could not read, and Approve still works", async () => {
      const { submit } = renderForm(planPayload({ planText: null, planSha256: null }));
      expect(screen.getByText("The plan text isn't available on this host; open the file to read it.")).toBeTruthy();
      expect(screen.getByText("/w/docs/plans/p.md")).toBeTruthy();
      expect(screen.queryByRole("region", { name: "Plan text" })).toBeNull();
      expect(screen.queryByTestId("bb-markdown")).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "Approve" }));
      await waitFor(() => expect(submit).toHaveBeenCalledWith({ approved: true }));
    });

    // The plugin test runtime's `Markdown` prints its content as plain text, so it cannot show how the host's renderer
    // treats `javascript:` links, raw HTML or remote images: that is the host's chat renderer, not testable here. What
    // this pins is the plugin's side: the plan reaches `Markdown` as one string, with no raw-HTML path of its own.
    it("hands hostile plan text to Markdown as plain content and builds no link, image or element from it", () => {
      const hostile = '[click](javascript:alert(1))\n\n<img src="https://tracker.example/p.png" onerror="alert(1)">\n\n![x](https://tracker.example/i.png)\n\n<script>alert(1)</script>';
      renderForm(planPayload({ planText: hostile }));
      const box = screen.getByRole("region", { name: "Plan text" });
      expect(within(box).getByTestId("bb-markdown").textContent).toBe(hostile);
      expect(box.querySelector("a, img, script, [onerror]")).toBeNull();
      expect(box.innerHTML).not.toContain("<img");
    });
  });

  it("Approve submits { approved: true }", async () => {
    const { submit, cancel } = renderForm();
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(submit).toHaveBeenCalledWith({ approved: true }));
    expect(cancel).not.toHaveBeenCalled();
  });

  it("Request changes submits the feedback", async () => {
    const { submit } = renderForm();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "split step 2" } });
    fireEvent.click(screen.getByRole("button", { name: "Request changes" }));
    await waitFor(() => expect(submit).toHaveBeenCalledWith({ approved: false, feedback: "split step 2" }));
  });

  it("keeps Request changes disabled until the feedback holds non-whitespace text", () => {
    const { submit } = renderForm();
    const button = () => screen.getByRole("button", { name: "Request changes" }) as HTMLButtonElement;
    expect(button().disabled).toBe(true);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "  \n " } });
    expect(button().disabled).toBe(true);
    fireEvent.click(button());
    expect(submit).not.toHaveBeenCalled();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "fix step 2" } });
    expect(button().disabled).toBe(false);
  });

  it("labels the feedback box as required for Request changes", () => {
    renderForm();
    expect(screen.getByLabelText("Feedback (required for Request changes)")).toBe(screen.getByRole("textbox"));
  });

  it("caps the feedback box at the 2000 characters the answer allows", () => {
    renderForm();
    expect(screen.getByRole("textbox").getAttribute("maxlength")).toBe("2000");
  });

  it("Cancel calls cancel() and submits nothing", async () => {
    const { submit, cancel } = renderForm();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(cancel).toHaveBeenCalledTimes(1));
    expect(submit).not.toHaveBeenCalled();
  });

  it("disables every action while an answer is in flight", async () => {
    let finish: () => void = () => undefined;
    renderForm(undefined, { submit: () => new Promise<void>((resolve) => { finish = resolve; }) });
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    await waitFor(() => expect((screen.getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled).toBe(true));
    expect((screen.getByRole("button", { name: "Approve" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).disabled).toBe(true);
    await act(async () => { finish(); });
  });

  it.each([
    ["an Error", () => Promise.reject(new Error("host refused")), "host refused"],
    ["a non-Error", () => Promise.reject("gone"), "gone"],
  ])("shows %s from a failed answer and lets the user try again", async (_name, submit, message) => {
    renderForm(undefined, { submit });
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    expect((await screen.findByRole("alert")).textContent).toBe(message);
    expect((screen.getByRole("button", { name: "Approve" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it.each([
    ["a missing field", { planFilePath: "/w/p.md" }],
    ["a payload from before the plan text was shown", { planFilePath: "/w/p.md", reviewed: true }],
    ["a wrong type", { planFilePath: 3, reviewed: true }],
    ["null", null],
  ])("a payload with %s renders only the error and Cancel", async (_name, payload) => {
    const { cancel } = renderForm(payload);
    expect(screen.getByRole("alert").textContent).toContain("could not be read");
    expect(screen.getAllByRole("button").map((button) => button.textContent)).toEqual(["Cancel"]);
    expect(screen.queryByRole("textbox")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(cancel).toHaveBeenCalledTimes(1));
  });
});
