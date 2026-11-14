import { describe, expect, it } from "vitest";
import type { PluginSidebarThreadsState } from "@get-bb/plugin-sdk/app";
import { makeSidebarThread } from "./fixtures.js";
import {
  buildSidebarData,
  getSidebarData,
  resetSidebarDataCacheForTest,
} from "./use-sidebar-data.js";

describe("buildSidebarData", () => {
  it("groups threads by project, resolves the personal project, and collects hosts", () => {
    const projects = [
      {
        id: "proj_a",
        name: "A",
        isPersonal: false,
        href: "/projects/proj_a",
        settingsHref: "/projects/proj_a/settings",
      },
      {
        id: "proj_me",
        name: "Personal",
        isPersonal: true,
        href: "/projects/proj_me",
        settingsHref: "/projects/proj_me/settings",
      },
    ];
    const threads = [
      makeSidebarThread({
        id: "t1",
        projectId: "proj_a",
        host: { id: "h1", name: "Mac" },
      }),
      makeSidebarThread({
        id: "t2",
        projectId: "proj_me",
        host: { id: "h2", name: "Box" },
      }),
      makeSidebarThread({
        id: "t3",
        projectId: "proj_a",
        host: { id: "h1", name: "Mac" },
      }),
      makeSidebarThread({ id: "t4", projectId: "proj_gone" }),
    ];
    const data = buildSidebarData("ready", threads, projects, [
      { id: "sec_1", name: "Later", createdAt: 1, updatedAt: 1 },
    ]);

    expect(data.status).toBe("ready");
    expect(data.sections.map((section) => section.id)).toEqual(["sec_1"]);
    expect(
      data.projects.map((project) => [
        project.id,
        project.threads.map((t) => t.id),
      ]),
    ).toEqual([
      ["proj_a", ["t1", "t3"]],
      ["proj_me", ["t2"]],
    ]);
    expect(data.projects[0]).toMatchObject({
      name: "A",
      href: "/projects/proj_a",
      settingsHref: "/projects/proj_a/settings",
      isPersonal: false,
    });
    expect(data.personalProject?.id).toBe("proj_me");
    expect([...data.hostsById.entries()]).toEqual([
      ["h1", { id: "h1", name: "Mac" }],
      ["h2", { id: "h2", name: "Box" }],
    ]);
  });

  it("reports no personal project when none is flagged", () => {
    const data = buildSidebarData("loading", [], [], []);
    expect(data.personalProject).toBeNull();
    expect(data.projects).toEqual([]);
    expect(data.hostsById.size).toBe(0);
  });
});

describe("buildSidebarData structural sharing", () => {
  const projects = [
    {
      id: "proj_a",
      name: "A",
      isPersonal: false,
      href: "/a",
      settingsHref: "/a/s",
    },
    {
      id: "proj_b",
      name: "B",
      isPersonal: false,
      href: "/b",
      settingsHref: "/b/s",
    },
  ];

  it("keeps untouched projects and their thread arrays by identity across updates", () => {
    const a1 = makeSidebarThread({ id: "a1", projectId: "proj_a" });
    const b1 = makeSidebarThread({ id: "b1", projectId: "proj_b" });
    const first = buildSidebarData("ready", [a1, b1], projects, []);
    const b1Changed = makeSidebarThread({
      id: "b1",
      projectId: "proj_b",
      title: "renamed",
    });
    const second = buildSidebarData(
      "ready",
      [a1, b1Changed],
      projects,
      [],
      [],
      first,
    );
    expect(second.projects[0]).toBe(first.projects[0]);
    expect(second.projects[0]?.threads).toBe(first.projects[0]?.threads);
    expect(second.projects[1]).not.toBe(first.projects[1]);
    expect(second.projects).not.toBe(first.projects);
    expect(second.hostsById).toBe(first.hostsById);
    const third = buildSidebarData(
      "ready",
      [a1, b1Changed],
      projects,
      [],
      [],
      second,
    );
    expect(third.projects).toBe(second.projects);
  });

  it("serves one grouped result per host payload to every caller", () => {
    resetSidebarDataCacheForTest();
    const state = {
      status: "ready" as const,
      threads: [makeSidebarThread({ id: "a1", projectId: "proj_a" })],
      experimental_hosts: [],
      projects,
      sections: [],
      experimental_archived: null,
    };
    const data = getSidebarData(state);
    expect(getSidebarData({ ...state })).toBe(data);
    expect(getSidebarData({ ...state, threads: [...state.threads] })).not.toBe(
      data,
    );
    resetSidebarDataCacheForTest();
  });
});

describe("buildSidebarData Spaces", () => {
  const projects = [
    {
      id: "proj_a",
      name: "A",
      isPersonal: false,
      href: "/a",
      settingsHref: "/a/s",
    },
  ];
  const space = (id: string, name: string) => ({
    id,
    name,
    brief: "",
    directory: `/spaces/${id}`,
    createdAt: 1,
    updatedAt: 1,
    archivedAt: null,
  });

  it("collects each Space's threads and keeps them in their project too", () => {
    const inSpace = makeSidebarThread({
      id: "t1",
      projectId: "proj_a",
      experimental_spaceId: "spc_1",
    });
    const plain = makeSidebarThread({ id: "t2", projectId: "proj_a" });
    const unknown = makeSidebarThread({
      id: "t3",
      projectId: "proj_a",
      experimental_spaceId: "spc_gone",
    });
    const data = buildSidebarData(
      "ready",
      [inSpace, plain, unknown],
      projects,
      [],
      [],
      null,
      [space("spc_1", "Payments"), space("spc_2", "Empty")],
    );
    expect(
      data.spaces.map((entry) => [entry.id, entry.threads.map((t) => t.id)]),
    ).toEqual([
      ["spc_1", ["t1"]],
      ["spc_2", []],
    ]);
    expect(data.projects[0]?.threads.map((t) => t.id)).toEqual([
      "t1",
      "t2",
      "t3",
    ]);
  });

  it("has no Spaces when the host does not provide them", () => {
    const data = buildSidebarData(
      "ready",
      [makeSidebarThread({ id: "t1", projectId: "proj_a" })],
      projects,
      [],
    );
    expect(data.spaces).toEqual([]);
  });

  it("shares unchanged Space objects across updates and rebuilds a changed one", () => {
    const t1 = makeSidebarThread({
      id: "t1",
      projectId: "proj_a",
      experimental_spaceId: "spc_1",
    });
    const spaces = [space("spc_1", "Payments"), space("spc_2", "Other")];
    const first = buildSidebarData("ready", [t1], projects, [], [], null, spaces);
    const same = buildSidebarData("ready", [t1], projects, [], [], first, [
      space("spc_1", "Payments"),
      space("spc_2", "Other"),
    ]);
    expect(same.spaces).toBe(first.spaces);
    const renamed = buildSidebarData("ready", [t1], projects, [], [], first, [
      space("spc_1", "Payments v2"),
      space("spc_2", "Other"),
    ]);
    expect(renamed.spaces).not.toBe(first.spaces);
    expect(renamed.spaces[0]?.name).toBe("Payments v2");
    expect(renamed.spaces[0]?.threads).toBe(first.spaces[0]?.threads);
    expect(renamed.spaces[1]).toBe(first.spaces[1]);
  });
});

describe("getSidebarData Spaces cache", () => {
  const baseState = {
    status: "ready" as const,
    threads: [],
    experimental_hosts: [],
    projects: [],
    sections: [],
    experimental_archived: null,
  };

  it("rebuilds when only the Spaces list changes and reuses the result otherwise", () => {
    resetSidebarDataCacheForTest();
    const spacesA = [
      {
        id: "spc_1",
        name: "One",
        brief: "",
        directory: "/s/1",
        createdAt: 1,
        updatedAt: 1,
        archivedAt: null,
      },
    ];
    const withSpaces: PluginSidebarThreadsState = {
      ...baseState,
      ...{ experimental_spaces: spacesA },
    };
    const first = getSidebarData(withSpaces);
    expect(getSidebarData({ ...withSpaces })).toBe(first);
    const second = getSidebarData({
      ...baseState,
      ...{ experimental_spaces: [...spacesA, { ...spacesA[0], id: "spc_2" }] },
    });
    expect(second).not.toBe(first);
    expect(second.spaces.map((entry) => entry.id)).toEqual(["spc_1", "spc_2"]);
  });

  it("rebuilds a Space when only its archived state changes", () => {
    resetSidebarDataCacheForTest();
    const active = {
      id: "spc_1",
      name: "One",
      brief: "",
      directory: "/s/1",
      createdAt: 1,
      updatedAt: 1,
      archivedAt: null,
    };
    const first = getSidebarData({
      ...baseState,
      ...{ experimental_spaces: [active] },
    });
    const second = getSidebarData({
      ...baseState,
      ...{ experimental_spaces: [{ ...active, archivedAt: 5 }] },
    });
    expect(first.spaces[0]?.archivedAt).toBeNull();
    expect(second.spaces[0]?.archivedAt).toBe(5);
    expect(second.spaces[0]).not.toBe(first.spaces[0]);
  });

  it("ignores a malformed Spaces field", () => {
    resetSidebarDataCacheForTest();
    const data = getSidebarData({
      ...baseState,
      experimental_spaces: [{ id: 1 }, null, "x"],
    } as never);
    expect(data.spaces).toEqual([]);
    expect(getSidebarData(baseState).spaces).toEqual([]);
  });
});
