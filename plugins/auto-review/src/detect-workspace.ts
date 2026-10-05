import type { BbPluginApi } from "@get-bb/plugin-sdk";

type StatusResult = Awaited<
  ReturnType<BbPluginApi["sdk"]["environments"]["status"]>
>;
export type AvailableWorkspace = Extract<
  StatusResult,
  { outcome: "available" }
>["workspace"];

export type TimelineResult = Awaited<
  ReturnType<BbPluginApi["sdk"]["threads"]["timeline"]>
>;
export type TimelineRow = TimelineResult["rows"][number];

export type WorkingTreeFile = AvailableWorkspace["workingTree"]["files"][number];
export type ThreadListEntry = Awaited<
  ReturnType<BbPluginApi["sdk"]["threads"]["list"]>
>[number];

export async function fetchWorkspace(
  bb: BbPluginApi,
  environmentId: string,
): Promise<AvailableWorkspace | null> {
  const result = await bb.sdk.environments.status({ environmentId });
  return result.outcome === "available" ? result.workspace : null;
}

export function headShaOf(workspace: AvailableWorkspace): string | null {
  const { checkout } = workspace;
  return checkout.kind === "branch" || checkout.kind === "detached"
    ? checkout.headSha
    : null;
}

/**
 * Agent-harness state directories. Hooks and harnesses drop untracked files
 * there during every turn (edit backups, logs, memory), so an untracked file
 * the tree alone shows there is harness output, not the turn's work. The
 * thread's own tool edits there still count.
 */
export const HARNESS_STATE_DIRS: readonly string[] = [".claude/", ".codex/", ".bb/"];

export function isHarnessOutput(file: WorkingTreeFile): boolean {
  return (
    file.status === "??" &&
    HARNESS_STATE_DIRS.some((dir) => file.path.startsWith(dir))
  );
}

/**
 * Paths with something left to review: uncommitted, ahead of the base, or
 * committed during the turn — on the mainline, where nothing is ever ahead,
 * the last is the only trace a committed change leaves.
 */
export function dirtyOrAheadPaths(
  workspace: AvailableWorkspace,
  committedThisTurn: readonly string[] = [],
): Set<string> {
  const paths = new Set<string>(committedThisTurn);
  for (const file of workspace.workingTree.files) {
    paths.add(file.path);
  }
  if (workspace.mergeBase !== null) {
    for (const file of workspace.mergeBase.files) {
      paths.add(file.path);
    }
  }
  return paths;
}

export function computeScope(
  authored: readonly string[],
  dirtyOrAhead: ReadonlySet<string>,
): string[] {
  return authored.filter((path) => dirtyOrAhead.has(path));
}

export function mainlineBase(workspace: AvailableWorkspace): string {
  return workspace.mergeBase?.mergeBaseBranch ?? workspace.branch.defaultBranch;
}

export function isBranchCheckout(workspace: AvailableWorkspace): boolean {
  return workspace.checkout.kind === "branch";
}
