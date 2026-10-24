// @vitest-environment jsdom

import { cleanup, waitFor } from "@testing-library/react";
import { useEffect } from "react";
import { toast } from "sonner";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import {
  useComposer,
  type PluginComposerApi,
  type PluginComposerScope,
} from "@get-bb/plugin-sdk/app";

const app = await loadPluginApp(() => import("./app"));

const customization = app.composerCustomizations[0]!;
const sendMenuItem = customization.sendMenu![0]!;

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

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("registration", () => {
  it("adds one send-menu entry to the new-thread composer only", () => {
    expect(app.composerCustomizations).toMatchObject([
      {
        id: "project-queue",
        scopes: ["new-thread"],
        sendMenu: [
          {
            id: "start-when-idle",
            label: "Start when project is idle",
            description:
              "Waits until no other thread in this project is running. Starts right away if none are.",
          },
        ],
      },
    ]);
    expect(customization.plusMenu).toBeUndefined();
    expect(customization.sendMenu).toHaveLength(1);
  });
});

describe("disabled state", () => {
  it("is enabled for a new thread in a regular project", () => {
    expect(
      isDisabled(
        fakeComposer({
          isSubmittingBlocked: false,
          scope: { kind: "new-thread", projectId: "proj_1" },
        }),
      ),
    ).toBe(false);
  });

  it("is disabled while submitting is blocked", () => {
    expect(
      isDisabled(
        fakeComposer({
          isSubmittingBlocked: true,
          scope: { kind: "new-thread", projectId: "proj_1" },
        }),
      ),
    ).toBe(true);
  });

  it("is disabled while the project is unresolved", () => {
    expect(
      isDisabled(
        fakeComposer({
          isSubmittingBlocked: false,
          scope: { kind: "new-thread", projectId: null },
        }),
      ),
    ).toBe(true);
  });

  it("is disabled for the personal project", () => {
    expect(
      isDisabled(
        fakeComposer({
          isSubmittingBlocked: false,
          scope: { kind: "new-thread", projectId: "proj_personal" },
        }),
      ),
    ).toBe(true);
  });

  it("is disabled outside the new-thread composer", () => {
    expect(
      isDisabled(
        fakeComposer({
          isSubmittingBlocked: false,
          scope: { kind: "thread", threadId: "thr_1" },
        }),
      ),
    ).toBe(true);
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
