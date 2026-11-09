import { describe, expect, it } from "vitest";
import { applyNeighborReorder } from "./neighbor-reorder.js";
import {
  buildDesiredProjectOrder,
  planProjectMoves,
  type ProjectMove,
} from "./project-order-sync.js";
import type { ProjectGroupLayoutEntry } from "./project-groups.js";
import type { SidebarSectionId } from "./sidebar-section-id.js";

function section(id: string): ProjectGroupLayoutEntry {
  return { kind: "section", sectionId: id as SidebarSectionId };
}

function group(
  id: string,
  projectIds: readonly string[],
): ProjectGroupLayoutEntry {
  return {
    kind: "group",
    group: { id, name: id, projectIds: [...projectIds] },
    sectionIds: projectIds.map((projectId) => `project:${projectId}` as const),
  };
}

function applyMoves(current: readonly string[], moves: readonly ProjectMove[]) {
  let items = current.map((id) => ({ id }));
  for (const move of moves) {
    const sortKeyOf = (id: string | null) =>
      id === null ? null : items.findIndex((item) => item.id === id);
    const previousKey = sortKeyOf(move.previousProjectId);
    const nextKey = sortKeyOf(move.nextProjectId);
    expect(previousKey).not.toBe(-1);
    expect(nextKey).not.toBe(-1);
    if (previousKey !== null && nextKey !== null) {
      expect(previousKey).toBeLessThan(nextKey);
    }
    items = applyNeighborReorder({
      items,
      request: {
        itemId: move.projectId,
        previousItemId: move.previousProjectId,
        nextItemId: move.nextProjectId,
      },
    });
  }
  return items.map((item) => item.id);
}

function mulberry32(seed: number) {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("buildDesiredProjectOrder", () => {
  it("flattens groups in place and drops non-project sections", () => {
    const layout = [
      section("pinned"),
      section("project:a"),
      group("g1", ["c", "b"]),
      section("threads"),
      section("project:d"),
    ];
    expect(buildDesiredProjectOrder(layout, ["a", "b", "c", "d"])).toEqual([
      "a",
      "c",
      "b",
      "d",
    ]);
  });

  it("includes the members of a collapsed group", () => {
    const layout = [group("g1", ["b", "c"]), section("project:a")];
    expect(buildDesiredProjectOrder(layout, ["a", "b", "c"])).toEqual([
      "b",
      "c",
      "a",
    ]);
  });

  it("keeps a hidden group at its position in the persisted layout", () => {
    const layout = [
      section("project:a"),
      section("project:hidden"),
      section("project:b"),
    ];
    expect(buildDesiredProjectOrder(layout, ["a", "hidden", "b"])).toEqual([
      "a",
      "hidden",
      "b",
    ]);
  });

  it("keeps an absent project after its nearest preceding server project", () => {
    const layout = [section("project:c"), section("project:a")];
    expect(buildDesiredProjectOrder(layout, ["a", "e1", "b", "c"])).toEqual([
      "c",
      "a",
      "e1",
      "b",
    ]);
  });

  it("puts an absent project with no predecessor at the front", () => {
    const layout = [section("project:b"), section("project:a")];
    expect(buildDesiredProjectOrder(layout, ["e1", "e2", "a", "b"])).toEqual([
      "e1",
      "e2",
      "b",
      "a",
    ]);
  });

  it("never emits a personal or unknown id", () => {
    const layout = [
      section("project:personal"),
      section("project:a"),
      section("project:ghost"),
    ];
    expect(buildDesiredProjectOrder(layout, ["a", "b"])).toEqual(["a", "b"]);
  });

  it("lists a project once when the layout repeats it", () => {
    const layout = [section("project:a"), section("project:a")];
    expect(buildDesiredProjectOrder(layout, ["a"])).toEqual(["a"]);
  });
});

describe("planProjectMoves", () => {
  it("plans nothing when the orders are equal", () => {
    expect(planProjectMoves(["a", "b", "c"], ["a", "b", "c"])).toEqual([]);
    expect(planProjectMoves([], [])).toEqual([]);
  });

  it("plans exactly one move for a single drag", () => {
    const current = ["a", "b", "c", "d", "e"];
    const desired = ["a", "d", "b", "c", "e"];
    const moves = planProjectMoves(current, desired);
    expect(moves).toEqual([
      { projectId: "d", previousProjectId: "a", nextProjectId: "b" },
    ]);
    expect(applyMoves(current, moves)).toEqual(desired);
  });

  it("moves a project to the front with a null previous neighbour", () => {
    const moves = planProjectMoves(["a", "b", "c"], ["c", "a", "b"]);
    expect(moves).toEqual([
      { projectId: "c", previousProjectId: null, nextProjectId: "a" },
    ]);
  });

  it("moves a project to the end with a null next neighbour", () => {
    const moves = planProjectMoves(["a", "b", "c"], ["b", "c", "a"]);
    expect(moves).toEqual([
      { projectId: "a", previousProjectId: "c", nextProjectId: null },
    ]);
  });

  it("reverses a list with moves the server accepts", () => {
    const current = ["C", "B", "A"];
    const desired = ["A", "B", "C"];
    const moves = planProjectMoves(current, desired);
    expect(moves).toHaveLength(2);
    expect(applyMoves(current, moves)).toEqual(desired);
  });

  it("reaches the desired order for random permutations", () => {
    const random = mulberry32(20260109);
    for (let round = 0; round < 200; round++) {
      const size = 1 + Math.floor(random() * 12);
      const current = Array.from({ length: size }, (_, index) => `p${index}`);
      const desired = [...current];
      for (let index = desired.length - 1; index > 0; index--) {
        const swap = Math.floor(random() * (index + 1));
        const held = desired[index] as string;
        desired[index] = desired[swap] as string;
        desired[swap] = held;
      }
      const moves = planProjectMoves(current, desired);
      expect(applyMoves(current, moves)).toEqual(desired);
    }
  });
});
