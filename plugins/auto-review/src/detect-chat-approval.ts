import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

import { classifyText } from "./detect-claim-shell.js";
import { isUserRequest, steersTurn, type TurnRequestData } from "./detect-events.js";
import { eventsSince, type EventOf } from "./detect-event-log.js";
import { shellText, walkRows } from "./detect-rows.js";
import { turnTimeline } from "./detect-timeline.js";
import { readState, withThreadLock, writeState, type ThreadState } from "./state.js";

/**
 * A user request typed in chat: the user's own (`isUserRequest`) and not sent on
 * their behalf by a plugin (`originPluginId`, e.g. the advisor's queue message)
 * or another thread (`senderThreadId`, i.e. a child's `bb thread tell`). A
 * missing field and a null one mean the same. `originPluginId` is on the event
 * row at runtime — `events.list` returns the stored row as the server serves it
 * (`originPluginId: "advisor"` at seq 239 of thr_w7c3pt43uv) — but the SDK's
 * event type declares only `senderThreadId`.
 */
export function isTypedUserRequest(data: TurnRequestData): boolean {
  const { originPluginId } = data as TurnRequestData & { originPluginId?: string | null };
  return isUserRequest(data) && originPluginId == null && data.senderThreadId == null;
}


/** TypeSafe's `approves` at or above this credits a typed reply as the approval of the plan. */
export const CHAT_APPROVAL_THRESHOLD = 0.6;

const planApprovalSchema = z.object({ approves: z.number().nullable() });

/** Whether shell text writes: a file it names outside scratch space, git that writes history, or a command whose writes cannot be listed. */
function shellWrites(text: string): boolean {
  const claims = classifyText(text);
  return claims.writes.length > 0 || claims.opaque !== undefined || claims.history;
}

/**
 * The seq of the first file change or shell write after the cursor, or null
 * when there is none. Throws when the timeline back to the cursor cannot be
 * read in full, so the caller fails closed.
 */
async function firstWriteSince(bb: BbPluginApi, threadId: string, sinceSeq: number): Promise<number | null> {
  const { rows, truncated } = await turnTimeline(bb, threadId, sinceSeq);
  if (truncated) {
    throw new Error("the thread's timeline since the plan was released is truncated");
  }
  let first: number | null = null;
  for (const row of walkRows(rows)) {
    if (row.kind !== "work" || row.sourceSeqStart <= sinceSeq) {
      continue;
    }
    const text = shellText(row);
    if ((row.workKind === "file-change" || (text !== null && shellWrites(text))) && (first === null || row.sourceSeqStart < first)) {
      first = row.sourceSeqStart;
    }
  }
  return first;
}

/** The text of a typed request, or "" when it has none to judge. */
const requestText = (data: TurnRequestData): string =>
  data.input.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n").trim();

/**
 * Merges `patch` (built from the state as it stands) into the thread state
 * under the thread lock, unless the release cursor is no longer `releasedSeq`:
 * an arm deleted it, so the plan this reply answered is gone and nothing is
 * written. Returns whether it wrote.
 */
async function recordChat(
  bb: BbPluginApi,
  threadId: string,
  releasedSeq: number,
  patch: (state: ThreadState) => Partial<ThreadState>,
): Promise<boolean> {
  return withThreadLock(threadId, async () => {
    const state = await readState(bb, threadId);
    if (state.presentPlanChatReleasedSeq !== releasedSeq) {
      return false;
    }
    await writeState(bb, threadId, patch(state));
    return true;
  });
}

/**
 * The seq of the typed reply that approves the plan `PresentPlan` released to
 * a chat approval at `releasedSeq`, or null when none does. A candidate is a
 * typed request (`isTypedUserRequest`) that began its own turn after the
 * release turn ended: a steer, a reply queued during the release turn and a
 * request that was never accepted into a turn are skipped, not the end of the
 * search. The walk ends at the first file change or shell write after the
 * release, so a reply after work started never counts. Candidates are judged
 * oldest first through the typesafe plugin's `planApproval`; the first with
 * `approves` at or above `CHAT_APPROVAL_THRESHOLD` wins. A reply at or before
 * `deniedSeq`, the newest denial, cannot count against it, so it is not sent.
 * A numeric verdict is cached in the thread state by candidate seq (`cached`
 * holds the ones so far), so a reply is sent once. A null answer means TypeSafe
 * gave none (no key, an outage), so it is not cached and the reply is judged
 * again on the next call. A null answer, a failed call and an unreadable
 * timeline give no credit; none of them throws.
 */
export async function chatApprovalSeq(
  bb: BbPluginApi,
  threadId: string,
  releasedSeq: number,
  deniedSeq: number,
  cached: Readonly<Record<string, number>>,
): Promise<number | null> {
  const approves: Array<number | null> = [];
  const noCredit = (cause: string): null => {
    bb.log.info(
      `auto-review: your reply after the plan was not judged as approval (or TypeSafe was unavailable); ask the agent to present the plan again (thread ${threadId}: ${cause}; approves ${JSON.stringify(approves)})`,
    );
    return null;
  };
  try {
    let released: EventOf<"turn/completed"> | undefined;
    for await (const event of eventsSince(bb, threadId, releasedSeq, "turn/completed")) {
      released = event;
      break;
    }
    if (released === undefined) {
      return noCredit("the turn that released the plan has not ended");
    }
    const stopSeq = await firstWriteSince(bb, threadId, releasedSeq);
    const landed = new Map<string, string>();
    for await (const { scope, data } of eventsSince(bb, threadId, released.seq, "turn/input/accepted")) {
      if (scope.kind === "turn") {
        landed.set(data.clientRequestId, scope.turnId);
      }
    }
    const verdicts = { ...cached };
    let projectId: string | undefined;
    for await (const { seq, data } of eventsSince(bb, threadId, released.seq, "client/turn/requested")) {
      if (stopSeq !== null && seq > stopSeq) {
        break;
      }
      const turnId = landed.get(data.requestId);
      const text = requestText(data);
      if (seq <= deniedSeq || !isTypedUserRequest(data) || turnId === undefined || steersTurn(data.target, turnId) || text === "") {
        continue;
      }
      const key = String(seq);
      let value: number | null | undefined = verdicts[key];
      if (value === undefined) {
        projectId ??= (await bb.sdk.threads.get({ threadId })).projectId;
        try {
          value = (
            await bb.sdk.plugins.callRpc({
              pluginId: "typesafe",
              method: "planApproval",
              input: { projectId, text },
              outputSchema: planApprovalSchema,
            })
          ).approves;
        } catch (error) {
          return noCredit(`the typesafe planApproval call failed: ${error instanceof Error ? error.message : String(error)}`);
        }
        if (value !== null) {
          const verdict: number = value;
          verdicts[key] = verdict;
          if (!(await recordChat(bb, threadId, releasedSeq, (state) => ({ presentPlanChatVerdicts: { ...state.presentPlanChatVerdicts, [key]: verdict } })))) {
            return noCredit("a new plan was presented while the reply was judged");
          }
        }
      }
      approves.push(value);
      if (value !== null && value >= CHAT_APPROVAL_THRESHOLD) {
        // The credit is stored so a later read of a long thread, which may truncate, still counts it.
        if (!(await recordChat(bb, threadId, releasedSeq, () => ({ presentPlanChatApprovedSeq: seq })))) {
          return noCredit("a new plan was presented while the reply was judged");
        }
        bb.log.info(`auto-review: the reply at seq ${seq} in ${threadId} was judged as approval of the plan (approves ${value}), so the missing-plan check counts it`);
        return seq;
      }
    }
    return noCredit(approves.length === 0 ? "no typed reply to judge between the release and the first change" : "no reply judged as approval");
  } catch (error) {
    return noCredit(`the reply could not be read: ${error instanceof Error ? error.message : String(error)}`);
  }
}
