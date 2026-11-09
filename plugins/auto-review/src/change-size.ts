import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

import { planLatestDecisionApproves } from "./detect-events.js";
import type { AvailableWorkspace } from "./detect-workspace.js";

/** The most changed lines a trivial verdict still self-reviews. */
export const TRIVIAL_DIFF_LINES = 10;

const changeSizeSchema = z.object({
  verdict: z.enum(["question", "trivial", "non_trivial"]).nullable(),
  messageSeq: z.number().nullable(),
});

/**
 * How the size gate left a review. `trivial` is true only when the verdict is
 * trivial, fresh for this window, and the diff is within the floor: the change
 * gets the focused self-review instead of the reviewer lenses. `blocker` is
 * whether the review must report the missing plan: the diff is over the floor,
 * or the verdict is non_trivial for this window, and the thread's latest plan
 * decision is not an approval (or could not be read). A trivial change
 * structurally never gets the blocker.
 */
export interface ReviewSize {
  trivial: boolean;
  blocker: boolean;
}

/**
 * Whether the turn's diff is within the self-review floor: exactly one path in
 * scope whose changed lines — insertions plus deletions, summed over the
 * working tree and the merge base — total at most `TRIVIAL_DIFF_LINES`. An
 * uncountable entry (null line stats: binary or untracked) or a path with no
 * entry here (a committed mainline change leaves no stats) fails closed, over
 * the floor.
 */
function withinDiffFloor(scope: readonly string[], workspace: AvailableWorkspace | null): boolean {
  if (scope.length !== 1 || workspace === null) {
    return false;
  }
  const entries = [...workspace.workingTree.files, ...(workspace.mergeBase?.files ?? [])].filter(
    ({ path }) => path === scope[0],
  );
  if (entries.length === 0) {
    return false;
  }
  let lines = 0;
  for (const { insertions, deletions } of entries) {
    if (insertions === null || deletions === null) {
      return false;
    }
    lines += insertions + deletions;
  }
  return lines <= TRIVIAL_DIFF_LINES;
}

/**
 * The size gate a review arms with: the typesafe plugin's `changeSize` verdict
 * for this thread (`TRIVIAL_CHANGE` in `size-definition.ts`), judged against
 * the diff floor and the thread's latest plan decision. `windowStartSeq` is the
 * cursor the previous code review captured before its send: a verdict whose
 * messageSeq sits at or before it sized an earlier request, so it is stale and
 * earns no self-review. A plan approved earlier in the thread still waives the
 * blocker for a follow-up, until a later denied plan cancels it. Every failure
 * — the RPC missing, the events walk failing — fails closed: the verdict is
 * lost, so the review runs unsized (today's tier), and a plan-decision read
 * failure keeps the missing-plan blocker, never waives it.
 */
export async function reviewSize(
  bb: BbPluginApi,
  threadId: string,
  scope: readonly string[],
  workspace: AvailableWorkspace | null,
  windowStartSeq: number,
): Promise<ReviewSize> {
  let verdict: z.infer<typeof changeSizeSchema> | null = null;
  try {
    verdict = await bb.sdk.plugins.callRpc({
      pluginId: "typesafe",
      method: "changeSize",
      input: { threadId },
      outputSchema: changeSizeSchema,
    });
  } catch (error) {
    bb.log.warn(
      `auto-review: change-size sizing failed closed for ${threadId}, so the review runs unsized: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  const overFloor = !withinDiffFloor(scope, workspace);
  const messageSeq = verdict?.messageSeq ?? null;
  const fresh = messageSeq !== null && messageSeq > windowStartSeq;
  const trivial = verdict?.verdict === "trivial" && fresh && !overFloor;
  if (trivial) {
    return { trivial: true, blocker: false };
  }
  if (!overFloor && !(verdict?.verdict === "non_trivial" && fresh)) {
    return { trivial: false, blocker: false };
  }
  try {
    return { trivial: false, blocker: !(await planLatestDecisionApproves(bb, threadId)) };
  } catch (error) {
    // The blocker's condition already holds here; the walk was only to check
    // whether a plan waives it, so a read failure must not waive it either.
    bb.log.warn(
      `auto-review: could not read the plan decisions for ${threadId}, so the missing-plan blocker fires: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return { trivial: false, blocker: true };
  }
}
