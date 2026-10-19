export {
  AUTHORSHIP_MAX_PAGES,
  AUTHORSHIP_SEGMENT_LIMIT,
  authoredPaths,
  authoredPathsFromRows,
  siblingAuthoredPaths,
} from "./detect-timeline.js";
export {
  captureSinceSeq,
  endedTurn,
  NoTurnCompletedError,
  UnreadTurnError,
  firstUserTurnSince,
  quietSincePark,
  stoppedByUser,
  tryCaptureSinceSeq,
  userTurnRunningSince,
} from "./detect-events.js";
export type { EndedTurn } from "./detect-events.js";
export { runningChildIds, spawnedDescendantIds } from "./detect-children.js";
export {
  captureTree,
  fingerprintsMatch,
  hasUnhashedEntries,
  MAX_HASHED_FILES,
  snapshotTree,
} from "./detect-tree.js";
export { branchHeadPushed, MAX_NEW_COMMITS, turnCommits } from "./detect-commits.js";
export { treeChangedPaths, turnChangedPaths } from "./detect-turn.js";
export type {
  TreeChanges,
  TurnChangeInput,
  TurnChanges,
  TurnScope,
} from "./detect-turn.js";
export {
  computeScope,
  dirtyOrAheadPaths,
  fetchWorkspace,
  HARNESS_STATE_DIRS,
  isBranchCheckout,
  mainlineBase,
} from "./detect-workspace.js";
export type { AvailableWorkspace } from "./detect-workspace.js";
