import { describe, expect, it } from "vitest";
import {
  applyVisibleSidebarSectionOrder,
  buildSidebarEntitySectionId,
  insertSidebarSectionAfter,
  insertSpaceAfterPinned,
  normalizeSidebarSectionOrder,
  reorderSidebarSectionOrder,
} from "./sidebar-section-order.js";

describe("normalizeSidebarSectionOrder", () => {
  const projectA = buildSidebarEntitySectionId("project", "a");
  const projectB = buildSidebarEntitySectionId("project", "b");

  it("expands the legacy aggregate section without changing its placement", () => {
    expect(
      normalizeSidebarSectionOrder({
        storedOrder: ["threads", "projects", "pinned"],
        entitySectionIds: [projectA, projectB],
        legacyEntityAnchor: "projects",
        hasPinnedSection: true,
      }),
    ).toEqual(["threads", projectA, projectB, "pinned"]);
  });

  it("preserves a free mixed order of built-ins and entities", () => {
    expect(
      normalizeSidebarSectionOrder({
        storedOrder: [projectB, "pinned", "threads", projectA],
        entitySectionIds: [projectA, projectB],
        legacyEntityAnchor: "projects",
        hasPinnedSection: true,
      }),
    ).toEqual([projectB, "pinned", "threads", projectA]);
  });

  it("drops removed entities and appends new ones after existing entities", () => {
    const projectC = buildSidebarEntitySectionId("project", "c");
    expect(
      normalizeSidebarSectionOrder({
        storedOrder: ["project:removed", "threads", projectB],
        entitySectionIds: [projectA, projectB, projectC],
        legacyEntityAnchor: "projects",
        hasPinnedSection: true,
      }),
    ).toEqual(["pinned", "threads", projectB, projectA, projectC]);
  });

  it("drops a stored Threads section when it is not available", () => {
    expect(
      normalizeSidebarSectionOrder({
        storedOrder: [projectA, "threads", projectB],
        entitySectionIds: [projectA, projectB],
        legacyEntityAnchor: "projects",
        hasPinnedSection: true,
        hasThreadsSection: false,
      }),
    ).toEqual(["pinned", projectA, projectB]);
  });

  it("uses the same reconciliation for sections", () => {
    const section = buildSidebarEntitySectionId("section", "work");
    expect(
      normalizeSidebarSectionOrder({
        storedOrder: ["pinned", "sections", "threads"],
        entitySectionIds: [section],
        legacyEntityAnchor: "sections",
        hasPinnedSection: true,
      }),
    ).toEqual(["pinned", section, "threads"]);
  });
});

describe("reorderSidebarSectionOrder", () => {
  it("moves any entity or built-in section through the shared order", () => {
    expect(
      reorderSidebarSectionOrder({
        activeId: "threads",
        overId: "project:a",
        order: ["pinned", "project:a", "project:b", "threads"],
      }),
    ).toEqual(["pinned", "threads", "project:a", "project:b"]);
  });

  it("rejects ids outside the top-level section contract", () => {
    expect(
      reorderSidebarSectionOrder({
        activeId: "thread:a",
        overId: "project:a",
        order: ["project:a", "threads"],
      }),
    ).toBeNull();
  });
});

describe("insertSidebarSectionAfter", () => {
  const sectionA = buildSidebarEntitySectionId("section", "a");
  const sectionB = buildSidebarEntitySectionId("section", "b");
  const created = buildSidebarEntitySectionId("section", "created");

  it("places the created section directly after its anchor", () => {
    expect(
      insertSidebarSectionAfter({
        storedOrder: ["pinned", "sections", "threads"],
        entitySectionIds: [sectionA, sectionB],
        legacyEntityAnchor: "sections",
        anchorSectionId: sectionA,
        sectionId: created,
      }),
    ).toEqual(["pinned", sectionA, created, sectionB, "threads"]);
  });

  it("places the created section after a built-in anchor", () => {
    expect(
      insertSidebarSectionAfter({
        storedOrder: ["pinned", "sections", "threads"],
        entitySectionIds: [sectionA],
        legacyEntityAnchor: "sections",
        anchorSectionId: "pinned",
        sectionId: created,
      }),
    ).toEqual(["pinned", created, sectionA, "threads"]);
  });

  it("moves an already stored section next to its anchor", () => {
    expect(
      insertSidebarSectionAfter({
        storedOrder: ["pinned", created, sectionA, sectionB, "threads"],
        entitySectionIds: [sectionA, sectionB],
        legacyEntityAnchor: "sections",
        anchorSectionId: sectionB,
        sectionId: created,
      }),
    ).toEqual(["pinned", sectionA, sectionB, created, "threads"]);
  });

  it("keeps the stored order when the anchor is from another mode", () => {
    expect(
      insertSidebarSectionAfter({
        storedOrder: ["pinned", "sections", "threads"],
        entitySectionIds: [sectionA],
        legacyEntityAnchor: "sections",
        anchorSectionId: buildSidebarEntitySectionId("project", "a"),
        sectionId: created,
      }),
    ).toBeNull();
  });
});

describe("applyVisibleSidebarSectionOrder", () => {
  it("retains hidden, pinned, and disconnected slots when visible groups move", () => {
    expect(
      applyVisibleSidebarSectionOrder({
        storedOrder: [
          "pinned",
          "project:a",
          "project:b",
          "project:offline",
          "project:c",
          "threads",
        ],
        nextVisibleOrder: ["project:c", "project:a", "threads"],
        entitySectionIds: ["project:a", "project:b", "project:c"],
        entityKind: "project",
        legacyEntityAnchor: "projects",
      }),
    ).toEqual([
      "pinned",
      "project:c",
      "project:b",
      "project:offline",
      "project:a",
      "threads",
    ]);
  });

  it("moves only the reordered sections and leaves pinned and Threads in place", () => {
    expect(
      applyVisibleSidebarSectionOrder({
        storedOrder: ["pinned", "section:a", "section:b", "threads"],
        nextVisibleOrder: ["section:b", "section:a"],
        entitySectionIds: ["section:a", "section:b"],
        entityKind: "section",
        legacyEntityAnchor: "sections",
      }),
    ).toEqual(["pinned", "section:b", "section:a", "threads"]);
  });
});

describe("Space ids in section order", () => {
  const spaceA = buildSidebarEntitySectionId("space", "a");
  const spaceB = buildSidebarEntitySectionId("space", "b");
  const projectA = buildSidebarEntitySectionId("project", "a");
  const projectB = buildSidebarEntitySectionId("project", "b");

  it("builds space ids", () => {
    expect(spaceA).toBe("space:a");
  });

  it("puts Spaces missing from a pre-Spaces stored order right after pinned, keeping the rest in order", () => {
    const stored = ["pinned", projectB, projectA, "threads"];
    expect(
      normalizeSidebarSectionOrder({
        storedOrder: stored,
        entitySectionIds: [projectA, projectB],
        legacyEntityAnchor: "projects",
        hasPinnedSection: true,
        spaceSectionIds: [spaceA, spaceB],
      }),
    ).toEqual(["pinned", spaceA, spaceB, projectB, projectA, "threads"]);
  });

  it("adds Spaces to the default legacy order after pinned", () => {
    expect(
      normalizeSidebarSectionOrder({
        storedOrder: ["pinned", "projects", "threads"],
        entitySectionIds: [projectA],
        legacyEntityAnchor: "projects",
        hasPinnedSection: true,
        spaceSectionIds: [spaceA],
      }),
    ).toEqual(["pinned", spaceA, projectA, "threads"]);
  });

  it("puts Spaces first when pinned is not part of the order", () => {
    expect(
      normalizeSidebarSectionOrder({
        storedOrder: [projectA, "threads"],
        entitySectionIds: [projectA],
        legacyEntityAnchor: "projects",
        hasPinnedSection: false,
        spaceSectionIds: [spaceA],
      }),
    ).toEqual([spaceA, projectA, "threads"]);
  });

  it("keeps a stored Space position and drops Space ids that no longer exist", () => {
    expect(
      normalizeSidebarSectionOrder({
        storedOrder: ["pinned", projectA, spaceB, "space:gone", "threads"],
        entitySectionIds: [projectA],
        legacyEntityAnchor: "projects",
        hasPinnedSection: true,
        spaceSectionIds: [spaceA, spaceB],
      }),
    ).toEqual(["pinned", spaceA, projectA, spaceB, "threads"]);
  });

  it("drops stored Space ids when the host provides no Spaces", () => {
    expect(
      normalizeSidebarSectionOrder({
        storedOrder: ["pinned", spaceA, projectA, "threads"],
        entitySectionIds: [projectA],
        legacyEntityAnchor: "projects",
        hasPinnedSection: true,
      }),
    ).toEqual(["pinned", projectA, "threads"]);
  });

  it("reorders Space ids", () => {
    expect(
      reorderSidebarSectionOrder({
        activeId: spaceB,
        overId: projectA,
        order: ["pinned", spaceA, spaceB, projectA, "threads"],
      }),
    ).toEqual(["pinned", spaceA, projectA, spaceB, "threads"]);
  });

  it("persists Space positions when the visible order changes and keeps hidden Spaces", () => {
    expect(
      applyVisibleSidebarSectionOrder({
        storedOrder: ["pinned", projectA, projectB, "threads"],
        nextVisibleOrder: ["pinned", projectA, spaceA, projectB, "threads"],
        entitySectionIds: [projectA, projectB],
        entityKind: "project",
        legacyEntityAnchor: "projects",
        spaceSectionIds: [spaceA, spaceB],
      }),
    ).toEqual(["pinned", projectA, spaceB, spaceA, projectB, "threads"]);
  });

  it("inserts a new Space after an anchor", () => {
    expect(
      insertSidebarSectionAfter({
        storedOrder: ["pinned", projectA, "threads"],
        entitySectionIds: [projectA],
        legacyEntityAnchor: "projects",
        anchorSectionId: "pinned",
        sectionId: spaceA,
      }),
    ).toEqual(["pinned", spaceA, projectA, "threads"]);
  });

  it("inserts a Space id directly after pinned in the raw stored order", () => {
    expect(insertSpaceAfterPinned(["pinned", "projects", "threads"], spaceA)).toEqual([
      "pinned",
      spaceA,
      "projects",
      "threads",
    ]);
    expect(insertSpaceAfterPinned(["projects"], spaceA)).toEqual([
      spaceA,
      "projects",
    ]);
    expect(insertSpaceAfterPinned(["pinned", spaceA], spaceA)).toEqual([
      "pinned",
      spaceA,
    ]);
  });
});
