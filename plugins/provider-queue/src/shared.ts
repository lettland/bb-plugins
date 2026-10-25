import type { MessageDispatchHookDecision } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const QUEUE_KEY = "queue-entries";
export const LIMITS_KEY = "provider-limits";
export const KEEPER_INTERVAL_MS = 30_000;
export const MAX_ANCESTOR_DEPTH = 64;
export const MAX_PROVIDER_CACHE = 5_000;
export const MAX_REASON_LENGTH = 200;
export const INTERACTION_TTL_MS = 5_000;
export const DEFAULT_LIMIT = 2;

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

export const queueEntriesSchema = z.array(
  z
    .object({ threadId: z.string().min(1), providerId: z.string().min(1) })
    .strict(),
);
export const limitsSchema = z.record(z.string(), z.number().int().min(0));
export const queueIntentSchema = z.object({ queue: z.literal(true) }).strict();

export const DIRECTIONS = ["up", "down", "top", "bottom"] as const;
export type Direction = (typeof DIRECTIONS)[number];

export const providerSummarySchema = z.object({
  providerId: z.string(),
  label: z.string(),
  limit: z.number().int().min(0),
  running: z.array(z.object({ threadId: z.string(), title: z.string() })),
  awaiting: z.array(z.object({ threadId: z.string(), title: z.string() })),
  queue: z.array(
    z.object({
      threadId: z.string(),
      title: z.string(),
      providerId: z.string(),
    }),
  ),
});
export type ProviderSummary = z.infer<typeof providerSummarySchema>;
export type SlotRow = ProviderSummary["running"][number];
export type QueueRow = ProviderSummary["queue"][number];

export const PROCEED: MessageDispatchHookDecision = { action: "proceed" };

export interface ReleaseEntry {
  id: string;
  cause: string;
}

export type QueueEntry = z.infer<typeof queueEntriesSchema>[number];

export interface QueuedThreadRef {
  id: string;
  parentThreadId: string | null;
}

export type QueuedView =
  | {
      threadId: string;
      state: "queued";
      title: string | null;
      providerId: string;
      provider: string;
      waiting: string | null;
    }
  | { threadId: string; state: "stale"; reason: string }
  | { threadId: string; state: "unknown"; error: string };

interface ThreadState {
  status: string;
  archivedAt: number | null;
  deletedAt: number | null;
}

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

function truncateReason(reason: string): string {
  if (reason.length <= MAX_REASON_LENGTH) return reason;
  let truncated = reason.slice(0, MAX_REASON_LENGTH - 1);
  const last = truncated.charCodeAt(truncated.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) {
    truncated = truncated.slice(0, -1);
  }
  return `${truncated}…`;
}

export function waitDecision(
  occupancy: number,
  label: string,
  limit: number,
): string {
  const reason = `${occupancy} thread${occupancy === 1 ? "" : "s"} running on ${label}, limit ${limit}`;
  return truncateReason(reason);
}

export function pausedReason(label: string): string {
  return truncateReason(`${label} is paused (limit 0)`);
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
