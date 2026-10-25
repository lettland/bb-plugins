// @vitest-environment jsdom

import { cleanup, fireEvent, waitFor } from "@testing-library/react";
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
  'Nothing queued. Use "Start when provider has a slot" in the new-thread composer, or bb provider-queue add.';

type SnapshotPayload = { providers: ProviderSummary[]; queueOrder: string[] };
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
  queueOrder: ["thr_q1", "thr_q2"],
};

function handlers(overrides: Partial<PanelRpcHandlers> = {}): PanelRpcHandlers {
  return {
    snapshot: () => ({ providers: [], queueOrder: [] }),
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
    expect(
      isDisabled(fakeComposer({ isSubmittingBlocked: true })),
    ).toBe(true);
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
    empty.unmount();

    const idle = renderPanel(
      handlers({
        snapshot: () => ({
          providers: [summary({ providerId: "glm", label: "GLM plan" })],
          queueOrder: [],
        }),
      }),
    );
    await waitFor(() => expect(idle.getByText(EMPTY_TEXT)).toBeTruthy());
  });

  it("renders each provider section with its rows and queue positions", async () => {
    const slot = renderPanel(handlers({ snapshot: () => GLM_SNAPSHOT }));

    await waitFor(() =>
      expect(
        slot.getByRole("heading", { level: 2, name: "GLM plan" }),
      ).toBeTruthy(),
    );
    expect(slot.getByText("2 running + 1 awaiting you, limit 2")).toBeTruthy();
    expect(slot.getByText("Running one")).toBeTruthy();
    expect(slot.getByText("Running two")).toBeTruthy();
    expect(slot.getByText("Hold on — awaiting you")).toBeTruthy();
    expect(slot.getByText("1. First (thr_q1)")).toBeTruthy();
    expect(slot.getByText("2. Second (thr_q2)")).toBeTruthy();
    expect(slot.inspection.rpcCalls).toEqual([{ method: "snapshot", input: null }]);
  });

  it("moves a row up and refreshes", async () => {
    const slot = renderPanel(handlers({ snapshot: () => GLM_SNAPSHOT }));
    await waitFor(() =>
      expect(slot.getByRole("button", { name: "Move up" })).toBeTruthy(),
    );

    fireEvent.click(slot.getByRole("button", { name: "Move up" }));

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
      expect(slot.getByRole("button", { name: "Move down" })).toBeTruthy(),
    );

    fireEvent.click(slot.getByRole("button", { name: "Move down" }));

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
      expect(slot.getAllByRole("button", { name: "Release" })).toHaveLength(2),
    );

    fireEvent.click(slot.getAllByRole("button", { name: "Release" })[0]!);

    await waitFor(() =>
      expect(slot.inspection.rpcCalls).toEqual([
        { method: "snapshot", input: null },
        { method: "release", input: { threadId: "thr_q1" } },
        { method: "snapshot", input: null },
      ]),
    );
  });

  it("hides the up button on the first queue row and the down button on the last", async () => {
    const slot = renderPanel(handlers({ snapshot: () => GLM_SNAPSHOT }));
    await waitFor(() =>
      expect(slot.getByRole("button", { name: "Move up" })).toBeTruthy(),
    );

    expect(slot.getAllByRole("button", { name: "Move up" })).toHaveLength(1);
    expect(slot.getAllByRole("button", { name: "Move down" })).toHaveLength(1);
    expect(slot.getAllByRole("button", { name: "Release" })).toHaveLength(2);
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
      expect(slot.getByRole("button", { name: "Move up" })).toBeTruthy(),
    );

    fireEvent.click(slot.getByRole("button", { name: "Move up" }));

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
      expect(slot.getAllByRole("button", { name: "Release" })).toHaveLength(2),
    );

    fireEvent.click(slot.getAllByRole("button", { name: "Release" })[0]!);

    await waitFor(() =>
      expect(error).toHaveBeenCalledWith("Could not release the thread", {
        description: "already gone",
      }),
    );
  });

  it("sets a valid limit and refreshes", async () => {
    const slot = renderPanel(handlers({ snapshot: () => GLM_SNAPSHOT }));
    await waitFor(() => expect(slot.getByRole("spinbutton")).toBeTruthy());

    fireEvent.change(slot.getByRole("spinbutton"), {
      target: { value: "5" },
    });
    fireEvent.click(slot.getByRole("button", { name: "Set limit" }));

    await waitFor(() =>
      expect(slot.inspection.rpcCalls).toEqual([
        { method: "snapshot", input: null },
        { method: "setLimit", input: { providerId: "glm", limit: 5 } },
        { method: "snapshot", input: null },
      ]),
    );
  });

  it("rejects a negative limit without any rpc call", async () => {
    const error = vi.spyOn(toast, "error").mockReturnValue("toast");
    const slot = renderPanel(handlers({ snapshot: () => GLM_SNAPSHOT }));
    await waitFor(() => expect(slot.getByRole("spinbutton")).toBeTruthy());

    fireEvent.change(slot.getByRole("spinbutton"), {
      target: { value: "-1" },
    });
    fireEvent.click(slot.getByRole("button", { name: "Set limit" }));

    await waitFor(() =>
      expect(error).toHaveBeenCalledWith(
        "The limit must be a whole number of 0 or more",
      ),
    );
    expect(slot.inspection.rpcCalls).toEqual([{ method: "snapshot", input: null }]);
  });

  it("rejects a fractional limit without any rpc call", async () => {
    const error = vi.spyOn(toast, "error").mockReturnValue("toast");
    const slot = renderPanel(handlers({ snapshot: () => GLM_SNAPSHOT }));
    await waitFor(() => expect(slot.getByRole("spinbutton")).toBeTruthy());

    fireEvent.change(slot.getByRole("spinbutton"), {
      target: { value: "1.5" },
    });
    fireEvent.click(slot.getByRole("button", { name: "Set limit" }));

    await waitFor(() =>
      expect(error).toHaveBeenCalledWith(
        "The limit must be a whole number of 0 or more",
      ),
    );
    expect(slot.inspection.rpcCalls).toEqual([{ method: "snapshot", input: null }]);
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
    await waitFor(() => expect(slot.getByRole("spinbutton")).toBeTruthy());

    fireEvent.click(slot.getByRole("button", { name: "Set limit" }));

    await waitFor(() =>
      expect(error).toHaveBeenCalledWith("Could not set the limit", {
        description: "busy",
      }),
    );
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
          queueOrder: ["thr_q"],
        }),
      }),
      directoryWith([{ id: "rawprovider", displayName: "Raw Provider" }]),
    );

    await waitFor(() =>
      expect(slot.getAllByRole("heading", { level: 2 })).toHaveLength(3),
    );
    expect(
      slot
        .getAllByRole("heading", { level: 2 })
        .map((heading) => heading.textContent),
    ).toEqual(["GLM plan", "Raw Provider", "lonely"]);
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
