// @vitest-environment jsdom

import { useMemo, type ReactNode } from "react";
import {
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { createStore, Provider } from "jotai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  installTestPluginRuntime,
  renderSlot,
  type PluginSdkTestFakes,
} from "@get-bb/plugin-sdk/testing/app";
import {
  makePluginProject,
  makeSidebarThread,
  sdkResult,
  type SidebarThreadOverrides,
} from "../model/fixtures.js";
import { preferencesReadyAtom } from "../preferences/preferences-sync.js";
import {
  collapsedProjectIdsAtom,
  sidebarHiddenGroupsAtom,
  sidebarMachineSectionOrderAtom,
  sidebarManualSectionOrderAtom,
  sidebarOrganizationModeAtom,
  sidebarSectionOrderAtom,
} from "../preferences/atoms.js";
import type { OrganizationMode } from "../../shared/preferences.js";

const spacesState = vi.hoisted(() => ({ spaces: undefined as unknown }));
const toastError = vi.hoisted(() => vi.fn());

vi.mock("sonner", async (importOriginal) => {
  const actual = await importOriginal<typeof import("sonner")>();
  return { ...actual, toast: { ...actual.toast, error: toastError } };
});

vi.mock("@get-bb/plugin-sdk/app", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@get-bb/plugin-sdk/app")>();
  return {
    ...actual,
    experimental_useSidebarThreads: (
      ...args: Parameters<typeof actual.experimental_useSidebarThreads>
    ) => {
      const state = actual.experimental_useSidebarThreads(...args);
      const spaces = spacesState.spaces;
      return useMemo(
        () => (spaces === undefined ? state : { ...state, experimental_spaces: spaces }),
        [state, spaces],
      );
    },
  };
});

installTestPluginRuntime();
const { ProjectList } = await import("./ProjectList.js");
const { resetSidebarDataCacheForTest } =
  await import("../model/use-sidebar-data.js");

afterEach(() => {
  cleanup();
  resetSidebarDataCacheForTest();
  spacesState.spaces = undefined;
});

function Harness({
  children,
  store,
}: {
  children: ReactNode;
  store: ReturnType<typeof createStore>;
}) {
  return (
    <TooltipProvider>
      <Provider store={store}>{children}</Provider>
    </TooltipProvider>
  );
}

function makeSpace(
  id: string,
  name: string,
  brief = "",
  archivedAt: number | null = null,
) {
  return {
    id,
    name,
    brief,
    directory: `/spaces/${id}`,
    createdAt: 1,
    updatedAt: 1,
    archivedAt,
  };
}

interface SpacesSdkFake {
  create: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
}

function makeSpacesSdk(): SpacesSdkFake {
  return {
    create: vi.fn(sdkResult(makeSpace("spc_new", "Created"))),
    update: vi.fn(sdkResult(makeSpace("spc_1", "Payments"))),
  };
}

interface RenderOptions {
  mode: OrganizationMode;
  threads: SidebarThreadOverrides[];
  spaces?: ReturnType<typeof makeSpace>[] | null;
  spacesSdk?: SpacesSdkFake;
  setup?: (store: ReturnType<typeof createStore>) => void;
}

function renderSidebar({
  mode,
  threads,
  spaces = [makeSpace("spc_1", "Payments")],
  spacesSdk = makeSpacesSdk(),
  setup,
}: RenderOptions) {
  const store = createStore();
  store.set(preferencesReadyAtom(), true);
  store.set(sidebarOrganizationModeAtom, mode);
  setup?.(store);
  spacesState.spaces = spaces === null ? undefined : spaces;
  const sdk: PluginSdkTestFakes & { experimental_spaces?: SpacesSdkFake } = {
    threads: { update: sdkResult({ ok: true }) },
    ...(spaces === null ? {} : { experimental_spaces: spacesSdk }),
  };
  const rendered = renderSlot(
    { component: Harness },
    { children: <ProjectList activeThreadId={null} />, store },
    {
      sidebarThreads: {
        threads: threads.map((overrides) => makeSidebarThread(overrides)),
        experimental_hosts: [{ id: "host_a", name: "Studio" }],
        projects: [
          makePluginProject({ id: "proj_a", name: "Apps" }),
          makePluginProject({
            id: "proj_personal",
            name: "Personal",
            isPersonal: true,
          }),
        ],
        sections: [{ id: "sec_a", name: "Backlog", createdAt: 1, updatedAt: 1 }],
      },
      sdk: sdk as PluginSdkTestFakes,
    },
  );
  return { ...rendered, store, spacesSdk };
}

const HOST = { id: "host_a", name: "Studio" };

const MIXED_THREADS: SidebarThreadOverrides[] = [
  {
    id: "thr_space",
    title: "Space thread",
    displayTitle: "Space thread",
    projectId: "proj_a",
    sectionId: "sec_a",
    host: HOST,
    experimental_spaceId: "spc_1",
  },
  {
    id: "thr_child",
    title: "Space child",
    displayTitle: "Space child",
    projectId: "proj_a",
    parentThreadId: "thr_space",
    host: HOST,
    experimental_spaceId: "spc_1",
  },
  {
    id: "thr_plain",
    title: "Plain thread",
    displayTitle: "Plain thread",
    projectId: "proj_a",
    host: HOST,
  },
];

function spaceGroup(spaceId = "spc_1"): HTMLElement {
  const element = document.querySelector<HTMLElement>(
    `[data-sidebar-space-id="${spaceId}"]`,
  );
  if (element === null) throw new Error(`no Space group ${spaceId}`);
  return element;
}

const MODES: OrganizationMode[] = ["project", "chronological", "machine"];
const HEADER_ACTIONS: Record<OrganizationMode, string> = {
  project: "Apps actions",
  chronological: "Threads actions",
  machine: "Studio actions",
};

describe.each(MODES)("Space groups in %s mode", (mode) => {
  it("shows a Space thread and its child only in the Space group, nested", async () => {
    renderSidebar({ mode, threads: MIXED_THREADS });
    await screen.findByText("Plain thread");
    const group = spaceGroup();
    expect(within(group).getByText("Payments")).not.toBeNull();
    expect(within(group).getByText("Space thread")).not.toBeNull();
    expect(within(group).getByText("Space child")).not.toBeNull();
    expect(screen.getAllByText("Space thread")).toHaveLength(1);
    expect(screen.getAllByText("Space child")).toHaveLength(1);
    expect(within(group).queryByText("Plain thread")).toBeNull();
    const rowIds = Array.from(
      group.querySelectorAll<HTMLElement>("[data-sidebar-thread-id]"),
      (element) => element.dataset.sidebarThreadId,
    );
    expect(rowIds).toEqual(["thr_space", "thr_child"]);
    const indent = (id: string) =>
      group
        .querySelector<HTMLElement>(`[data-sidebar-thread-id="${id}"]`)
        ?.closest<HTMLElement>("[style*='padding-left']")?.style.paddingLeft;
    expect(indent("thr_child")).not.toBe(indent("thr_space"));
  });

  it("starts a thread in the Space with the personal project", async () => {
    const { inspection } = renderSidebar({ mode, threads: MIXED_THREADS });
    fireEvent.click(
      await screen.findByRole("button", { name: "New thread in Payments" }),
    );
    expect(inspection.navigateCalls).toContainEqual({
      method: "toCompose",
      options: {
        projectId: "proj_personal",
        placement: {
          sectionId: null,
          pinned: false,
          experimental_spaceId: "spc_1",
        },
        focusPrompt: true,
      },
    });
  });

  it("shows an empty Space and collapses it under a space:<id> key", async () => {
    const { store } = renderSidebar({ mode, threads: [] });
    await screen.findByText("Payments");
    expect(within(spaceGroup()).getByText("No threads")).not.toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: "Collapse Payments section" }),
    );
    await waitFor(() =>
      expect(store.get(collapsedProjectIdsAtom)).toEqual(["space:spc_1"]),
    );
    expect(within(spaceGroup()).queryByText("No threads")).toBeNull();
  });

  it("moves a hidden Space group into More", async () => {
    renderSidebar({
      mode,
      threads: MIXED_THREADS,
      setup: (store) => store.set(sidebarHiddenGroupsAtom, ["space:spc_1"]),
    });
    await screen.findByText("Plain thread");
    expect(document.querySelector("[data-sidebar-space-id]")).toBeNull();
    expect(screen.queryByText("Space thread")).toBeNull();
    const more = screen.getByRole("button", { name: /^More / });
    fireEvent.keyDown(more, { key: "Enter" });
    expect(await screen.findByRole("menuitem", { name: /Payments/ })).not.toBeNull();
  });

  it("keeps a pinned Space thread in Pinned only, like a pinned project thread", async () => {
    renderSidebar({
      mode,
      threads: [
        ...MIXED_THREADS.filter((thread) => thread.id !== "thr_space"),
        {
          id: "thr_pinned",
          title: "Pinned space thread",
          displayTitle: "Pinned space thread",
          projectId: "proj_a",
          host: HOST,
          pinnedAt: 5,
          experimental_spaceId: "spc_1",
        },
        {
          id: "thr_pinned_plain",
          title: "Pinned project thread",
          displayTitle: "Pinned project thread",
          projectId: "proj_a",
          host: HOST,
          pinnedAt: 6,
        },
      ],
    });
    await screen.findByText("Pinned space thread");
    expect(screen.getAllByText("Pinned space thread")).toHaveLength(1);
    expect(screen.getAllByText("Pinned project thread")).toHaveLength(1);
    expect(
      within(spaceGroup()).queryByText("Pinned space thread"),
    ).toBeNull();
    const pinnedSection = document.querySelector<HTMLElement>(
      '[data-sidebar-section-id="pinned"], [data-sidebar-visibility-group]',
    );
    expect(pinnedSection).not.toBeNull();
    const pinnedThread = screen
      .getByText("Pinned space thread")
      .closest("[data-sidebar-section-id]");
    const pinnedProjectThread = screen
      .getByText("Pinned project thread")
      .closest("[data-sidebar-section-id]");
    expect(pinnedThread).toBe(pinnedProjectThread);
  });
});

describe("Space ordering", () => {
  it("shows Spaces right after Pinned for a stored order from before Spaces", async () => {
    renderSidebar({
      mode: "project",
      threads: [
        ...MIXED_THREADS,
        {
          id: "thr_pin",
          title: "Pin",
          displayTitle: "Pin",
          projectId: "proj_a",
          pinnedAt: 3,
        },
      ],
      spaces: [makeSpace("spc_b", "Zeta"), makeSpace("spc_1", "Alpha")],
      setup: (store) =>
        store.set(sidebarSectionOrderAtom, ["pinned", "projects", "threads"]),
    });
    await screen.findByText("Plain thread");
    const positions = [
      screen.getByTitle("Pinned"),
      spaceGroup("spc_1"),
      spaceGroup("spc_b"),
      screen.getByTitle("Apps"),
    ];
    for (let index = 1; index < positions.length; index += 1) {
      const previous = positions[index - 1];
      const current = positions[index];
      expect(
        previous?.compareDocumentPosition(current as Node) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    }
  });

  it("drops a stored Space id that no longer exists without hiding anything else", async () => {
    renderSidebar({
      mode: "machine",
      threads: MIXED_THREADS,
      setup: (store) =>
        store.set(sidebarMachineSectionOrderAtom, [
          "pinned",
          "space:gone",
          "machines",
          "threads",
        ]),
    });
    await screen.findByText("Plain thread");
    expect(document.querySelectorAll("[data-sidebar-space-id]")).toHaveLength(1);
    expect(screen.getByText("Studio")).not.toBeNull();
  });
});

describe("a host without Spaces", () => {
  it.each(MODES)("renders %s mode as before", async (mode) => {
    renderSidebar({ mode, threads: MIXED_THREADS, spaces: null });
    await screen.findByText("Plain thread");
    expect(screen.getByText("Space thread")).not.toBeNull();
    expect(document.querySelector("[data-sidebar-space-id]")).toBeNull();
    fireEvent.pointerDown(
      await screen.findByRole("button", { name: HEADER_ACTIONS[mode] }),
      { button: 0 },
    );
    expect(await screen.findByRole("menuitem", { name: "New section" })).not.toBeNull();
  });
});

describe("Space actions", () => {
  it("creates a Space with name and brief and places it after Pinned in the current mode", async () => {
    const { spacesSdk, store } = renderSidebar({
      mode: "chronological",
      threads: [],
      setup: (store) =>
        store.set(sidebarManualSectionOrderAtom, ["pinned", "sections", "threads"]),
    });
    fireEvent.pointerDown(
      await screen.findByRole("button", { name: "Threads actions" }),
      { button: 0 },
    );
    fireEvent.click(await screen.findByRole("menuitem", { name: "New Space…" }));
    fireEvent.change(await screen.findByRole("textbox", { name: "Space name" }), {
      target: { value: "  Roadmap " },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "Brief (optional)" }), {
      target: { value: "Ship it" },
    });
    expect(screen.getByTestId("space-brief-counter").textContent).toBe("7 / 20000");
    fireEvent.click(screen.getByRole("button", { name: "Create Space" }));
    await waitFor(() =>
      expect(spacesSdk.create).toHaveBeenCalledWith({
        name: "Roadmap",
        brief: "Ship it",
      }),
    );
    await waitFor(() =>
      expect(store.get(sidebarManualSectionOrderAtom)).toEqual([
        "pinned",
        "space:spc_new",
        "sections",
        "threads",
      ]),
    );
  });

  it("requires a name and omits an empty brief", async () => {
    const { spacesSdk } = renderSidebar({ mode: "project", threads: [] });
    fireEvent.pointerDown(
      await screen.findByRole("button", { name: "Apps actions" }),
      { button: 0 },
    );
    fireEvent.click(await screen.findByRole("menuitem", { name: "New Space…" }));
    fireEvent.click(await screen.findByRole("button", { name: "Create Space" }));
    expect(await screen.findByText("Space name cannot be empty.")).not.toBeNull();
    expect(spacesSdk.create).not.toHaveBeenCalled();
    fireEvent.change(screen.getByRole("textbox", { name: "Space name" }), {
      target: { value: "Plain" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create Space" }));
    await waitFor(() =>
      expect(spacesSdk.create).toHaveBeenCalledWith({ name: "Plain" }),
    );
  });

  it("shows a create conflict in the dialog", async () => {
    const spacesSdk = makeSpacesSdk();
    spacesSdk.create.mockRejectedValueOnce({
      status: 409,
      code: "space_name_conflict",
      message: "conflict",
    });
    renderSidebar({ mode: "project", threads: [], spacesSdk });
    fireEvent.pointerDown(
      await screen.findByRole("button", { name: "Apps actions" }),
      { button: 0 },
    );
    fireEvent.click(await screen.findByRole("menuitem", { name: "New Space…" }));
    fireEvent.change(await screen.findByRole("textbox", { name: "Space name" }), {
      target: { value: "Payments" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create Space" }));
    expect(
      await screen.findByText("A Space with this name already exists."),
    ).not.toBeNull();
  });

  it("renames inline and shows a 409 as a name conflict", async () => {
    const spacesSdk = makeSpacesSdk();
    spacesSdk.update.mockRejectedValueOnce({
      status: 409,
      code: "space_name_conflict",
      message: "conflict",
    });
    renderSidebar({ mode: "project", threads: MIXED_THREADS, spacesSdk });
    fireEvent.doubleClick(await screen.findByTitle("Payments"));
    const input = await screen.findByRole("textbox", { name: "Space name" });
    fireEvent.change(input, { target: { value: "Taken" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() =>
      expect(spacesSdk.update).toHaveBeenCalledWith({
        id: "spc_1",
        name: "Taken",
      }),
    );
    expect(
      await screen.findByText("A Space with this name already exists."),
    ).not.toBeNull();
  });

  it("renames from the header menu", async () => {
    const { spacesSdk } = renderSidebar({
      mode: "project",
      threads: MIXED_THREADS,
    });
    fireEvent.pointerDown(
      await screen.findByRole("button", { name: "Payments actions" }),
      { button: 0 },
    );
    fireEvent.click(await screen.findByRole("menuitem", { name: "Rename…" }));
    const input = await screen.findByRole("textbox", { name: "Space name" });
    fireEvent.change(input, { target: { value: "Billing" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() =>
      expect(spacesSdk.update).toHaveBeenCalledWith({
        id: "spc_1",
        name: "Billing",
      }),
    );
  });

  it("edits the brief with a counter and shows server errors in the dialog", async () => {
    const spacesSdk = makeSpacesSdk();
    spacesSdk.update.mockRejectedValueOnce({
      status: 400,
      message: "Brief rejected by the safety check.",
    });
    renderSidebar({
      mode: "project",
      threads: MIXED_THREADS,
      spaces: [makeSpace("spc_1", "Payments", "Old brief")],
      spacesSdk,
    });
    fireEvent.pointerDown(
      await screen.findByRole("button", { name: "Payments actions" }),
      { button: 0 },
    );
    fireEvent.click(await screen.findByRole("menuitem", { name: "Edit brief…" }));
    const textarea = await screen.findByRole("textbox", {
      name: "Brief for Payments",
    });
    expect((textarea as HTMLTextAreaElement).value).toBe("Old brief");
    expect(screen.getByTestId("space-brief-counter").textContent).toBe(
      "9 / 20000",
    );
    expect((textarea as HTMLTextAreaElement).maxLength).toBe(20000);
    fireEvent.change(textarea, { target: { value: "New brief" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(spacesSdk.update).toHaveBeenCalledWith({
        id: "spc_1",
        brief: "New brief",
      }),
    );
    expect(
      await screen.findByText("Brief rejected by the safety check."),
    ).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(spacesSdk.update).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(
        screen.queryByRole("textbox", { name: "Brief for Payments" }),
      ).toBeNull(),
    );
  });

  it("cancels the brief dialog without saving", async () => {
    const { spacesSdk } = renderSidebar({
      mode: "project",
      threads: MIXED_THREADS,
    });
    fireEvent.pointerDown(
      await screen.findByRole("button", { name: "Payments actions" }),
      { button: 0 },
    );
    fireEvent.click(await screen.findByRole("menuitem", { name: "Edit brief…" }));
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    await waitFor(() =>
      expect(
        screen.queryByRole("textbox", { name: "Brief for Payments" }),
      ).toBeNull(),
    );
    expect(spacesSdk.update).not.toHaveBeenCalled();
  });

  it("archives a Space", async () => {
    const { spacesSdk } = renderSidebar({
      mode: "project",
      threads: MIXED_THREADS,
    });
    fireEvent.pointerDown(
      await screen.findByRole("button", { name: "Payments actions" }),
      { button: 0 },
    );
    expect(screen.queryByRole("menuitem", { name: "Delete Space…" })).toBeNull();
    fireEvent.click(await screen.findByRole("menuitem", { name: "Archive Space" }));
    await waitFor(() =>
      expect(spacesSdk.update).toHaveBeenCalledWith({
        id: "spc_1",
        archived: true,
      }),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("unarchives an archived Space", async () => {
    const { spacesSdk } = renderSidebar({
      mode: "project",
      threads: MIXED_THREADS,
      spaces: [makeSpace("spc_1", "Payments", "", 5)],
    });
    fireEvent.pointerDown(
      await screen.findByRole("button", { name: "Payments actions" }),
      { button: 0 },
    );
    expect(screen.queryByRole("menuitem", { name: "Archive Space" })).toBeNull();
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Unarchive Space" }),
    );
    await waitFor(() =>
      expect(spacesSdk.update).toHaveBeenCalledWith({
        id: "spc_1",
        archived: false,
      }),
    );
  });

  it("archives and unarchives from the context menu", async () => {
    const archive = renderSidebar({ mode: "project", threads: MIXED_THREADS });
    fireEvent.contextMenu(await screen.findByText("Payments"));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Archive Space" }));
    await waitFor(() =>
      expect(archive.spacesSdk.update).toHaveBeenCalledWith({
        id: "spc_1",
        archived: true,
      }),
    );
    archive.unmount();
    const restore = renderSidebar({
      mode: "project",
      threads: MIXED_THREADS,
      spaces: [makeSpace("spc_1", "Payments", "", 5)],
    });
    fireEvent.contextMenu(await screen.findByText("Payments (archived)"));
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Unarchive Space" }),
    );
    await waitFor(() =>
      expect(restore.spacesSdk.update).toHaveBeenCalledWith({
        id: "spc_1",
        archived: false,
      }),
    );
  });

  it("shows a toast when archiving fails", async () => {
    const spacesSdk = makeSpacesSdk();
    spacesSdk.update.mockRejectedValueOnce(new Error("boom"));
    renderSidebar({ mode: "project", threads: MIXED_THREADS, spacesSdk });
    fireEvent.pointerDown(
      await screen.findByRole("button", { name: "Payments actions" }),
      { button: 0 },
    );
    fireEvent.click(await screen.findByRole("menuitem", { name: "Archive Space" }));
    await waitFor(() => expect(spacesSdk.update).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(toastError).toHaveBeenCalled());
  });
});

describe("an archived Space group", () => {
  it("has no new-thread control and shows the (archived) label, unlike an active Space", async () => {
    renderSidebar({
      mode: "project",
      threads: MIXED_THREADS,
      spaces: [
        makeSpace("spc_1", "Payments", "", 5),
        makeSpace("spc_2", "Growth"),
      ],
    });
    expect(await screen.findByText("Payments (archived)")).not.toBeNull();
    expect(screen.queryByText("Growth (archived)")).toBeNull();
    expect(
      screen.queryByRole("button", { name: "New thread in Payments" }),
    ).toBeNull();
    expect(
      screen.getByRole("button", { name: "New thread in Growth" }),
    ).not.toBeNull();
    expect(
      within(spaceGroup("spc_1")).queryByRole("button", {
        name: "New thread in Payments",
      }),
    ).toBeNull();
  });

  it.each([
    ["an active", null, true],
    ["an archived", 5, false],
  ])("offers New thread in More only for %s empty Space", async (_label, archivedAt, offered) => {
    renderSidebar({
      mode: "project",
      threads: [],
      spaces: [makeSpace("spc_1", "Payments", "", archivedAt)],
      setup: (store) => store.set(sidebarHiddenGroupsAtom, ["space:spc_1"]),
    });
    const more = await screen.findByRole("button", { name: /^More / });
    fireEvent.keyDown(more, { key: "Enter" });
    fireEvent.click(await screen.findByRole("menuitem", { name: /Payments/ }));
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "New thread" }) !== null,
      ).toBe(offered),
    );
  });
});
