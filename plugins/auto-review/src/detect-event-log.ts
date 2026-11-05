import type { BbPluginApi } from "@get-bb/plugin-sdk";

/** The most events one `threads.events.list` page may request; the server rejects a larger `limit`. */
export const EVENT_PAGE_MAX = 100;
/** Bounds the walk through a thread with a very long run of turn requests: 50 pages of 100. */
const TURN_REQUEST_MAX_PAGES = 50;

export type EventPage = Awaited<ReturnType<BbPluginApi["sdk"]["threads"]["events"]["list"]>>;
export type EventOf<T extends EventPage[number]["type"]> = Extract<EventPage[number], { type: T }>;

/**
 * The events of one type after the cursor, oldest first. The event log is paged,
 * so a long run of them could push the one that matters past the first page;
 * this walks the pages, and throws if the walk hits its cap rather than let the
 * caller conclude "none" from a log it did not finish reading.
 */
export async function* eventsSince<T extends EventPage[number]["type"]>(
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
