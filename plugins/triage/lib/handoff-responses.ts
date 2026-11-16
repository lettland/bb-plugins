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
  if ("kind" in resolution) return resolution.kind === "user_answer" || resolution.kind === "request_answer";
  return resolution.decision === "allow_once" || resolution.decision === "allow_for_session";
}

export async function hasUserResponse(bb: BbPluginApi, threadId: string, placedAt: number, wanted: () => boolean): Promise<boolean> {
  let beforeSeq: string | undefined;
  for (let page = 0; page < 10; page += 1) {
    const events = await bb.sdk.threads.events.list({ threadId, types: ["client/turn/requested", "system/interaction/lifecycle"], order: "desc", limit: "100", ...(beforeSeq ? { beforeSeq } : {}) });
    if (!wanted()) return false;
    for (const event of events) {
      if (event.createdAt <= placedAt) return false;
      if (isUserResponse(event)) return true;
    }
    if (events.length < 100) return false;
    beforeSeq = String(events[events.length - 1].seq);
  }
  return false;
}
