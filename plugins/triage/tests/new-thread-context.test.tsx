// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { installTestPluginRuntime, loadPluginApp, mountPluginContentScripts, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { afterEach, expect, onTestFinished, test, vi } from "vitest";
import { getNewThreadAnchors, mountNewThreadAnchors } from "@/lib/new-thread-context";

installTestPluginRuntime();
const app = await loadPluginApp(() => import("../app"));
const overlay = app.appOverlays.find((entry) => entry.id === "triage-new-thread-overlay")!;
const resize = new Map<Element, () => void>();

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  resize.clear();
});

test("handles an already aborted script and markers added after a pane", async () => {
  const aborted = new AbortController();
  aborted.abort();
  mountNewThreadAnchors(aborted.signal)();
  expect(getNewThreadAnchors()).toHaveLength(0);
  const controller = new AbortController();
  const dispose = mountNewThreadAnchors(controller.signal);
  onTestFinished(dispose);
  const target = document.createElement("div");
  const outer = document.createElement("div");
  target.append(outer);
  document.body.append(target);
  const marker = document.createElement("div");
  marker.dataset.testid = "root-compose-compact-home";
  outer.append(marker);
  await waitFor(() => expect(getNewThreadAnchors()).toHaveLength(1));
  const duplicate = marker.cloneNode() as Element;
  outer.append(duplicate);
  await act(async () => {});
  expect(getNewThreadAnchors()).toHaveLength(1);
  controller.abort();
  expect(getNewThreadAnchors()).toHaveLength(0);
});

test("discovers existing and added panes, removes their anchors, and disposes on abort", async () => {
  const first = document.createElement("div");
  first.innerHTML = '<div id="root-compose-main-panel"><div style="position:relative"><div><div data-testid="root-compose-compact-home"></div></div></div></div>';
  document.body.append(first);
  const scripts = await mountPluginContentScripts(app, { pluginId: "triage" });
  onTestFinished(() => scripts.lifecycle.dispose());
  expect(getNewThreadAnchors()).toHaveLength(1);
  const snapshot = getNewThreadAnchors();
  first.append(document.createTextNode("stream"));
  await act(async () => {});
  expect(getNewThreadAnchors()).toBe(snapshot);
  snapshot[0]!.node.remove();
  await waitFor(() => expect(getNewThreadAnchors()[0]!.id).not.toBe(snapshot[0]!.id));
  const second = first.cloneNode(true) as HTMLElement;
  second.querySelector('[data-triage-new-thread-anchor]')?.remove();
  second.querySelector("#root-compose-main-panel")?.removeAttribute("id");
  document.body.append(second);
  await waitFor(() => expect(getNewThreadAnchors()).toHaveLength(2));
  first.remove();
  await waitFor(() => expect(getNewThreadAnchors()).toHaveLength(1));
  await scripts.lifecycle.dispose();
  expect(scripts.inspection.signal.aborted).toBe(true);
  expect(getNewThreadAnchors()).toHaveLength(0);
  expect(second.querySelector('[data-triage-new-thread-anchor]')).toBeNull();
});

test("renders the real Triage list in wide and compact panes and navigates", async () => {
  const root = document.createElement("div");
  root.id = "app-root";
  root.dataset.splitPaneId = "pane-1";
  root.dataset.focused = "false";
  root.addEventListener("pointerdown", (event) => { if (event.target === root) root.dataset.focused = "true"; });
  vi.stubGlobal("PointerEvent", MouseEvent);
  root.innerHTML = '<div id="root-compose-main-panel"><div style="position:relative"><div><div data-testid="root-compose-compact-home"></div></div></div></div>';
  document.body.append(root);
  let width = 1600;
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(() => width);
  vi.stubGlobal("ResizeObserver", class {
    constructor(private callback: ResizeObserverCallback) {}
    observe(element: Element) { resize.set(element, () => this.callback([], this as unknown as ResizeObserver)); }
    disconnect() {} unobserve() {}
  });
  const scripts = await mountPluginContentScripts(app, { pluginId: "triage" });
  onTestFinished(() => scripts.lifecycle.dispose());
  const view = renderSlot(overlay, {}, { rpc: { snapshot: () => ({
    stages: [{ id: "active", name: "In Progress", position: 1, systemRole: "active" }],
    tasks: [{ id: "task", number: 1, title: "Fixture", projectName: "Fixture project", stageId: "active", threadId: "thr-fixture", runState: "idle", settledAt: null, updatedAt: Date.now() }],
    projects: [], machines: [], notifications: [], unreadCount: 0,
  }) } });
  expect(await screen.findByRole("button", { name: /Fixture project · Fixture/ })).toBeTruthy();
  fireEvent.pointerDown(screen.getByRole("button", { name: /Fixture project · Fixture/ }));
  expect(root.dataset.focused).toBe("true");
  fireEvent.click(screen.getByRole("button", { name: /Fixture project · Fixture/ }));
  expect(view.navigateCalls).toContainEqual({ method: "toThread", threadId: "thr-fixture" });
  width = 900;
  act(() => resize.get(getNewThreadAnchors()[0]!.target)?.());
  fireEvent.click(screen.getByRole("button", { name: "Triage" }));
  expect(await screen.findByRole("region", { name: "Triage" })).toBeTruthy();
  const dialog = screen.getByRole("dialog");
  expect(dialog.classList.contains("max-h-[var(--radix-popover-content-available-height)]")).toBe(true);
  expect(dialog.classList.contains("overflow-y-auto")).toBe(true);
  expect(root.hasAttribute("inert")).toBe(false);
  expect(root.getAttribute("aria-hidden")).not.toBe("true");
  fireEvent.click(within(screen.getByRole("region", { name: "Triage" })).getByRole("heading", { name: "Triage" }));
  expect(screen.getByRole("region", { name: "Triage" })).toBeTruthy();
  const row = within(screen.getByRole("region", { name: "Triage" })).getByRole("button", { name: /Fixture project · Fixture/ });
  row.setAttribute("data-thread-context-card-row", "");
  fireEvent.click(row);
  expect(view.navigateCalls).toHaveLength(2);
  expect(screen.queryByRole("region", { name: "Triage" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Triage" }));
  width = 1600;
  act(() => resize.get(getNewThreadAnchors()[0]!.target)?.());
  expect(screen.queryByRole("button", { name: "Triage" })).toBeNull();
  root.remove();
  await waitFor(() => expect(getNewThreadAnchors()).toHaveLength(0));
  await scripts.lifecycle.dispose();
});

test("opens the compact drawer with empty content without hiding the app root", async () => {
  const root = document.createElement("div");
  root.innerHTML = '<div id="root-compose-main-panel"><div style="position:relative"><div><div data-testid="root-compose-compact-home"></div></div></div></div>';
  document.body.append(root);
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(390);
  vi.spyOn(window, "matchMedia").mockImplementation((query) => ({
    matches: query.includes("767px"), media: query, onchange: null,
    addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => true,
  }));
  const scripts = await mountPluginContentScripts(app, { pluginId: "triage" });
  onTestFinished(() => scripts.lifecycle.dispose());
  renderSlot(overlay, {}, { rpc: { snapshot: () => ({ stages: [], tasks: [], projects: [], machines: [], notifications: [], unreadCount: 0 }) } });
  fireEvent.click(screen.getByRole("button", { name: "Triage" }));
  expect(screen.queryByText("Nothing to show yet")).toBeNull();
  expect(document.querySelector("[data-persistent-drawer-content]")).not.toBeNull();
  expect(await screen.findByText("Nothing to show yet")).toBeTruthy();
  expect(root.hasAttribute("inert")).toBe(false);
  expect(root.getAttribute("aria-hidden")).not.toBe("true");
  await scripts.lifecycle.dispose();
});
