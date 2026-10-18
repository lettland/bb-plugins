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

type TurnRequestData = Extract<
  Awaited<ReturnType<BbPluginApi["sdk"]["threads"]["events"]["list"]>>[number],
  { type: "client/turn/requested" }
>["data"];

/**
 * The seq of the first (or, with `latest`, the last) turn request after the
 * cursor that `counts` accepts, or null when there is none. The event log is
 * paged, so a long run of wake-up requests could push the one that counts past
 * the first page; this walks the pages, oldest first, and throws if the walk
 * hits its cap rather than answer "none" for a log it did not finish reading.
 */
async function turnRequestSince(
  bb: BbPluginApi,
  threadId: string,
  sinceSeq: number,
  counts: (data: TurnRequestData) => boolean | Promise<boolean>,
  latest = false,
): Promise<number | null> {
  let afterSeq = sinceSeq;
  let found: number | null = null;
  for (let page = 0; page < TURN_REQUEST_MAX_PAGES; page += 1) {
    const events = await bb.sdk.threads.events.list({
      threadId,
      afterSeq: String(afterSeq),
      types: ["client/turn/requested"],
      order: "asc",
      limit: String(EVENT_PAGE_MAX),
    });
    for (const event of events) {
      if (event.type === "client/turn/requested" && (await counts(event.data))) {
        if (!latest) {
          return event.seq;
        }
        found = event.seq;
      }
    }
    const last = events.at(-1);
    if (last === undefined || events.length < EVENT_PAGE_MAX) {
      return found;
    }
    afterSeq = last.seq;
  }
  throw new Error(`more than ${TURN_REQUEST_MAX_PAGES * EVENT_PAGE_MAX} turn requests since seq ${sinceSeq}`);
}

function isUserRequest(data: TurnRequestData): boolean {
  return (
    data.initiator === "user" &&
    !data.input.some((part) => part.type === "text" && part.text.startsWith(AUTO_REVIEW_MARKER))
  );
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
