import type { MessageDispatchHookDecision } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const QUEUED_KEY = "queued-thread-ids";
export const KEEPER_INTERVAL_MS = 30_000;
export const MAX_ANCESTOR_DEPTH = 64;
export const MAX_PROJECT_CACHE = 5_000;
export const MAX_REASON_LENGTH = 200;

export const REASONING_LEVELS = [
  "none",
  "low",
  "medium",
  "high",
  "xhigh",
  "ultracode",
  "max",
  "ultra",
] as const;
export const PERMISSION_MODES = ["accept-edits", "auto", "full"] as const;

export const JSON_OPTION = {
  type: "boolean",
  description: "Emit machine-readable JSON",
} as const;

export const queuedIdsSchema = z.array(z.string().min(1));
export const queueIntentSchema = z.object({ queue: z.literal(true) });

export const PROCEED: MessageDispatchHookDecision = { action: "proceed" };

export interface ReleaseEntry {
  id: string;
  cause: string;
}

export interface QueuedThreadRef {
  id: string;
  projectId: string;
  parentThreadId: string | null;
}

interface ThreadState {
  status: string;
  archivedAt: number | null;
  deletedAt: number | null;
}

export type QueuedView =
  | {
      id: string;
      state: "queued";
      title: string | null;
      projectId: string;
      project: string;
      blockers: string[];
    }
  | { id: string; state: "stale"; reason: string }
  | { id: string; state: "unknown"; error: string };

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function httpStatus(error: unknown): number | null {
  if (typeof error !== "object" || error === null || !("status" in error)) {
    return null;
  }
  return typeof error.status === "number" ? error.status : null;
}

export function staleReason(thread: ThreadState): string | null {
  if (thread.status !== "pending") return `thread is ${thread.status}`;
  if (thread.deletedAt !== null) return "thread was deleted";
  if (thread.archivedAt !== null) return "thread was archived";
  return null;
}

export function waitDecision(
  blockerCount: number,
  projectName: string,
): MessageDispatchHookDecision {
  const reason = `${blockerCount} other thread${blockerCount === 1 ? "" : "s"} running in ${projectName}`;
  if (reason.length <= MAX_REASON_LENGTH) {
    return { action: "wait", reason };
  }
  let truncated = reason.slice(0, MAX_REASON_LENGTH - 1);
  const last = truncated.charCodeAt(truncated.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) {
    truncated = truncated.slice(0, -1);
  }
  return { action: "wait", reason: `${truncated}…` };
}

export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolveSleep) => {
    if (signal.aborted) {
      resolveSleep();
      return;
    }
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolveSleep();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}
