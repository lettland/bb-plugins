import type { BbPluginApi } from "@get-bb/plugin-sdk";
import {
  isStale,
  REVIEW_IN_FLIGHT_PHASES,
  type ThreadState,
} from "./state.js";

export interface GateThread {
  parentThreadId: string | null;
  originPluginId: string | null;
  visibility: string;
  environmentId: string | null;
  providerId: string;
}

export function passesThreadGate(thread: GateThread): boolean {
  if (thread.parentThreadId !== null) {
    return false;
  }
  if (thread.originPluginId !== null) {
    return false;
  }
  if (thread.visibility !== "visible") {
    return false;
  }
  if (thread.environmentId === null) {
    return false;
  }
  return true;
}

/** The only provider whose plan approvals reach auto-review's gate (see server.ts). */
export const PLAN_GATE_PROVIDER_ID = "claude-code";

/**
 * Whether auto-review's plan gate owns this thread's plan review. True only for a
 * top-level, visible, environment-bound `claude-code` thread with auto-review on —
 * every other thread (ACP, standalone, disabled/skipped, child) falls to whatever
 * reviews plans outside auto-review instead (e.g. agent-hooks' own hook).
 */
export function planGateServes(
  thread: GateThread,
  config: { enabled: boolean; skipped: boolean },
): boolean {
  return (
    config.enabled &&
    !config.skipped &&
    thread.providerId === PLAN_GATE_PROVIDER_ID &&
    passesThreadGate(thread)
  );
}

const BUSY_STATUSES = new Set(["active", "starting", "stopping"]);

type ThreadListEntry = Awaited<
  ReturnType<BbPluginApi["sdk"]["threads"]["list"]>
>[number];

export function isBusyStatus(status: string): boolean {
  return BUSY_STATUSES.has(status);
}

export function selfIsWorktree(
  entries: readonly ThreadListEntry[],
  selfThreadId: string,
): boolean {
  const self = entries.find((entry) => entry.id === selfThreadId);
  return self?.environmentIsWorktree === true;
}

export interface HeldReview {
  state: ThreadState;
  busy: boolean;
}

/**
 * Whether a thread's own auto-review is queued or running. That is the only
 * thing that parks another turn on the same provider: plain activity never
 * does, because every review stages just the files its own turn authored. A
 * latch past the stale window on a thread that is no longer busy is a lost
 * idle, not a review, so it does not count — one missed event must not park
 * every other turn on the provider for good. A latch with no dispatch time on
 * an idle thread cannot be dated at all, so it is treated the same way.
 */
export function reviewInFlight(review: HeldReview, now: number): boolean {
  if (!REVIEW_IN_FLIGHT_PHASES.includes(review.state.phase)) {
    return false;
  }
  if (review.busy) {
    return true;
  }
  return review.state.dispatchedAt !== undefined && !isStale(review.state, now);
}
