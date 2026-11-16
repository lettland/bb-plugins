import type { BbPluginApi } from "@get-bb/plugin-sdk";

type EventRow = Awaited<ReturnType<BbPluginApi["sdk"]["threads"]["events"]["list"]>>[number];

function isUserResponse(event: EventRow): boolean {
  if (event.type === "client/turn/requested") {
    // Triage 0.4.1 investigation, 2026-11-16: auto-review can use initiator user with its originPluginId set.
    const data = event.data as typeof event.data & { originPluginId?: string | null };
    return data.initiator === "user" && data.originPluginId == null && data.senderThreadId == null;
  }
  // The event list request below limits rows to these two types.
  const { status, resolution } = (event as Extract<EventRow, { type: "system/interaction/lifecycle" }>).data.interaction;
  if (status !== "resolved" || !resolution) return false;
  if ("kind" in resolution) {
    if (resolution.kind === "plugin_submitted") return (resolution as typeof resolution & { answeredVia?: unknown }).answeredVia === "app";
    return resolution.kind === "user_answer" || resolution.kind === "request_answer";
  }
  return resolution.decision === "allow_once" || resolution.decision === "allow_for_session";
}

export type ResponseProgress =
  | { phase: "history"; newestSeq: number; beforeSeq: string }
  | { phase: "forward"; afterSeq: number }
  | { phase: "found" };

export type ResponseScan =
  | { kind: "found"; progress: ResponseProgress }
  | { kind: "complete"; progress: ResponseProgress }
  | { kind: "incomplete"; progress: ResponseProgress }
  | { kind: "cancelled" };

export async function hasUserResponse(bb: BbPluginApi, threadId: string, placedAt: number, wanted: () => boolean, previous?: ResponseProgress): Promise<ResponseScan> {
  if (previous?.phase === "found") return { kind: "found", progress: previous };
  let progress = previous;
  let newestSeq = previous?.phase === "history" ? previous.newestSeq : 0;
  for (let page = 0; page < 10; page += 1) {
    const head = page === 0;
    const forward = !head && progress?.phase === "forward" ? progress : undefined;
    const events = await bb.sdk.threads.events.list({
      threadId, types: ["client/turn/requested", "system/interaction/lifecycle"], order: forward ? "asc" : "desc", limit: "100",
      ...(forward ? { afterSeq: String(forward.afterSeq) } : !head && progress?.phase === "history" ? { beforeSeq: progress.beforeSeq } : {}),
    });
    if (!wanted()) return { kind: "cancelled" };
    if (!previous && head) newestSeq = events[0]?.seq ?? 0;
    for (const event of events) {
      if (event.createdAt <= placedAt) {
        if (!forward && (!head || !previous)) break;
        continue;
      }
      if ((!head || previous?.phase !== "forward" || event.seq > previous.afterSeq) && isUserResponse(event)) return { kind: "found", progress: { phase: "found" } };
    }
    if (head && previous) continue;
    if (forward) {
      progress = { phase: "forward", afterSeq: events.length ? events[events.length - 1].seq : forward.afterSeq };
      if (events.length < 100) return { kind: "complete", progress };
    } else if (events.length < 100 || events.some((event) => event.createdAt <= placedAt)) {
      progress = { phase: "forward", afterSeq: newestSeq };
    } else {
      progress = { phase: "history", newestSeq, beforeSeq: String(events[events.length - 1].seq) };
    }
  }
  return { kind: "incomplete", progress: progress! };
}
