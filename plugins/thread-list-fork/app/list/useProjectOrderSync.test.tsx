// @vitest-environment jsdom

import { act, cleanup } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectSort } from "../../shared/preferences.js";
import {
  installTestPluginRuntime,
  renderSlot,
} from "@get-bb/plugin-sdk/testing/app";
import { makeSidebarProject } from "../model/fixtures.js";
import type { ProjectGroupLayoutEntry } from "../model/project-groups.js";
import type { SidebarSectionId } from "../model/sidebar-section-id.js";
import { useProjectOrderSync } from "./useProjectOrderSync.js";

installTestPluginRuntime();

interface ProbeProps {
  layout: readonly ProjectGroupLayoutEntry[];
  projectIds: readonly string[];
  projectSort: ProjectSort;
}

function Probe({ layout, projectIds, projectSort }: ProbeProps) {
  useProjectOrderSync({
    layout,
    projects: [
      makeSidebarProject({ id: "personal", isPersonal: true }),
      ...projectIds.map((id) => makeSidebarProject({ id })),
    ],
    projectSort,
  });
  return null;
}

function layoutOf(...projectIds: string[]): ProjectGroupLayoutEntry[] {
  return projectIds.map((id) => ({
    kind: "section",
    sectionId: `project:${id}` as SidebarSectionId,
  }));
}

const DEFAULT_PROPS: ProbeProps = {
  layout: layoutOf("c", "a", "b"),
  projectIds: ["a", "b", "c"],
  projectSort: "custom",
};

function mount(
  props: Partial<ProbeProps>,
  reorder: (args: unknown) => Promise<never[]> = async () => [],
) {
  const reorderSpy = vi.fn(reorder);
  const slot = renderSlot(
    { component: Probe },
    { ...DEFAULT_PROPS, ...props },
    { sdk: { projects: { reorder: reorderSpy } } },
  );
  return Object.assign(reorderSpy, {
    update: (next: Partial<ProbeProps>) =>
      slot.rerender(<Probe {...DEFAULT_PROPS} {...next} />),
  });
}

function httpError(status: number) {
  return Object.assign(new Error(`HTTP ${status}`), { status });
}

async function elapse(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

let visibility: DocumentVisibilityState;
let focused: boolean;
let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.useFakeTimers();
  visibility = "visible";
  focused = true;
  vi.spyOn(document, "visibilityState", "get").mockImplementation(
    () => visibility,
  );
  vi.spyOn(document, "hasFocus").mockImplementation(() => focused);
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("useProjectOrderSync", () => {
  it("writes the displayed order once after the debounce", async () => {
    const reorder = mount({});
    await elapse(999);
    expect(reorder).not.toHaveBeenCalled();
    await elapse(1);
    expect(reorder).toHaveBeenCalledTimes(1);
    expect(reorder).toHaveBeenCalledWith({
      projectId: "c",
      previousProjectId: null,
      nextProjectId: "a",
    });
    await elapse(5000);
    expect(reorder).toHaveBeenCalledTimes(1);
  });

  it("applies the moves of a batch one after another", async () => {
    let release: () => void = () => {};
    const reorder = mount(
      { layout: layoutOf("a", "b", "c"), projectIds: ["c", "b", "a"] },
      () =>
        new Promise((resolve) => {
          release = () => resolve([]);
        }),
    );
    await elapse(1000);
    expect(reorder).toHaveBeenCalledTimes(1);
    await elapse(5000);
    expect(reorder).toHaveBeenCalledTimes(1);
    await act(async () => release());
    expect(reorder).toHaveBeenCalledTimes(2);
    await act(async () => release());
    expect(warn).not.toHaveBeenCalled();
  });

  it("makes no call when the server order already matches", async () => {
    const reorder = mount({ layout: layoutOf("a", "b", "c") });
    await elapse(5000);
    expect(reorder).not.toHaveBeenCalled();
  });

  it("makes no call for the activity sort", async () => {
    const reorder = mount({ projectSort: "activity" });
    await elapse(5000);
    expect(reorder).not.toHaveBeenCalled();
  });

  it("waits while the window is hidden and resumes when it is visible", async () => {
    visibility = "hidden";
    const reorder = mount({});
    await elapse(5000);
    expect(reorder).not.toHaveBeenCalled();
    visibility = "visible";
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await elapse(1000);
    expect(reorder).toHaveBeenCalledTimes(1);
  });

  it("waits while the window is unfocused and resumes on focus", async () => {
    focused = false;
    const reorder = mount({});
    await elapse(5000);
    expect(reorder).not.toHaveBeenCalled();
    focused = true;
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    await elapse(1000);
    expect(reorder).toHaveBeenCalledTimes(1);
  });

  it("cancels a pending write when the window loses focus", async () => {
    const reorder = mount({});
    await elapse(500);
    focused = false;
    await act(async () => {
      window.dispatchEvent(new Event("blur"));
    });
    await elapse(5000);
    expect(reorder).not.toHaveBeenCalled();
  });

  it("stops the batch on each 409 without logging", async () => {
    const reorder = mount(
      { layout: layoutOf("a", "b", "c"), projectIds: ["c", "b", "a"] },
      async () => {
        throw httpError(409);
      },
    );
    await elapse(1000);
    await elapse(5000);
    expect(reorder).toHaveBeenCalledTimes(2);
    expect(reorder.mock.calls[1]).toEqual(reorder.mock.calls[0]);
    expect(warn).not.toHaveBeenCalled();
  });

  it("retries a 409 once after the debounce and then stops", async () => {
    const reorder = mount({}, async () => {
      throw httpError(409);
    });
    await elapse(1000);
    expect(reorder).toHaveBeenCalledTimes(1);
    await elapse(999);
    expect(reorder).toHaveBeenCalledTimes(1);
    await elapse(1);
    expect(reorder).toHaveBeenCalledTimes(2);
    await elapse(10000);
    expect(reorder).toHaveBeenCalledTimes(2);
    expect(warn).not.toHaveBeenCalled();
  });

  it("runs a new plan after a 409 and gives it its own retry", async () => {
    const reorder = mount({}, async () => {
      throw httpError(409);
    });
    await elapse(1000);
    expect(reorder).toHaveBeenCalledTimes(1);
    reorder.update({ layout: layoutOf("b", "a", "c") });
    await elapse(1000);
    expect(reorder).toHaveBeenCalledTimes(2);
    expect(reorder).toHaveBeenLastCalledWith({
      projectId: "b",
      previousProjectId: null,
      nextProjectId: "a",
    });
    await elapse(1000);
    expect(reorder).toHaveBeenCalledTimes(3);
    await elapse(10000);
    expect(reorder).toHaveBeenCalledTimes(3);
  });

  it("logs another HTTP error once, stops the batch, and does not retry", async () => {
    const reorder = mount(
      { layout: layoutOf("a", "b", "c"), projectIds: ["c", "b", "a"] },
      async () => {
        throw httpError(500);
      },
    );
    await elapse(1000);
    await elapse(5000);
    expect(reorder).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      "Could not sync the project order to bb",
      expect.any(String),
      500,
    );
  });

  it.each([
    ["an error without a status", new TypeError("secret body"), "TypeError"],
    ["a thrown string", "secret body", "unknown"],
  ])("logs only the error kind for %s", async (_label, thrown, kind) => {
    mount({}, async () => {
      throw thrown;
    });
    await elapse(1000);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      "Could not sync the project order to bb",
      "c",
      kind,
    );
  });
});
