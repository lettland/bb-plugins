import type {
  PluginSidebarThreadIndicator,
  PluginThreadStatus,
  PluginThreadStatusInput,
  PluginThreadStatusThread,
} from "@get-bb/plugin-sdk/app";
import type { ForkThreadStatus } from "../../fork-sdk-types";

// A local copy of the SDK's `experimental_resolveThreadStatus`, plus the
// fork-only plan-approval and answer glyphs. `bb plugin build` fixes the export
// list of `@get-bb/plugin-sdk/app` from the SDK bundled in the bb that builds
// the plugin, and the stable bb that the release workflow installs (0.48.1,
// SDK 0.6.104) predates this export. The reference is
// `@get-bb/plugin-sdk/dist/internal/thread-status.js`; thread-status.test.ts
// checks this copy against the installed SDK, so a drift shows up on the next
// SDK bump.

type ResolvedIndicator = Exclude<PluginSidebarThreadIndicator, "none">;

interface StatusFlags {
  pending: boolean;
  unreadError: boolean;
  unreadSuccess: boolean;
  runtime: boolean;
  workflow: boolean;
  backgroundAgent: boolean;
  backgroundCommand: boolean;
  planMode: boolean;
  goal: boolean;
}

const INDICATOR_LABELS: Record<ResolvedIndicator, string> = {
  "unread-error": "Unread thread failed",
  "waiting-for-input": "Thread needs user input",
  "working-draft": "Thread working with unsubmitted draft",
  workflow: "Workflow running",
  "background-agent": "Background agent running",
  "background-command": "Background command running",
  "plan-mode": "Plan mode active",
  goal: "Goal active",
  runtime: "Thread working",
  "queued-failed": "Queued message failed to send",
  "queued-waiting": "Thread has a message waiting to send",
  draft: "Thread has unsubmitted draft",
  "unread-success": "Unread thread succeeded",
};

const RUNNING_RUNTIME_STATUSES: Record<
  PluginThreadStatusThread["runtimeStatus"],
  boolean
> = {
  active: true,
  provisioning: true,
  starting: true,
  stopping: true,
  error: false,
  idle: false,
  pending: false,
  "waiting-for-host": false,
};

const DONE_THREAD_STATUSES: Record<PluginThreadStatusThread["status"], boolean> =
  {
    error: true,
    idle: true,
    active: false,
    starting: false,
    stopping: false,
    pending: false,
  };

const INDICATORS_OVER_ROW_STATUS: ReadonlySet<PluginSidebarThreadIndicator> =
  new Set(["runtime", "unread-error", "waiting-for-input"]);

function isUnreadDoneThread(thread: PluginThreadStatusThread): boolean {
  return (
    thread.parentThreadId === null &&
    thread.isUnread &&
    DONE_THREAD_STATUSES[thread.status]
  );
}

function addThreadFlags(
  flags: StatusFlags,
  thread: PluginThreadStatusThread,
): void {
  const unreadDone = isUnreadDoneThread(thread);
  flags.pending ||= thread.hasPendingInteraction;
  flags.unreadError ||= unreadDone && thread.status === "error";
  flags.unreadSuccess ||= unreadDone && thread.status !== "error";
  flags.runtime ||= RUNNING_RUNTIME_STATUSES[thread.runtimeStatus];
  flags.workflow ||= thread.activity.workflows > 0;
  flags.backgroundAgent ||= thread.activity.backgroundAgents > 0;
  flags.backgroundCommand ||= thread.activity.backgroundCommands > 0;
  flags.planMode ||= thread.activity.planMode > 0;
  flags.goal ||= thread.activity.goals > 0;
}

function resolveIndicator(
  flags: StatusFlags,
  queuedWork: PluginThreadStatusThread["queuedWork"],
  hasUnsubmittedDraft: boolean,
  isWorking: boolean,
): PluginSidebarThreadIndicator {
  if (flags.unreadError) return "unread-error";
  if (flags.pending) return "waiting-for-input";
  if (hasUnsubmittedDraft && isWorking) return "working-draft";
  if (flags.planMode) return "plan-mode";
  if (flags.goal) return "goal";
  if (flags.runtime) return "runtime";
  if (flags.workflow) return "workflow";
  if (queuedWork === "failed") return "queued-failed";
  if (flags.unreadSuccess) return "unread-success";
  if (flags.backgroundAgent) return "background-agent";
  if (flags.backgroundCommand) return "background-command";
  if (queuedWork === "waiting") return "queued-waiting";
  if (hasUnsubmittedDraft) return "draft";
  return "none";
}

export function resolveSdkThreadStatus({
  thread,
  hiddenThreads,
  hasUnsubmittedDraft,
  rowStatus,
}: PluginThreadStatusInput): PluginThreadStatus {
  const flags: StatusFlags = {
    pending: false,
    unreadError: false,
    unreadSuccess: false,
    runtime: false,
    workflow: false,
    backgroundAgent: false,
    backgroundCommand: false,
    planMode: false,
    goal: false,
  };
  if (thread !== null) addThreadFlags(flags, thread);
  for (const hiddenThread of hiddenThreads) addThreadFlags(flags, hiddenThread);
  const isThreadWorking =
    flags.runtime ||
    flags.workflow ||
    flags.backgroundAgent ||
    flags.backgroundCommand ||
    flags.planMode ||
    flags.goal;
  const indicator = resolveIndicator(
    flags,
    thread?.queuedWork ?? "none",
    hasUnsubmittedDraft,
    isThreadWorking,
  );
  const shownRowStatus = INDICATORS_OVER_ROW_STATUS.has(indicator)
    ? null
    : rowStatus;
  return {
    indicator,
    rowStatus: shownRowStatus,
    label:
      shownRowStatus?.label ??
      (indicator === "none" ? null : INDICATOR_LABELS[indicator]),
    isWorking: isThreadWorking || rowStatus?.tone === "running",
  };
}

type PendingKind = "plan_approval" | "question" | null;

function pendingKindOf(thread: PluginThreadStatusThread): PendingKind {
  const indicator = "indicator" in thread ? thread.indicator : null;
  if (indicator === "waiting-for-plan-approval") return "plan_approval";
  if (indicator === "waiting-for-answer") return "question";
  return null;
}

function sharedKind(kinds: readonly PendingKind[]): PendingKind {
  const [first, ...rest] = kinds;
  if (first === undefined) return null;
  return rest.every((kind) => kind === first) ? first : null;
}

function forkStatusFor(
  kind: PendingKind,
): Pick<ForkThreadStatus, "indicator" | "label"> | null {
  if (kind === "plan_approval") {
    return {
      indicator: "waiting-for-plan-approval",
      label: "Thread needs plan approval",
    };
  }
  if (kind === "question") {
    return {
      indicator: "waiting-for-answer",
      label: "Thread is waiting for your answer",
    };
  }
  return null;
}

/**
 * What bb's lists draw for a row. When every pending thread on the row waits on
 * the same fork-only interaction (a plan approval or an answer), the generic
 * "waiting-for-input" indicator becomes that interaction's glyph. Stock hosts
 * draw an indicator they do not know as nothing, and the fork host draws it.
 */
export function resolveThreadStatus(
  input: PluginThreadStatusInput,
): PluginThreadStatus {
  const status = resolveSdkThreadStatus(input);
  if (status.indicator !== "waiting-for-input") return status;
  const pending = [input.thread, ...input.hiddenThreads].filter(
    (thread): thread is PluginThreadStatusThread =>
      thread !== null && thread.hasPendingInteraction,
  );
  const forkStatus = forkStatusFor(sharedKind(pending.map(pendingKindOf)));
  if (forkStatus === null) return status;
  const forked: ForkThreadStatus = { ...status, ...forkStatus, rowStatus: null };
  return forked as PluginThreadStatus;
}
