import { describe, expect, it, vi } from "vitest";
import type {
  PluginBrowserBbSdk,
  PluginSidebarThread,
  PluginSidebarThreadsState,
} from "@get-bb/plugin-sdk/app";
import {
  readSidebarSpaces,
  readSpacesArea,
  readThreadSpaceId,
  updateThreadSpace,
} from "../../fork-sdk-types.js";
import { makeSidebarThread } from "./fixtures.js";

function stateWith(spaces: unknown): PluginSidebarThreadsState {
  return {
    status: "ready",
    threads: [],
    projects: [],
    sections: [],
    experimental_archived: null,
    ...(spaces === undefined ? {} : { experimental_spaces: spaces }),
  } as PluginSidebarThreadsState;
}

const SPACE = {
  id: "spc_1",
  name: "Payments",
  brief: "",
  directory: "/spaces/spc_1",
  createdAt: 1,
  updatedAt: 2,
  briefUpdatedBy: "someone",
};

describe("readThreadSpaceId", () => {
  it("reads a string Space id and treats everything else as no Space", () => {
    expect(
      readThreadSpaceId(makeSidebarThread({ experimental_spaceId: "spc_1" })),
    ).toBe("spc_1");
    expect(
      readThreadSpaceId(makeSidebarThread({ experimental_spaceId: null })),
    ).toBeNull();
    expect(readThreadSpaceId(makeSidebarThread())).toBeNull();
    expect(
      readThreadSpaceId({
        ...makeSidebarThread(),
        experimental_spaceId: 7,
      } as unknown as PluginSidebarThread),
    ).toBeNull();
    expect(
      readThreadSpaceId({
        ...makeSidebarThread(),
        experimental_spaceId: "",
      } as unknown as PluginSidebarThread),
    ).toBeNull();
  });
});

describe("readSidebarSpaces", () => {
  it("returns the same list for the same host payload and strips extra fields", () => {
    const raw = [SPACE];
    const state = stateWith(raw);
    const first = readSidebarSpaces(state);
    expect(readSidebarSpaces(stateWith(raw))).toBe(first);
    expect(first).toEqual([
      {
        id: "spc_1",
        name: "Payments",
        brief: "",
        directory: "/spaces/spc_1",
        createdAt: 1,
        updatedAt: 2,
      },
    ]);
  });

  it("treats a missing or non-array field as no Spaces and skips malformed entries", () => {
    expect(readSidebarSpaces(stateWith(undefined))).toEqual([]);
    expect(readSidebarSpaces(stateWith("nope"))).toEqual([]);
    expect(
      readSidebarSpaces(
        stateWith([null, 4, { id: "", name: "x" }, { ...SPACE, name: 3 }, SPACE]),
      ).map((space) => space.id),
    ).toEqual(["spc_1"]);
    expect(readSidebarSpaces(stateWith(undefined))).toBe(
      readSidebarSpaces(stateWith([])),
    );
  });
});

describe("readSpacesArea", () => {
  it("is null on a host without Spaces or with an incomplete area", () => {
    expect(readSpacesArea({} as PluginBrowserBbSdk)).toBeNull();
    expect(
      readSpacesArea({
        experimental_spaces: { create: () => {} },
      } as unknown as PluginBrowserBbSdk),
    ).toBeNull();
    expect(
      readSpacesArea({ experimental_spaces: 3 } as unknown as PluginBrowserBbSdk),
    ).toBeNull();
  });

  it("returns the area when create, update and delete exist", () => {
    const area = { create: vi.fn(), update: vi.fn(), delete: vi.fn() };
    expect(
      readSpacesArea({ experimental_spaces: area } as unknown as PluginBrowserBbSdk),
    ).toBe(area);
  });
});

describe("updateThreadSpace", () => {
  it("sends the Space id, or null to leave the Space", async () => {
    const update = vi.fn(async () => ({ ok: true }));
    const sdk = { threads: { update } } as unknown as PluginBrowserBbSdk;
    await updateThreadSpace(sdk, "thr_1", "spc_1");
    await updateThreadSpace(sdk, "thr_1", null);
    expect(update).toHaveBeenNthCalledWith(1, { threadId: "thr_1", spaceId: "spc_1" });
    expect(update).toHaveBeenNthCalledWith(2, { threadId: "thr_1", spaceId: null });
  });
});
