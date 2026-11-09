import {
  flattenProjectGroupLayout,
  type ProjectGroupLayoutEntry,
} from "./project-groups.js";

const PROJECT_SECTION_PREFIX = "project:";

export interface ProjectMove {
  nextProjectId: string | null;
  previousProjectId: string | null;
  projectId: string;
}

export function buildDesiredProjectOrder(
  layout: readonly ProjectGroupLayoutEntry[],
  serverProjectIds: readonly string[],
): string[] {
  const known = new Set(serverProjectIds);
  const desired = [
    ...new Set(
      flattenProjectGroupLayout(layout, new Set())
        .filter((sectionId) => sectionId.startsWith(PROJECT_SECTION_PREFIX))
        .map((sectionId) => sectionId.slice(PROJECT_SECTION_PREFIX.length))
        .filter((projectId) => known.has(projectId)),
    ),
  ];
  const placed = new Set(desired);
  serverProjectIds.forEach((projectId, index) => {
    if (placed.has(projectId)) return;
    const preceding = serverProjectIds[index - 1];
    desired.splice(
      preceding === undefined ? 0 : desired.indexOf(preceding) + 1,
      0,
      projectId,
    );
    placed.add(projectId);
  });
  return desired;
}

function longestIncreasingSubsequenceIndexes(
  values: readonly number[],
): Set<number> {
  const tailIndexes: number[] = [];
  const previousIndexes: number[] = [];
  values.forEach((value, index) => {
    let low = 0;
    let high = tailIndexes.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if ((values[tailIndexes[middle] ?? 0] ?? 0) < value) {
        low = middle + 1;
      } else {
        high = middle;
      }
    }
    previousIndexes[index] = tailIndexes[low - 1] ?? -1;
    tailIndexes[low] = index;
  });
  const kept = new Set<number>();
  let cursor = tailIndexes.at(-1) ?? -1;
  while (cursor !== -1) {
    kept.add(cursor);
    cursor = previousIndexes[cursor] ?? -1;
  }
  return kept;
}

function nearestPlaced(
  desired: readonly string[],
  placed: ReadonlySet<string>,
  from: number,
  step: 1 | -1,
): string | null {
  for (let index = from; index >= 0 && index < desired.length; index += step) {
    const projectId = desired[index];
    if (projectId !== undefined && placed.has(projectId)) return projectId;
  }
  return null;
}

export function planProjectMoves(
  current: readonly string[],
  desired: readonly string[],
): ProjectMove[] {
  const fixedIndexes = longestIncreasingSubsequenceIndexes(
    desired.map((projectId) => current.indexOf(projectId)),
  );
  const placed = new Set(
    desired.filter((_projectId, index) => fixedIndexes.has(index)),
  );
  const moves: ProjectMove[] = [];
  desired.forEach((projectId, index) => {
    if (placed.has(projectId)) return;
    moves.push({
      projectId,
      previousProjectId: nearestPlaced(desired, placed, index - 1, -1),
      nextProjectId: nearestPlaced(desired, placed, index + 1, 1),
    });
    placed.add(projectId);
  });
  return moves;
}
