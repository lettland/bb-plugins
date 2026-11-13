// @vitest-environment jsdom

import { cleanup, waitFor } from "@testing-library/react";
import { useMemo } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  BbNavigate,
  PluginBrowserBbSdk,
  PluginThreadAction,
  PluginThreadActionTarget,
} from "@get-bb/plugin-sdk/app";
import {
  installTestPluginRuntime,
  renderSlot,
} from "@get-bb/plugin-sdk/testing/app";
import { makePluginProject, makeSidebarThread, sdkResult } from "../model/fixtures.js";

const hoisted = vi.hoisted(() => ({
  spaces: undefined as unknown,
  toastError: vi.fn(),
}));

vi.mock("sonner", async (importOriginal) => {
  const actual = await importOriginal<typeof import("sonner")>();
  return { ...actual, toast: { ...actual.toast, error: hoisted.toastError } };
});

vi.mock("@get-bb/plugin-sdk/app", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@get-bb/plugin-sdk/app")>();
  return {
    ...actual,
    experimental_useSidebarThreads: (
      ...args: Parameters<typeof actual.experimental_useSidebarThreads>
    ) => {
      const state = actual.experimental_useSidebarThreads(...args);
      const spaces = hoisted.spaces;
      return useMemo(
        () =>
          spaces === undefined ? state : { ...state, experimental_spaces: spaces },
        [state, spaces],
      );
    },
  };
});

installTestPluginRuntime();
const { experimental_useAppPanel, useBbNavigate, useSdk } =
  await import("@get-bb/plugin-sdk/app");
const { moveToSpaceAction } = await import("./moveToSpaceAction.js");

afterEach(() => {
  cleanup();
  hoisted.spaces = undefined;
  hoisted.toastError.mockClear();
});

function makeSpace(id: string, name: string) {
  return {
    id,
    name,
    brief: "",
    directory: `/spaces/${id}`,
    createdAt: 1,
    updatedAt: 1,
  };
}

function makeTarget(
  overrides: Partial<PluginThreadActionTarget> = {},
): PluginThreadActionTarget {
  return {
    id: "thr_move",
    projectId: "proj_test",
    parentThreadId: null,
    parentNotifications: "auto",
    archivedAt: null,
    pinnedAt: null,
    sectionId: null,
    isUnread: false,
    status: "idle",
    environment: null,
    ...overrides,
  };
}

interface Collected {
  item(thread: PluginThreadActionTarget): PluginThreadAction | null;
  bulkItem(
    threads: readonly PluginThreadActionTarget[],
  ): PluginThreadAction | null;
}

function Probe({ collected }: { collected: { current: Collected | null } }) {
  const useData = moveToSpaceAction.useData;
  if (useData === undefined) throw new Error("Move to Space reads its data");
  const data = useData({ threadIds: [] });
  const sdk: PluginBrowserBbSdk = useSdk();
  const navigate: BbNavigate = useBbNavigate();
  const experimental_panel = experimental_useAppPanel();
  collected.current = {
    item: (thread) =>
      moveToSpaceAction.item({ thread, data, sdk, navigate, experimental_panel }),
    bulkItem: (threads) =>
      moveToSpaceAction.experimental_bulkItem?.({
        threads,
        data,
        sdk,
        navigate,
        experimental_panel,
      }) ?? null,
  };
  return null;
}

function renderMove({
  spaces,
  spaceByThread = {},
  updateImpl = sdkResult({ ok: true }),
  ancestry = {},
}: {
  spaces: ReturnType<typeof makeSpace>[] | undefined;
  spaceByThread?: Record<string, string>;
  updateImpl?: (args: unknown) => Promise<unknown>;
  ancestry?: Record<string, string[]>;
}) {
  hoisted.spaces = spaces;
  const update = vi.fn(updateImpl);
  const collected: { current: Collected | null } = { current: null };
  const slot = renderSlot(
    { component: ({ children }: { children: React.ReactNode }) => <>{children}</> },
    { children: <Probe collected={collected} /> },
    {
      sidebarThreads: {
        threads: Object.entries(spaceByThread).map(([id, spaceId]) =>
          makeSidebarThread({ id, experimental_spaceId: spaceId }),
        ),
        projects: [makePluginProject()],
        sections: [],
      },
      sdk: {
        threads: {
          update: (args: unknown) => update(args) as Promise<never>,
          experimental_listAncestors: ({ threadIds }: { threadIds: readonly string[] }) =>
            Promise.resolve({
              threads: threadIds.map((threadId) => ({
                threadId,
                ancestorIds: ancestry[threadId] ?? [],
              })),
            }),
        },
      },
    },
  );
  const item = (thread: PluginThreadActionTarget) => {
    if (collected.current === null) throw new Error("Probe did not render");
    return collected.current.item(thread);
  };
  const bulkItem = (threads: readonly PluginThreadActionTarget[]) => {
    if (collected.current === null) throw new Error("Probe did not render");
    return collected.current.bulkItem(threads);
  };
  return { item, bulkItem, update, sdkCalls: slot.inspection.sdkCalls };
}

function run(action: PluginThreadAction | null, value: string) {
  if (action === null) throw new Error("Move to Space is hidden");
  return action.run({ value, requestRename: () => {} });
}

const SPACES = [makeSpace("spc_b", "Zeta"), makeSpace("spc_a", "Alpha")];

describe("Move to Space", () => {
  it("is hidden on a host without Spaces and when no Space exists", () => {
    expect(renderMove({ spaces: undefined }).item(makeTarget())).toBeNull();
    cleanup();
    expect(renderMove({ spaces: [] }).item(makeTarget())).toBeNull();
  });

  it.each([
    ["a child thread", makeTarget({ parentThreadId: "thr_parent" })],
    ["an archived thread", makeTarget({ archivedAt: 5 })],
  ])("is hidden for %s", async (_label, thread) => {
    const { item } = renderMove({ spaces: SPACES });
    await waitFor(() => expect(item(makeTarget())).not.toBeNull());
    expect(item(thread)).toBeNull();
  });

  it("lists every Space by name and omits No Space for a thread outside a Space", async () => {
    const { item } = renderMove({ spaces: SPACES });
    await waitFor(() =>
      expect(item(makeTarget())?.choices?.items).toEqual([
        { id: "spc_a", label: "Alpha", selected: false, disabled: false },
        { id: "spc_b", label: "Zeta", selected: false, disabled: false },
      ]),
    );
  });

  it("adds No Space and marks the current Space for a thread in a Space", async () => {
    const { item } = renderMove({
      spaces: SPACES,
      spaceByThread: { thr_move: "spc_b" },
    });
    await waitFor(() =>
      expect(item(makeTarget())?.choices?.items).toEqual([
        { id: "spc_a", label: "Alpha", selected: false, disabled: false },
        { id: "spc_b", label: "Zeta", selected: true, disabled: true },
        { id: "no-space", label: "No Space", selected: false, disabled: false },
      ]),
    );
  });

  it("moves a thread into a Space and out of it with spaceId", async () => {
    const { item, sdkCalls } = renderMove({
      spaces: SPACES,
      spaceByThread: { thr_move: "spc_b" },
    });
    await waitFor(() => expect(item(makeTarget())).not.toBeNull());
    run(item(makeTarget()), "spc_a");
    run(item(makeTarget()), "no-space");
    await waitFor(() =>
      expect(sdkCalls).toEqual([
        {
          method: "threads.update",
          args: [{ threadId: "thr_move", spaceId: "spc_a" }],
        },
        {
          method: "threads.update",
          args: [{ threadId: "thr_move", spaceId: null }],
        },
      ]),
    );
  });

  it("does nothing for the current Space or an unknown choice", async () => {
    const { item, update } = renderMove({
      spaces: SPACES,
      spaceByThread: { thr_move: "spc_b" },
    });
    await waitFor(() => expect(item(makeTarget())).not.toBeNull());
    run(item(makeTarget()), "spc_b");
    run(item(makeTarget()), "spc_missing");
    expect(update).not.toHaveBeenCalled();
  });

  it("shows the server's message when the move is rejected", async () => {
    const update = vi.fn(() =>
      Promise.reject({
        status: 400,
        message: "A project-less thread cannot move to another Space.",
      }),
    );
    const { item } = renderMove({ spaces: SPACES, updateImpl: update });
    await waitFor(() => expect(item(makeTarget())).not.toBeNull());
    run(item(makeTarget()), "spc_a");
    await waitFor(() =>
      expect(hoisted.toastError).toHaveBeenCalledWith(
        "A project-less thread cannot move to another Space.",
      ),
    );
  });
});

describe("Move to Space for a selection", () => {
  it("moves only the selected roots, once each", async () => {
    const { bulkItem, update } = renderMove({
      spaces: SPACES,
      ancestry: { child: ["parent"] },
    });
    await waitFor(() => expect(bulkItem([makeTarget({ id: "parent" })])).not.toBeNull());
    await run(
      bulkItem([
        makeTarget({ id: "parent" }),
        makeTarget({ id: "child", parentThreadId: "parent" }),
        makeTarget({ id: "other" }),
      ]),
      "spc_a",
    );
    expect(update.mock.calls).toEqual([
      [{ threadId: "parent", spaceId: "spc_a" }],
      [{ threadId: "other", spaceId: "spc_a" }],
    ]);
  });

  it("skips roots already in the target and reports a rejected move", async () => {
    const update = vi.fn(() =>
      Promise.reject({ status: 400, message: "Not allowed in this Space." }),
    );
    const { bulkItem } = renderMove({
      spaces: SPACES,
      spaceByThread: { in_space: "spc_a" },
      updateImpl: update,
    });
    await waitFor(() => expect(bulkItem([makeTarget({ id: "a" })])).not.toBeNull());
    await run(
      bulkItem([makeTarget({ id: "in_space" }), makeTarget({ id: "free" })]),
      "spc_a",
    );
    expect(update.mock.calls).toEqual([[{ threadId: "free", spaceId: "spc_a" }]]);
    expect(hoisted.toastError).toHaveBeenCalledWith("Not allowed in this Space.");
  });

  it("offers No Space when any selected thread is in a Space and marks a shared Space", async () => {
    const { bulkItem } = renderMove({
      spaces: SPACES,
      spaceByThread: { a: "spc_a", b: "spc_a" },
    });
    await waitFor(() =>
      expect(
        bulkItem([makeTarget({ id: "a" }), makeTarget({ id: "b" })])?.choices
          ?.items,
      ).toEqual([
        { id: "spc_a", label: "Alpha", selected: true, disabled: true },
        { id: "spc_b", label: "Zeta", selected: false, disabled: false },
        { id: "no-space", label: "No Space", selected: false, disabled: false },
      ]),
    );
  });
});
