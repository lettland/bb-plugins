import type { BbPluginApi } from "@get-bb/plugin-sdk";

import { AUTO_REVIEW_MARKER, CODE_REVIEW_OPENING } from "./prompt.js";

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

/** The most events one `threads.events.list` page may request; the server rejects a larger `limit`. */
export const EVENT_PAGE_MAX = 100;
/** Bounds the walk through a thread with a very long run of turn requests: 50 pages of 100. */
const TURN_REQUEST_MAX_PAGES = 50;

type EventPage = Awaited<ReturnType<BbPluginApi["sdk"]["threads"]["events"]["list"]>>;
type EventOf<T extends EventPage[number]["type"]> = Extract<EventPage[number], { type: T }>;
type TurnRequestData = EventOf<"client/turn/requested">["data"];

/**
 * The events of one type after the cursor, oldest first. The event log is paged,
 * so a long run of them could push the one that matters past the first page;
 * this walks the pages, and throws if the walk hits its cap rather than let the
 * caller conclude "none" from a log it did not finish reading.
 */
async function* eventsSince<T extends EventPage[number]["type"]>(
  bb: BbPluginApi,
  threadId: string,
  sinceSeq: number,
  type: T,
): AsyncGenerator<EventOf<T>> {
  let afterSeq = sinceSeq;
  for (let page = 0; page < TURN_REQUEST_MAX_PAGES; page += 1) {
    const events = await bb.sdk.threads.events.list({
      threadId,
      afterSeq: String(afterSeq),
      types: [type],
      order: "asc",
      limit: String(EVENT_PAGE_MAX),
    });
    for (const event of events) {
      if (event.type === type) {
        yield event as EventOf<T>;
      }
    }
    const last = events.at(-1);
    if (last === undefined || events.length < EVENT_PAGE_MAX) {
      return;
    }
    afterSeq = last.seq;
  }
  throw new Error(`more than ${TURN_REQUEST_MAX_PAGES * EVENT_PAGE_MAX} ${type} events since seq ${sinceSeq}`);
}

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
 * `allow_for_session` of a plan; a deny, an interaction still `resolving`, or
 * an approval of anything else is not one. The event carries no resolver, so
 * the caller tells an approval the user gave from one auto-review gave itself.
 * `requestedSeq` rides along: when the interaction was asked for.
 */
function approvedPlanOf(
  event: EventOf<"system/interaction/lifecycle">,
  requestedSeq: number | undefined,
): ApprovedPlan | null {
  const { interaction } = event.data;
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
 * A plan approval a turn resolved, with the seq of the lifecycle event that
 * resolved it and the seq of the interaction's `pending` event — when the
 * approval was requested, which is not when it resolved: the turn blocks in
 * between. `requestedSeq` is undefined when no `pending` event for the
 * interaction is among the lifecycle events the turn was read from; the
 * request can predate that window.
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
      const { target } = request;
      const steers = "expectedTurnId" in target && target.expectedTurnId === turnId;
      users ||= !steers && isUserRequest(request);
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
