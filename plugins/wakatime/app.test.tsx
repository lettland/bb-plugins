// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { installTestPluginRuntime, loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { WakatimeRpcContract, WakatimeStatus } from "./src/rpc-contract.js";

const BASE: WakatimeStatus = {
  cliPath: "/opt/wakatime-cli",
  lastHeartbeatAt: 1_700_000_000_000,
  lastSyncAt: null,
  lastError: null,
  unmatchedExcludes: [],
};

let statusSection: { component: React.ComponentType<object> };
let overlay: { component: React.ComponentType<object> };

beforeAll(async () => {
  installTestPluginRuntime();
  const app = await loadPluginApp(() => import("./app.js"));
  statusSection = app.settingsSections.find((section) => section.id === "status")!;
  overlay = app.appOverlays[0]!;
});

// Vitest globals are off, so Testing Library does not clean up by itself.
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

type Handler = () => WakatimeStatus | Promise<WakatimeStatus>;

function render(handler: Handler) {
  return renderSlot<object, WakatimeRpcContract>(statusSection, {}, { rpc: { heartbeat: () => ({ sent: false }), status: handler } });
}

describe("StatusPanel", () => {
  it("registers the overlay and the status section", async () => {
    const app = await loadPluginApp(() => import("./app.js"));
    expect(app.appOverlays.map((overlay) => overlay.id)).toEqual(["activity"]);
    expect(app.settingsSections.map((section) => section.id)).toEqual(["status"]);
  });

  it("shows the path, both successes and the unmatched excludes", async () => {
    render(() => ({ ...BASE, lastSyncAt: 1_700_000_100_000, unmatchedExcludes: ["ghost"] }));
    expect(await screen.findByText("/opt/wakatime-cli")).toBeTruthy();
    expect(screen.getByText("Last successful heartbeat")).toBeTruthy();
    expect(screen.getByText("Last successful AI sync")).toBeTruthy();
    expect(screen.getByText("ghost")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("labels the failed job, the problem and the exit code, in an alert span inside the dd", async () => {
    render(() => ({
      ...BASE,
      lastHeartbeatAt: null,
      lastError: { kind: "missing-cli", job: "heartbeat", exitCode: null, at: 1_700_000_200_000, problem: "not-executable" },
    }));
    const alert = await screen.findByRole("alert");
    expect(alert.tagName).toBe("SPAN");
    expect(alert.parentElement?.tagName).toBe("DD");
    expect(alert.textContent).toContain("wakatime-cli not found or not executable");
    expect(alert.textContent).toContain("the file is not executable");
    expect(alert.textContent).toContain("~/.wakatime/wakatime.log");
    expect(screen.getByText(/Last error \(heartbeat,/)).toBeTruthy();
  });

  it("labels a sync error with its job and exit code", async () => {
    render(() => ({ ...BASE, lastError: { kind: "config", job: "sync", exitCode: 103, at: 1_700_000_200_000 } }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("rejected its arguments or config");
    expect(alert.textContent).toContain("(exit 103)");
    expect(screen.getByText(/Last error \(AI sync,/)).toBeTruthy();
  });

  it("hides a sync error its own job has recovered from, whatever the heartbeat did", async () => {
    render(() => ({
      ...BASE,
      lastHeartbeatAt: 1_500_000_000_000,
      lastSyncAt: 1_700_000_000_000,
      lastError: { kind: "auth", job: "sync", exitCode: 104, at: 1_600_000_000_000 },
    }));
    await screen.findByText("/opt/wakatime-cli");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows a sync error newer than the sync's last success even if heartbeats are newer still", async () => {
    render(() => ({
      ...BASE,
      lastHeartbeatAt: 1_800_000_000_000,
      lastSyncAt: 1_500_000_000_000,
      lastError: { kind: "auth", job: "sync", exitCode: 104, at: 1_600_000_000_000 },
    }));
    expect((await screen.findByRole("alert")).textContent).toContain("authentication failed");
  });

  it("hides an error older than the job's last success", async () => {
    render(() => ({ ...BASE, lastError: { kind: "network", job: "heartbeat", exitCode: 112, at: 1_600_000_000_000 } }));
    await screen.findByText("/opt/wakatime-cli");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("calls status again on Refresh and shows the new state", async () => {
    let calls = 0;
    const view = render(() => {
      calls++;
      return calls === 1 ? BASE : { ...BASE, cliPath: "/opt/other-cli" };
    });
    await screen.findByText("/opt/wakatime-cli");
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(await screen.findByText("/opt/other-cli")).toBeTruthy();
    expect(view.rpcCalls.filter((call) => call.method === "status")).toHaveLength(2);
  });

  it("reads the status again when the window regains focus", async () => {
    const view = render(() => BASE);
    await screen.findByText("/opt/wakatime-cli");
    window.dispatchEvent(new Event("focus"));
    await waitFor(() => expect(view.rpcCalls.filter((call) => call.method === "status")).toHaveLength(2));
  });

  it("shows a failed Refresh next to the button and keeps the last good status", async () => {
    let calls = 0;
    render(() => {
      calls++;
      if (calls > 1) throw new Error("server unavailable");
      return BASE;
    });
    await screen.findByText("/opt/wakatime-cli");
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("Could not refresh: server unavailable");
    expect(screen.getByText("/opt/wakatime-cli")).toBeTruthy();
  });

  it("offers Retry when the first load fails", async () => {
    let calls = 0;
    render(() => {
      calls++;
      if (calls === 1) throw new Error("boom");
      return BASE;
    });
    expect((await screen.findByRole("alert")).textContent).toContain("Could not load status: boom");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.getByText("/opt/wakatime-cli")).toBeTruthy());
  });
});

describe("ActivityOverlay", () => {
  let attempts = 0;

  function renderOverlay(context: { projectId?: string | null; threadId?: string | null }, fail = false) {
    attempts = 0;
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    return renderSlot<object, WakatimeRpcContract>(
      overlay,
      {},
      {
        context,
        rpc: {
          heartbeat: () => {
            attempts++;
            if (fail) throw new Error("server unavailable");
            return { sent: true };
          },
          status: () => BASE,
        },
      },
    );
  }

  it("renders nothing and reports activity with the ids of the current view", async () => {
    const view = renderOverlay({ projectId: "prj_1", threadId: "thr_1" });
    expect(view.container.innerHTML).toBe("");
    window.dispatchEvent(new Event("keydown"));
    await waitFor(() => expect(view.rpcCalls).toHaveLength(1));
    expect(view.rpcCalls[0]).toEqual({ method: "heartbeat", input: { projectId: "prj_1", threadId: "thr_1" } });
  });

  it("sends no ids for a view that has none, and swallows a failed heartbeat", async () => {
    const view = renderOverlay({}, true);
    window.dispatchEvent(new Event("wheel"));
    await waitFor(() => expect(attempts).toBe(1));
    // Flush the rejected call; vitest fails the run on an unhandled rejection.
    await act(async () => {});
    expect(view.container.innerHTML).toBe("");
  });

  it("sends an empty heartbeat for a view with no ids", async () => {
    const view = renderOverlay({});
    window.dispatchEvent(new Event("keydown"));
    await waitFor(() => expect(view.rpcCalls).toHaveLength(1));
    expect(view.rpcCalls[0]!.input).toEqual({});
  });

  it("stops listening when it unmounts", async () => {
    const view = renderOverlay({ projectId: "prj_1" });
    view.unmount();
    window.dispatchEvent(new Event("keydown"));
    await act(async () => {});
    expect(view.rpcCalls).toHaveLength(0);
  });
});
