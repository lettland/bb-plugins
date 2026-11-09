import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

import { classifyText } from "./detect-claim-shell.js";
import { EVENT_PAGE_MAX, eventsSince, type EventOf } from "./detect-event-log.js";
import { planFormResolution } from "./detect-plan-form.js";
import { shellText, walkRows } from "./detect-rows.js";
import { turnTimeline } from "./detect-timeline.js";
import { AUTO_REVIEW_MARKER, CODE_REVIEW_OPENING } from "./prompt.js";
import { readState, writeState } from "./state.js";

export async function captureSinceSeq(
  bb: BbPluginApi,
  threadId: string,
): Promise<number> {
  const timeline = await bb.sdk.threads.timeline({ threadId });
  return timeline.maxSeq;
}

/**
 * `captureSinceSeq` for callers that can do without the cursor: a failure is
 * logged, naming what the cursor was for (`purpose`, which also says what is
 * lost without it), and yields undefined instead of throwing.
 */
export async function tryCaptureSinceSeq(
  bb: BbPluginApi,
  threadId: string,
  purpose: string,
): Promise<number | undefined> {
  try {
    return await captureSinceSeq(bb, threadId);
  } catch (error) {
    bb.log.warn(
      `auto-review: could not capture a timeline cursor for ${purpose}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return undefined;
  }
}

/**
 * Whether the user stopped the thread after the turn-start cursor. A stop the
 * thread took for any other reason — a daemon restart, the provider-turn
 * watchdog — was not the user's call and does not count.
 */
export async function stoppedByUser(
  bb: BbPluginApi,
  threadId: string,
  sinceSeq: number,
): Promise<boolean> {
  const events = await bb.sdk.threads.events.list({
    threadId,
    afterSeq: String(sinceSeq),
    types: ["system/thread/interrupted"],
  });
  return events.some(
    (event) =>
      event.type === "system/thread/interrupted" &&
      event.data.reason === "manual-stop",
  );
}

export { EVENT_PAGE_MAX };

type TurnRequestData = EventOf<"client/turn/requested">["data"];

async function collect<T>(events: AsyncGenerator<T>): Promise<T[]> {
  const found: T[] = [];
  for await (const event of events) {
    found.push(event);
  }
  return found;
}

/**
 * The seq of the first (or, with `latest`, the last) turn request after the
 * cursor that `counts` accepts, or null when there is none.
 */
async function turnRequestSince(
  bb: BbPluginApi,
  threadId: string,
  sinceSeq: number,
  counts: (data: TurnRequestData) => boolean | Promise<boolean>,
  latest = false,
): Promise<number | null> {
  let found: number | null = null;
  for await (const event of eventsSince(bb, threadId, sinceSeq, "client/turn/requested")) {
    if (await counts(event.data)) {
      if (!latest) {
        return event.seq;
      }
      found = event.seq;
    }
  }
  return found;
}

function isUserRequest(data: TurnRequestData): boolean {
  return (
    data.initiator === "user" &&
    !data.input.some((part) => part.type === "text" && part.text.startsWith(AUTO_REVIEW_MARKER))
  );
}

/**
 * A user request typed in chat: the user's own (`isUserRequest`) and not sent on
 * their behalf by a plugin (`originPluginId`, e.g. the advisor's queue message)
 * or another thread (`senderThreadId`, i.e. a child's `bb thread tell`). A
 * missing field and a null one mean the same. `originPluginId` is on the event
 * row at runtime — `events.list` returns the stored row as the server serves it
 * (`originPluginId: "advisor"` at seq 239 of thr_w7c3pt43uv) — but the SDK's
 * event type declares only `senderThreadId`.
 */
function isTypedUserRequest(data: TurnRequestData): boolean {
  const { originPluginId } = data as TurnRequestData & { originPluginId?: string | null };
  return isUserRequest(data) && originPluginId == null && data.senderThreadId == null;
}

/** Whether a request steered: it names an expected turn and landed in that turn, which is read from the turn that accepted it. */
function steersTurn(target: TurnRequestData["target"], turnId: string): boolean {
  return "expectedTurnId" in target && target.expectedTurnId === turnId;
}

/**
 * Whether the request carries the code-review prompt's opening text, so the
 * turn it was accepted into is the review's own: auto-review delivered the
 * prompt as a turn request (steered into a running turn or starting one), and
 * plan-review prompts open differently, so this matches only code reviews.
 */
function isCodeReviewRequest(data: TurnRequestData): boolean {
  return data.input.some((part) => part.type === "text" && part.text.startsWith(CODE_REVIEW_OPENING));
}

/**
 * The plan approval the interaction lifecycle event resolved, or null when it
 * resolves none: a `resolved` approval whose decision is `allow_once` or
 * `allow_for_session` of a plan, or a held plan-approval form answered
 * `approved` through the app (`planFormResolution`); a deny, an interaction still
 * `resolving`, or an approval of anything else is not one. The event carries
 * no resolver, so the caller tells an approval the user gave from one
 * auto-review gave itself.
 * `requestedSeq` rides along: when the interaction was asked for.
 */
function approvedPlanOf(
  event: EventOf<"system/interaction/lifecycle">,
  requestedSeq: number | undefined,
): ApprovedPlan | null {
  const { interaction } = event.data;
  const form = planFormResolution(event);
  if (form !== null) {
    return form.held && form.approved && form.app ? { id: interaction.id, seq: event.seq, requestedSeq } : null;
  }
  if (
    interaction.payload.kind !== "approval" ||
    interaction.payload.subject.kind !== "plan" ||
    interaction.status !== "resolved"
  ) {
    return null;
  }
  const { resolution } = interaction;
  if (
    resolution === null ||
    !("decision" in resolution) ||
    (resolution.decision !== "allow_once" && resolution.decision !== "allow_for_session")
  ) {
    return null;
  }
  return { id: interaction.id, seq: event.seq, requestedSeq };
}

/**
 * What a lifecycle event says about plan approval: `approved` for an approval
 * `approvedPlanOf` credits, `denied` for a resolved native `deny` of a plan or a
 * resolved plan-approval form answered `approved: false` (held or detached: a
 * request for changes is a request whoever was shown it), and null for
 * everything else — a `resolving` row, even one already carrying a deny, an
 * approval the gate does not credit (a detached form, one answered through
 * `api`), and anything that is not a plan.
 */
function planDecisionOf(event: EventOf<"system/interaction/lifecycle">): "approved" | "denied" | null {
  if (approvedPlanOf(event, undefined) !== null) {
    return "approved";
  }
  const { interaction } = event.data;
  const form = planFormResolution(event);
  if (form !== null) {
    return form.approved ? null : "denied";
  }
  const { resolution } = interaction;
  return interaction.payload.kind === "approval" &&
    interaction.payload.subject.kind === "plan" &&
    interaction.status === "resolved" &&
    resolution !== null &&
    "decision" in resolution &&
    resolution.decision === "deny"
    ? "denied"
    : null;
}

/**
 * Whether the thread's latest plan decision is an approval, across every turn:
 * the user's, an auto-approve resolution's and `PresentPlan`'s own
 * auto-approval (which leaves no interaction, so the cursor it recorded in the
 * thread state counts as an approval at that seq) all count as approvals, and a
 * denied plan — the user's, a changes-requested form, or auto-review's own
 * hold — cancels an earlier approval until a later approval. At the same seq a
 * denial wins. A plan released to a chat approval counts as approved by the
 * typed reply TypeSafe judges as approval (`chatApprovalSeq`), when no
 * approval above settled it. A thread with no decision at all is not approved. A failed read,
 * including the page cap on a long walk, throws, so the caller fails closed.
 */
export async function planLatestDecisionApproves(bb: BbPluginApi, threadId: string): Promise<boolean> {
  // The latest decision is an approval iff the newest approval is strictly newer than the newest denial.
  let approvedSeq = -1;
  let deniedSeq = -1;
  for await (const event of eventsSince(bb, threadId, 0, "system/interaction/lifecycle")) {
    const decision = planDecisionOf(event);
    if (decision === "approved") {
      approvedSeq = Math.max(approvedSeq, event.seq);
    } else if (decision === "denied") {
      deniedSeq = Math.max(deniedSeq, event.seq);
    }
  }
  if (approvedSeq > deniedSeq) {
    // The auto-approval cursor can only move an approval later: the answer is already settled.
    return true;
  }
  const state = await readState(bb, threadId);
  if (state.presentPlanAutoApprovedSeq !== undefined && state.presentPlanAutoApprovedSeq > deniedSeq) {
    return true;
  }
  if (state.presentPlanChatReleasedSeq === undefined) {
    return false;
  }
  return (await chatApprovalSeq(bb, threadId, state.presentPlanChatReleasedSeq, deniedSeq, state.presentPlanChatVerdicts ?? {})) !== null;
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
async function chatApprovalSeq(
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
    const { value: released } = await eventsSince(bb, threadId, releasedSeq, "turn/completed").next();
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
          verdicts[key] = value;
          await writeState(bb, threadId, { presentPlanChatVerdicts: verdicts });
        }
      }
      approves.push(value);
      if (value !== null && value >= CHAT_APPROVAL_THRESHOLD) {
        bb.log.info(`auto-review: the reply at seq ${seq} in ${threadId} was judged as approval of the plan (approves ${value}), so the missing-plan check counts it`);
        return seq;
      }
    }
    return noCredit(approves.length === 0 ? "no typed reply to judge between the release and the first change" : "no reply judged as approval");
  } catch (error) {
    return noCredit(`the reply could not be read: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * A plan approval a turn resolved, with the seq of the lifecycle event that
 * resolved it and the seq of the interaction's earliest `pending` event in
 * the window — when the approval was requested, which is not when it
 * resolved: the turn blocks in between. `requestedSeq` is undefined when no
 * `pending` event for the interaction is among the lifecycle events the turn
 * was read from; the request can predate that window. A re-emitted `pending`
 * whose original fell before the window would still be the only one seen;
 * re-emitting is not a known host behaviour.
 */
export interface ApprovedPlan {
  id: string;
  seq: number;
  requestedSeq: number | undefined;
}

export interface EndedTurn {
  /** Whether the user started the turn. */
  users: boolean;
  /** The seq of the turn's `turn/completed`: a stop after it was not pressed inside the turn. */
  completedSeq: number;
  /** The plan approvals the turn resolved, oldest first; a deny, an unresolved interaction or a non-plan approval is never among them. */
  approvedPlans: ApprovedPlan[];
  /** Whether any input accepted into the turn came from a request carrying the code-review prompt's opening: the review's own turn, steered into it or not. */
  reviewTurn: boolean;
}

/** No turn has completed since the last one handled: every idle's read ends here once it has caught up. */
export class NoTurnCompletedError extends Error {}

/** A turn completed after the cursor, but whether the user started it could not be read; `completedSeq` still marks it handled. */
export class UnreadTurnError extends Error {
  constructor(
    message: string,
    readonly completedSeq: number,
  ) {
    super(message);
  }
}

/**
 * The turn that has just ended, and whether the user started it. The turn is the
 * first to complete after `handledSeq` (the cursor when none was handled yet),
 * not the newest accepted input: core may have drained the next queued turn, or
 * several, before this idle is handled, so the caller reads them one after the
 * other, each from the end of the last. The
 * requests that started it are those accepted into it that are not steers,
 * found by `clientRequestId` among the `client/turn/requested` rows since the
 * cursor, which a queued request's row, logged before the turn it waited behind
 * ended, is inside. The accepted event is always turn-scoped, so whether a
 * request steered is read from where it landed, whatever its kind: it steered
 * iff its target names an expected turn and that is the turn it was accepted
 * into. A `steer` or `auto` request whose expected turn had ended landed in a
 * turn of its own, so it began that turn. If inputs were batched into one turn,
 * any of them being the user's makes it the user's. A turn with no input
 * accepted into it since the cursor, or only steers, began before the cursor,
 * such as one the review prompt was steered into, and is not the user's. The
 * plan approvals the turn resolved are read from its interaction lifecycle
 * events whatever requests it took, so a turn with none of the user's own
 * input still names them. This assumes a plan approval resolves inside the
 * turn that requested it — the turn blocks until the interaction resolves —
 * so an approval that resolves after that turn's idle is not re-read. Whether
 * the turn is the review's own comes from the
 * same requests: any input accepted into it that carries the code-review
 * prompt's opening marks it (`reviewTurn`), steered into the turn or not.
 *
 * Throws a `NoTurnCompletedError` when no turn completed after `handledSeq`. Once a turn did, a failure
 * to read it (a lookup error, an accepted input with no request row) throws an
 * `UnreadTurnError` carrying its end, so the caller decides what an unreadable
 * turn counts as and still moves past it.
 */
export async function endedTurn(
  bb: BbPluginApi,
  threadId: string,
  sinceSeq: number,
  handledSeq = sinceSeq,
): Promise<EndedTurn> {
  const { value: completed } = await eventsSince(bb, threadId, Math.max(sinceSeq, handledSeq), "turn/completed").next();
  if (completed === undefined) {
    throw new NoTurnCompletedError(`no turn completed since seq ${Math.max(sinceSeq, handledSeq)}`);
  }
  if (completed.scope.kind !== "turn") {
    throw new UnreadTurnError(`the end of a turn at seq ${completed.seq} names no turn`, completed.seq);
  }
  const { turnId } = completed.scope;
  try {
    const accepted = (await collect(eventsSince(bb, threadId, sinceSeq, "turn/input/accepted"))).filter(
      ({ scope }) => scope.kind === "turn" && scope.turnId === turnId,
    );
    // A plan approval resolves inside the turn that requested it, but the request itself can
    // predate the window: the pending step is matched by interaction id across every lifecycle
    // event read, not by the ended turn's scope.
    const lifecycle = await collect(eventsSince(bb, threadId, sinceSeq, "system/interaction/lifecycle"));
    // The earliest `pending` seq wins: the set-aside rule fails open, so a re-emitted or
    // reused `pending` after the review's delivery must not set aside an approval first
    // requested before that delivery.
    const requestedSeqOf = new Map<string, number>();
    for (const event of lifecycle) {
      if (event.data.interaction.status !== "pending") {
        continue;
      }
      const earliest = requestedSeqOf.get(event.data.interaction.id);
      if (earliest === undefined || event.seq < earliest) {
        requestedSeqOf.set(event.data.interaction.id, event.seq);
      }
    }
    const approvedPlans = lifecycle
      .filter(({ scope }) => scope.kind === "turn" && scope.turnId === turnId)
      .flatMap((event) => {
        const approval = approvedPlanOf(event, requestedSeqOf.get(event.data.interaction.id));
        return approval === null ? [] : [approval];
      });
    if (accepted.length === 0) {
      return { users: false, completedSeq: completed.seq, approvedPlans, reviewTurn: false };
    }
    const requests = new Map(
      (await collect(eventsSince(bb, threadId, sinceSeq, "client/turn/requested"))).map((event) => [
        event.data.requestId,
        event.data,
      ]),
    );
    let users = false;
    let reviewTurn = false;
    for (const { data } of accepted) {
      const request = requests.get(data.clientRequestId);
      if (request === undefined) {
        throw new Error(`no turn request ${data.clientRequestId} for the input accepted into turn ${turnId}`);
      }
      users ||= !steersTurn(request.target, turnId) && isUserRequest(request);
      // Steered or not: a review prompt steered into a running turn makes that turn the review's own.
      reviewTurn ||= isCodeReviewRequest(request);
    }
    return { users, completedSeq: completed.seq, approvedPlans, reviewTurn };
  } catch (error) {
    throw new UnreadTurnError(error instanceof Error ? error.message : String(error), completed.seq);
  }
}

/**
 * The seq of the first turn request the user made after the cursor, or null
 * when there is none. Turns auto-review sent itself carry the user's initiator
 * too, so a request whose text opens with the auto-review marker does not count.
 */
export async function firstUserTurnSince(
  bb: BbPluginApi,
  threadId: string,
  sinceSeq: number,
): Promise<number | null> {
  return turnRequestSince(bb, threadId, sinceSeq, isUserRequest);
}

/**
 * Whether no turn of any kind ran after the cursor: no request from any
 * initiator (wake-ups, tells and background-task completions included), and no
 * turn start or end either, since a request that arrived while the park
 * snapshot was read can sit before the cursor with its turn after it. A read
 * failure is not quiet.
 */
export async function quietSincePark(
  bb: BbPluginApi,
  threadId: string,
  sinceSeq: number,
): Promise<boolean> {
  try {
    if ((await turnRequestSince(bb, threadId, sinceSeq, () => true)) !== null) {
      return false;
    }
    for (const type of ["turn/started", "turn/completed"] as const) {
      const { value } = await eventsSince(bb, threadId, sinceSeq, type).next();
      if (value !== undefined) {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * The seq of the request that started the turn running now, when that turn is
 * the user's: the latest request after the cursor that is not a steer, the
 * user's own or with a steer of the user's after it. Null when there is no such
 * request or the turn is neither. A steer joins the running turn, so it never
 * names the turn's start; nor does an `auto` request of the user's that expects
 * a turn (it steers that turn if it is active, else starts one), which reads as
 * a steer so the anchor stays at the earlier start. A non-user `auto` request is
 * bb's own wake-up in the same shape, and starts a turn once the expected one
 * has ended, so it reads as a turn start.
 */
export async function userTurnRunningSince(
  bb: BbPluginApi,
  threadId: string,
  sinceSeq: number,
): Promise<number | null> {
  let users = false;
  const seq = await turnRequestSince(
    bb,
    threadId,
    sinceSeq,
    (data) => {
      const user = isUserRequest(data);
      if (
        data.target.kind === "steer" ||
        (user && data.target.kind === "auto" && data.target.expectedTurnId !== null)
      ) {
        users ||= user;
        return false;
      }
      users = user;
      return true;
    },
    true,
  );
  return users ? seq : null;
}
