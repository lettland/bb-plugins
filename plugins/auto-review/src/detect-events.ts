import type { BbPluginApi } from "@get-bb/plugin-sdk";

import { AUTO_REVIEW_MARKER } from "./prompt.js";

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
 * Whether the turn that has just ended was started by the user. The turn is the
 * one the latest `turn/input/accepted` after the cursor names; the requests
 * that started it are those accepted into it that are not steers, found by
 * `clientRequestId` among the `client/turn/requested` rows since the cursor,
 * which a queued request's row, logged before the turn it waited behind ended,
 * is inside. The accepted event is always turn-scoped, so whether a request
 * steered is read from where it landed, whatever its kind: it steered iff its
 * target names an expected turn and that is the turn it was accepted into. A
 * `steer` or `auto` request whose expected turn had ended landed in a turn of
 * its own, so it began that turn. If inputs were batched into one turn, any of
 * them being the user's makes it the user's. A turn whose only inputs since the
 * cursor are steers began before it, such as one the review prompt was steered
 * into, and is not the user's.
 *
 * Throws when no turn input was accepted since the cursor, or an accepted input
 * has no request row, so the caller decides what an unreadable turn counts as.
 */
export async function endedTurnIsUsers(
  bb: BbPluginApi,
  threadId: string,
  sinceSeq: number,
): Promise<boolean> {
  const accepted = await collect(eventsSince(bb, threadId, sinceSeq, "turn/input/accepted"));
  const ended = accepted.at(-1)?.scope;
  if (ended === undefined || ended.kind !== "turn") {
    throw new Error(`no turn input was accepted since seq ${sinceSeq}`);
  }
  const requests = new Map(
    (await collect(eventsSince(bb, threadId, sinceSeq, "client/turn/requested"))).map((event) => [
      event.data.requestId,
      event.data,
    ]),
  );
  let users = false;
  for (const { data, scope } of accepted) {
    if (scope.kind !== "turn" || scope.turnId !== ended.turnId) {
      continue;
    }
    const request = requests.get(data.clientRequestId);
    if (request === undefined) {
      throw new Error(`no turn request ${data.clientRequestId} for the input accepted into turn ${ended.turnId}`);
    }
    const { target } = request;
    const steers = "expectedTurnId" in target && target.expectedTurnId === ended.turnId;
    users ||= !steers && isUserRequest(request);
  }
  return users;
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
