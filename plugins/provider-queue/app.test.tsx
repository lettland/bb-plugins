// @vitest-environment jsdom

import { cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { useEffect } from "react";
import { toast } from "sonner";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import {
  useComposer,
  type PluginComposerApi,
  type PluginComposerScope,
  type PluginNavPanelProps,
  type PluginProvidersState,
} from "@get-bb/plugin-sdk/app";
import type { PluginRpcTestHandlers } from "@get-bb/plugin-sdk/testing/app";
import type { rpcContract } from "./server.js";
import type { ProviderSummary } from "./src/shared.js";

const app = await loadPluginApp(() => import("./app"));

const customization = app.composerCustomizations[0]!;
const sendMenuItem = customization.sendMenu![0]!;
const navPanel = app.navPanels[0]!;

const EMPTY_TEXT =
  'Queue a thread with "Start when provider has a slot" in the new-thread composer. Or run bb provider-queue add <thread-id>.';

type SnapshotPayload = { providers: ProviderSummary[] };
type PanelRpcHandlers = PluginRpcTestHandlers<typeof rpcContract>;

function fakeComposer(fields: Partial<PluginComposerApi>): PluginComposerApi {
  return fields as PluginComposerApi;
}

function isDisabled(composer: PluginComposerApi): boolean {
  const { disabled } = sendMenuItem;
  return typeof disabled === "function" ? disabled(composer) : !!disabled;
}

function mountComposer(scope: PluginComposerScope) {
  const captured: { composer: PluginComposerApi | null } = { composer: null };
  function CaptureComposer() {
    const composer = useComposer();
    useEffect(() => {
      captured.composer = composer;
    }, [composer]);
    return null;
  }
  const slot = renderSlot(
    { component: CaptureComposer },
    {},
    { composer: { scope, text: "build the report" } },
  );
  if (captured.composer === null) throw new Error("composer was not captured");
  return { slot, composer: captured.composer };
}

function summary(
  fields: Partial<ProviderSummary> & { providerId: string },
): ProviderSummary {
  return {
    label: fields.providerId,
    limit: 2,
    running: [],
    awaiting: [],
    queue: [],
    ...fields,
  };
}

const GLM_SNAPSHOT: SnapshotPayload = {
  providers: [
    summary({
      providerId: "glm",
      label: "GLM plan",
      running: [
        { threadId: "thr_run_1", title: "Running one" },
        { threadId: "thr_run_2", title: "Running two" },
      ],
      awaiting: [{ threadId: "thr_wait", title: "Hold on" }],
      queue: [
        { threadId: "thr_q1", title: "First", providerId: "glm" },
        { threadId: "thr_q2", title: "Second", providerId: "glm" },
      ],
    }),
  ],
};

function handlers(overrides: Partial<PanelRpcHandlers> = {}): PanelRpcHandlers {
  return {
    snapshot: () => ({ providers: [] }),
    move: () => ({ ok: true }),
    release: () => ({ ok: true }),
    setLimit: () => ({ ok: true }),
    ...overrides,
  };
}

function directoryWith(
  entries: Array<{ id: string; displayName: string }>,
): PluginProvidersState {
  return {
    status: "ready",
    providers: entries.map(
      (entry) => entry as PluginProvidersState["providers"][number],
    ),
  };
}

function renderPanel(rpc: PanelRpcHandlers, providers?: PluginProvidersState) {
  return renderSlot<PluginNavPanelProps, typeof rpcContract>(
    { component: navPanel.component },
    { subPath: "" },
    { rpc, providers: providers ?? { status: "ready", providers: [] } },
  );
}

function limitRow(slot: ReturnType<typeof renderPanel>, name: string) {
  const input = slot.getByRole("spinbutton", { name }) as HTMLInputElement;
  const row = input.parentElement;
  if (row === null) throw new Error(`no limits row for ${name}`);
  return {
    input,
    saveButton: within(row).getByRole("button", { name: /^Save/ }),
  };
}

function queueRow(
  slot: ReturnType<typeof renderPanel>,
  title: string,
): HTMLElement {
  const row = slot.getByText(title).closest("li");
  if (row === null) throw new Error(`no queue row for ${title}`);
  return row;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("registration", () => {
  it("adds the queue menu item and the provider queue panel", () => {
    expect(customization).toMatchObject({
      id: "provider-queue",
      scopes: ["new-thread"],
      sendMenu: [
        {
          id: "start-when-provider-free",
          label: "Start when provider has a slot",
          description:
            "Waits until fewer than the provider's limit of threads are running. Starts right away if a slot is free.",
        },
      ],
    });
    expect(navPanel).toMatchObject({
      id: "provider-queue-panel",
      title: "Provider queue",
      icon: "ListOrdered",
      path: "queue",
    });
  });
});

describe("disabled state", () => {
  it("is disabled while submitting is blocked", () => {
    expect(isDisabled(fakeComposer({ isSubmittingBlocked: true }))).toBe(true);
  });

  it("is enabled otherwise, whatever the project or scope", () => {
    expect(
      isDisabled(
        fakeComposer({
          isSubmittingBlocked: false,
          scope: { kind: "new-thread", projectId: "proj_personal" },
        }),
      ),
    ).toBe(false);
    expect(
      isDisabled(
        fakeComposer({
          isSubmittingBlocked: false,
          scope: { kind: "new-thread", projectId: "proj_1" },
        }),
      ),
    ).toBe(false);
    expect(
      isDisabled(
        fakeComposer({
          isSubmittingBlocked: false,
          scope: { kind: "thread", threadId: "thr_1" },
        }),
      ),
    ).toBe(false);
  });
});

describe("run", () => {
  it("submits the queue intent", async () => {
    const { slot, composer } = mountComposer({
      kind: "new-thread",
      projectId: "proj_1",
    });

    await sendMenuItem.run({ composer });

    expect(slot.inspection.composer.submits).toEqual([
      { experimental_data: { queue: true } },
    ]);
  });

  it("shows a toast when the submit is rejected", async () => {
    const error = vi.spyOn(toast, "error").mockReturnValue("toast");
    const { composer } = mountComposer({
      kind: "new-thread",
      projectId: "proj_1",
    });
    vi.spyOn(composer, "submit").mockRejectedValue(
      new Error("Pick a project first."),
    );

    await sendMenuItem.run({ composer });

    await waitFor(() =>
      expect(error).toHaveBeenCalledWith("Could not queue the thread", {
        description: "Pick a project first.",
      }),
    );
  });

  it("stringifies a non-Error rejection in the toast", async () => {
    const error = vi.spyOn(toast, "error").mockReturnValue("toast");
    const { composer } = mountComposer({
      kind: "new-thread",
      projectId: "proj_1",
    });
    vi.spyOn(composer, "submit").mockRejectedValue("queue offline");

    await sendMenuItem.run({ composer });

    await waitFor(() =>
      expect(error).toHaveBeenCalledWith("Could not queue the thread", {
        description: "queue offline",
      }),
    );
  });
});

describe("panel", () => {
  it("shows loading while the first snapshot is in flight", () => {
    const slot = renderPanel(
      handlers({ snapshot: () => new Promise<SnapshotPayload>(() => {}) }),
    );

    expect(slot.getByText("Loading…")).toBeTruthy();
  });

  it("shows the snapshot error inside an alert", async () => {
    const slot = renderPanel(
      handlers({
        snapshot: () => {
          throw new Error("queue exploded");
        },
      }),
    );

    await waitFor(() =>
      expect(slot.getByRole("alert").textContent).toBe("queue exploded"),
    );
  });

  it("shows the empty state for an empty snapshot and for slot-less providers", async () => {
    const empty = renderPanel(handlers());
    await waitFor(() => expect(empty.getByText(EMPTY_TEXT)).toBeTruthy());
    expect(empty.getByText("Nothing queued")).toBeTruthy();
    expect(empty.queryByRole("heading", { name: "Limits" })).toBeNull();
    empty.unmount();

    const idle = renderPanel(
      handlers({
        snapshot: () => ({
          providers: [summary({ providerId: "glm", label: "GLM plan" })],
        }),
      }),
    );
    await waitFor(() => expect(idle.getByText(EMPTY_TEXT)).toBeTruthy());
    expect(idle.getByRole("heading", { name: "Limits" })).toBeTruthy();
    expect(
      (limitRow(idle, "Limit for GLM plan").input as HTMLInputElement).value,
    ).toBe("2");
  });

  it("renders each provider card with its rows, badges and queue positions", async () => {
    const slot = renderPanel(handlers({ snapshot: () => GLM_SNAPSHOT }));

    await waitFor(() =>
      expect(
        slot.getByRole("heading", { level: 2, name: "GLM plan" }),
      ).toBeTruthy(),
    );
    expect(slot.getByText("2 running")).toBeTruthy();
    expect(slot.getByText("1 waiting on you")).toBeTruthy();
    expect(slot.getByText("2 queued")).toBeTruthy();
    expect(slot.getByText("limit 2")).toBeTruthy();
    expect(slot.getByText("Running one")).toBeTruthy();
    expect(slot.getByText("Running two")).toBeTruthy();
    expect(slot.getByText("Hold on")).toBeTruthy();
    expect(slot.getByText("waiting on you")).toBeTruthy();
    const firstRow = queueRow(slot, "First");
    expect(within(firstRow).getByText("1")).toBeTruthy();
    expect(within(firstRow).getByText("thr_q1")).toBeTruthy();
    expect(
      within(firstRow).getByRole("button", { name: "Release First (thr_q1)" }),
    ).toBeTruthy();
    const secondRow = queueRow(slot, "Second");
    expect(within(secondRow).getByText("2")).toBeTruthy();
    expect(within(secondRow).getByText("thr_q2")).toBeTruthy();
    expect(slot.inspection.rpcCalls).toEqual([
      { method: "snapshot", input: null },
    ]);
  });

  it("labels the limit input with the provider label", async () => {
    const slot = renderPanel(handlers({ snapshot: () => GLM_SNAPSHOT }));

    await waitFor(() =>
      expect(
        slot.getByRole("spinbutton", { name: "Limit for GLM plan" }),
      ).toBeTruthy(),
    );
  });

  it("numbers queue rows and hides edge buttons per provider card", async () => {
    const slot = renderPanel(
      handlers({
        snapshot: () => ({
          providers: [
            summary({
              providerId: "alpha",
              label: "Alpha",
              queue: [
                { threadId: "A1", title: "Alpha one", providerId: "alpha" },
                { threadId: "A2", title: "Alpha two", providerId: "alpha" },
              ],
            }),
            summary({
              providerId: "glm",
              label: "GLM plan",
              queue: [
                { threadId: "G1", title: "Gamma one", providerId: "glm" },
                { threadId: "G2", title: "Gamma two", providerId: "glm" },
              ],
            }),
          ],
        }),
      }),
    );

    await waitFor(() =>
      expect(
        slot.getByRole("heading", { level: 2, name: "Alpha" }),
      ).toBeTruthy(),
    );
    const alphaOne = queueRow(slot, "Alpha one");
    const alphaTwo = queueRow(slot, "Alpha two");
    const gammaOne = queueRow(slot, "Gamma one");
    const gammaTwo = queueRow(slot, "Gamma two");
    expect(within(alphaOne).getByText("1")).toBeTruthy();
    expect(within(alphaOne).getByText("A1")).toBeTruthy();
    expect(within(alphaTwo).getByText("2")).toBeTruthy();
    expect(within(gammaOne).getByText("1")).toBeTruthy();
    expect(within(gammaTwo).getByText("2")).toBeTruthy();
    expect(
      slot.queryByRole("button", { name: "Move Alpha one (A1) up" }),
    ).toBeNull();
    expect(
      slot.queryByRole("button", { name: "Move Gamma one (G1) up" }),
    ).toBeNull();
    expect(
      slot.queryByRole("button", { name: "Move Alpha two (A2) down" }),
    ).toBeNull();
    expect(
      slot.queryByRole("button", { name: "Move Gamma two (G2) down" }),
    ).toBeNull();
    expect(
      slot.getByRole("button", { name: "Move Alpha one (A1) down" }),
    ).toBeTruthy();
    expect(
      slot.getByRole("button", { name: "Move Gamma two (G2) up" }),
    ).toBeTruthy();
    expect(slot.getAllByRole("button", { name: /^Release / })).toHaveLength(4);
  });

  it("moves a row up and refreshes", async () => {
    const slot = renderPanel(handlers({ snapshot: () => GLM_SNAPSHOT }));
    await waitFor(() =>
      expect(slot.getByRole("button", { name: "Move Second (thr_q2) up" })).toBeTruthy(),
    );

    fireEvent.click(slot.getByRole("button", { name: "Move Second (thr_q2) up" }));

    await waitFor(() =>
      expect(slot.inspection.rpcCalls).toEqual([
        { method: "snapshot", input: null },
        { method: "move", input: { threadId: "thr_q2", direction: "up" } },
        { method: "snapshot", input: null },
      ]),
    );
  });

  it("moves a row down and refreshes", async () => {
    const slot = renderPanel(handlers({ snapshot: () => GLM_SNAPSHOT }));
    await waitFor(() =>
      expect(slot.getByRole("button", { name: "Move First (thr_q1) down" })).toBeTruthy(),
    );

    fireEvent.click(slot.getByRole("button", { name: "Move First (thr_q1) down" }));

    await waitFor(() =>
      expect(slot.inspection.rpcCalls).toEqual([
        { method: "snapshot", input: null },
        { method: "move", input: { threadId: "thr_q1", direction: "down" } },
        { method: "snapshot", input: null },
      ]),
    );
  });

  it("releases a row and refreshes", async () => {
    const slot = renderPanel(handlers({ snapshot: () => GLM_SNAPSHOT }));
    await waitFor(() =>
      expect(slot.getByRole("button", { name: "Release First (thr_q1)" })).toBeTruthy(),
    );

    fireEvent.click(slot.getByRole("button", { name: "Release First (thr_q1)" }));

    await waitFor(() =>
      expect(slot.inspection.rpcCalls).toEqual([
        { method: "snapshot", input: null },
        { method: "release", input: { threadId: "thr_q1" } },
        { method: "snapshot", input: null },
      ]),
    );
  });

  it("toasts when a move is rejected", async () => {
    const error = vi.spyOn(toast, "error").mockReturnValue("toast");
    const slot = renderPanel(
      handlers({
        snapshot: () => GLM_SNAPSHOT,
        move: () => {
          throw new Error("not queued");
        },
      }),
    );
    await waitFor(() =>
      expect(slot.getByRole("button", { name: "Move Second (thr_q2) up" })).toBeTruthy(),
    );

    fireEvent.click(slot.getByRole("button", { name: "Move Second (thr_q2) up" }));

    await waitFor(() =>
      expect(error).toHaveBeenCalledWith("Could not move the thread", {
        description: "not queued",
      }),
    );
  });

  it("toasts when a release is rejected", async () => {
    const error = vi.spyOn(toast, "error").mockReturnValue("toast");
    const slot = renderPanel(
      handlers({
        snapshot: () => GLM_SNAPSHOT,
        release: () => {
          throw new Error("already gone");
        },
      }),
    );
    await waitFor(() =>
      expect(slot.getByRole("button", { name: "Release First (thr_q1)" })).toBeTruthy(),
    );

    fireEvent.click(slot.getByRole("button", { name: "Release First (thr_q1)" }));

    await waitFor(() =>
      expect(error).toHaveBeenCalledWith("Could not release the thread", {
        description: "already gone",
      }),
    );
  });

  it("sets a valid limit and refreshes", async () => {
    const slot = renderPanel(handlers({ snapshot: () => GLM_SNAPSHOT }));
    await waitFor(() =>
      expect(limitRow(slot, "Limit for GLM plan").input).toBeTruthy(),
    );

    const row = limitRow(slot, "Limit for GLM plan");
    fireEvent.change(row.input, { target: { value: "5" } });
    fireEvent.click(row.saveButton);

    await waitFor(() =>
      expect(slot.inspection.rpcCalls).toEqual([
        { method: "snapshot", input: null },
        { method: "setLimit", input: { providerId: "glm", limit: 5 } },
        { method: "snapshot", input: null },
      ]),
    );
  });

  it("rejects an empty limit draft without any rpc call", async () => {
    const error = vi.spyOn(toast, "error").mockReturnValue("toast");
    const slot = renderPanel(handlers({ snapshot: () => GLM_SNAPSHOT }));
    await waitFor(() =>
      expect(limitRow(slot, "Limit for GLM plan").input).toBeTruthy(),
    );

    const row = limitRow(slot, "Limit for GLM plan");
    fireEvent.change(row.input, { target: { value: "" } });
    fireEvent.click(row.saveButton);

    await waitFor(() =>
      expect(error).toHaveBeenCalledWith("Enter a number for the limit"),
    );
    expect(slot.inspection.rpcCalls).toEqual([
      { method: "snapshot", input: null },
    ]);
  });

  it("rejects a whitespace-only limit draft without any rpc call", async () => {
    const error = vi.spyOn(toast, "error").mockReturnValue("toast");
    const slot = renderPanel(handlers({ snapshot: () => GLM_SNAPSHOT }));
    await waitFor(() =>
      expect(limitRow(slot, "Limit for GLM plan").input).toBeTruthy(),
    );

    const row = limitRow(slot, "Limit for GLM plan");
    fireEvent.change(row.input, { target: { value: "   " } });
    fireEvent.click(row.saveButton);

    await waitFor(() =>
      expect(error).toHaveBeenCalledWith("Enter a number for the limit"),
    );
    expect(slot.inspection.rpcCalls).toEqual([
      { method: "snapshot", input: null },
    ]);
  });

  it("rejects a negative limit without any rpc call", async () => {
    const error = vi.spyOn(toast, "error").mockReturnValue("toast");
    const slot = renderPanel(handlers({ snapshot: () => GLM_SNAPSHOT }));
    await waitFor(() =>
      expect(limitRow(slot, "Limit for GLM plan").input).toBeTruthy(),
    );

    const row = limitRow(slot, "Limit for GLM plan");
    fireEvent.change(row.input, { target: { value: "-1" } });
    fireEvent.click(row.saveButton);

    await waitFor(() =>
      expect(error).toHaveBeenCalledWith(
        "The limit must be a whole number of 0 or more",
      ),
    );
    expect(slot.inspection.rpcCalls).toEqual([
      { method: "snapshot", input: null },
    ]);
  });

  it("rejects a fractional limit without any rpc call", async () => {
    const error = vi.spyOn(toast, "error").mockReturnValue("toast");
    const slot = renderPanel(handlers({ snapshot: () => GLM_SNAPSHOT }));
    await waitFor(() =>
      expect(limitRow(slot, "Limit for GLM plan").input).toBeTruthy(),
    );

    const row = limitRow(slot, "Limit for GLM plan");
    fireEvent.change(row.input, { target: { value: "1.5" } });
    fireEvent.click(row.saveButton);

    await waitFor(() =>
      expect(error).toHaveBeenCalledWith(
        "The limit must be a whole number of 0 or more",
      ),
    );
    expect(slot.inspection.rpcCalls).toEqual([
      { method: "snapshot", input: null },
    ]);
  });

  it("toasts when setting the limit is rejected", async () => {
    const error = vi.spyOn(toast, "error").mockReturnValue("toast");
    const slot = renderPanel(
      handlers({
        snapshot: () => GLM_SNAPSHOT,
        setLimit: () => {
          throw new Error("busy");
        },
      }),
    );
    await waitFor(() =>
      expect(limitRow(slot, "Limit for GLM plan").input).toBeTruthy(),
    );

    fireEvent.click(limitRow(slot, "Limit for GLM plan").saveButton);

    await waitFor(() =>
      expect(error).toHaveBeenCalledWith("Could not set the limit", {
        description: "busy",
      }),
    );
  });

  it("resyncs an untouched limit draft when the server limit changes", async () => {
    let snapshotPayload: SnapshotPayload = GLM_SNAPSHOT;
    const slot = renderPanel(handlers({ snapshot: () => snapshotPayload }));
    await waitFor(() =>
      expect(limitRow(slot, "Limit for GLM plan").input.value).toBe("2"),
    );

    snapshotPayload = {
      providers: GLM_SNAPSHOT.providers.map((provider) => ({
        ...provider,
        limit: 5,
      })),
    };
    await slot.behavior.emitRealtime("provider-queue", { kind: "state" });

    await waitFor(() =>
      expect(limitRow(slot, "Limit for GLM plan").input.value).toBe("5"),
    );
  });

  it("keeps an edited limit draft while the input is focused", async () => {
    let snapshotPayload: SnapshotPayload = GLM_SNAPSHOT;
    const slot = renderPanel(handlers({ snapshot: () => snapshotPayload }));
    await waitFor(() =>
      expect(limitRow(slot, "Limit for GLM plan").input.value).toBe("2"),
    );

    const row = limitRow(slot, "Limit for GLM plan");
    row.input.focus();
    fireEvent.change(row.input, { target: { value: "7" } });
    snapshotPayload = {
      providers: GLM_SNAPSHOT.providers.map((provider) => ({
        ...provider,
        limit: 5,
      })),
    };
    await slot.behavior.emitRealtime("provider-queue", { kind: "state" });
    await waitFor(() => expect(slot.inspection.rpcCalls).toHaveLength(2));

    expect(limitRow(slot, "Limit for GLM plan").input.value).toBe("7");
  });

  it("resyncs a stale edited draft once the input is not focused", async () => {
    let snapshotPayload: SnapshotPayload = GLM_SNAPSHOT;
    const slot = renderPanel(handlers({ snapshot: () => snapshotPayload }));
    await waitFor(() =>
      expect(limitRow(slot, "Limit for GLM plan").input.value).toBe("2"),
    );

    const row = limitRow(slot, "Limit for GLM plan");
    row.input.focus();
    fireEvent.change(row.input, { target: { value: "7" } });
    row.input.blur();
    snapshotPayload = {
      providers: GLM_SNAPSHOT.providers.map((provider) => ({
        ...provider,
        limit: 5,
      })),
    };
    await slot.behavior.emitRealtime("provider-queue", { kind: "state" });
    await waitFor(() => expect(slot.inspection.rpcCalls).toHaveLength(2));

    expect(limitRow(slot, "Limit for GLM plan").input.value).toBe("5");
  });

  it("submits the typed limit after the input blurs on the click", async () => {
    const slot = renderPanel(handlers({ snapshot: () => GLM_SNAPSHOT }));
    await waitFor(() =>
      expect(limitRow(slot, "Limit for GLM plan").input.value).toBe("2"),
    );

    const row = limitRow(slot, "Limit for GLM plan");
    fireEvent.focus(row.input);
    fireEvent.change(row.input, { target: { value: "9" } });
    expect(row.input.value).toBe("9");

    fireEvent.blur(row.input);
    fireEvent.click(row.saveButton);

    await waitFor(() =>
      expect(slot.inspection.rpcCalls).toEqual([
        { method: "snapshot", input: null },
        { method: "setLimit", input: { providerId: "glm", limit: 9 } },
        { method: "snapshot", input: null },
      ]),
    );
  });

  it("renders the limits editor for an idle provider with a configured limit", async () => {
    const slot = renderPanel(
      handlers({
        snapshot: () => ({
          providers: [
            summary({ providerId: "paused", label: "Paused", limit: 0 }),
          ],
        }),
      }),
    );

    await waitFor(() =>
      expect(slot.getByRole("heading", { name: "Limits" })).toBeTruthy(),
    );
    expect(slot.getByText("Nothing queued")).toBeTruthy();
    expect(
      (limitRow(slot, "Limit for Paused").input as HTMLInputElement).value,
    ).toBe("0");
  });

  it("falls back to the directory name and then the raw provider id", async () => {
    const slot = renderPanel(
      handlers({
        snapshot: () => ({
          providers: [
            summary({
              providerId: "glm",
              label: "GLM plan",
              running: [{ threadId: "thr_r", title: "Runner" }],
            }),
            summary({
              providerId: "rawprovider",
              awaiting: [{ threadId: "thr_w", title: "Waiter" }],
            }),
            summary({
              providerId: "lonely",
              queue: [
                { threadId: "thr_q", title: "Lonely", providerId: "lonely" },
              ],
            }),
          ],
        }),
      }),
      directoryWith([{ id: "rawprovider", displayName: "Raw Provider" }]),
    );

    await waitFor(() =>
      expect(slot.getByRole("heading", { level: 2, name: "lonely" })).toBeTruthy(),
    );
    expect(
      slot
        .getAllByRole("heading", { level: 2 })
        .map((heading) => heading.textContent),
    ).toEqual(["GLM plan", "Raw Provider", "lonely", "Limits"]);
    expect(
      slot.getByRole("spinbutton", { name: "Limit for Raw Provider" }),
    ).toBeTruthy();
    expect(
      slot.getByRole("spinbutton", { name: "Limit for lonely" }),
    ).toBeTruthy();
  });

  it("lists directory-only providers after the snapshot ones, by display name", async () => {
    const slot = renderPanel(
      handlers(),
      directoryWith([
        { id: "zeta", displayName: "Zeta" },
        { id: "alpha", displayName: "Alpha" },
      ]),
    );

    await waitFor(() =>
      expect(slot.getByRole("heading", { name: "Limits" })).toBeTruthy(),
    );
    expect(slot.getByText(EMPTY_TEXT)).toBeTruthy();
    expect(
      slot
        .getAllByRole("spinbutton")
        .map((input) => input.getAttribute("aria-label")),
    ).toEqual(["Limit for Alpha", "Limit for Zeta"]);
    expect(
      (slot.getByRole("spinbutton", { name: "Limit for Alpha" }) as HTMLInputElement)
        .value,
    ).toBe("2");
  });

  it("saves a limit for a directory-only provider and refreshes", async () => {
    const slot = renderPanel(
      handlers({ snapshot: () => GLM_SNAPSHOT }),
      directoryWith([{ id: "claude", displayName: "Claude" }]),
    );
    await waitFor(() =>
      expect(slot.getByRole("spinbutton", { name: "Limit for Claude" })).toBeTruthy(),
    );

    const row = limitRow(slot, "Limit for Claude");
    fireEvent.change(row.input, { target: { value: "4" } });
    fireEvent.click(row.saveButton);

    await waitFor(() =>
      expect(slot.inspection.rpcCalls).toEqual([
        { method: "snapshot", input: null },
        { method: "setLimit", input: { providerId: "claude", limit: 4 } },
        { method: "snapshot", input: null },
      ]),
    );
  });

  it("refreshes on provider-queue realtime events only", async () => {
    const slot = renderPanel(handlers({ snapshot: () => GLM_SNAPSHOT }));
    await waitFor(() =>
      expect(
        slot.getByRole("heading", { level: 2, name: "GLM plan" }),
      ).toBeTruthy(),
    );
    expect(slot.inspection.rpcCalls).toHaveLength(1);

    await slot.behavior.emitRealtime("another-channel", { kind: "state" });
    expect(slot.inspection.rpcCalls).toHaveLength(1);

    await slot.behavior.emitRealtime("provider-queue", { kind: "state" });
    await waitFor(() => expect(slot.inspection.rpcCalls).toHaveLength(2));
    expect(slot.inspection.rpcCalls[1]).toEqual({
      method: "snapshot",
      input: null,
    });
  });
});
