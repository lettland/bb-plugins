import type {
  PluginSidebarThread,
  PluginSidebarThreadRowStatus,
} from "@get-bb/plugin-sdk/app";
import type { PluginSidebarThreadIndicator } from "../../fork-sdk-types";

type ThreadStatusShape = Pick<
  PluginSidebarThread,
  "status" | "isUnread" | "parentThreadId"
>;
type ThreadRuntimeShape = Pick<PluginSidebarThread, "runtimeStatus">;
type ThreadActivityStateShape = Pick<PluginSidebarThread, "activity">;

const RUNNING_RUNTIME_STATUSES: Record<
  PluginSidebarThread["runtimeStatus"],
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

const DONE_THREAD_STATUSES: Record<PluginSidebarThread["status"], boolean> = {
  error: true,
  idle: true,
  active: false,
  starting: false,
  stopping: false,
  pending: false,
};

export function isRuntimeBusyThread(thread: ThreadRuntimeShape): boolean {
  return RUNNING_RUNTIME_STATUSES[thread.runtimeStatus] ?? false;
}

function hasActiveWorkflowActivity(thread: ThreadActivityStateShape): boolean {
  return thread.activity.workflows > 0;
}

function hasActiveBackgroundAgentActivity(
  thread: ThreadActivityStateShape,
): boolean {
  return thread.activity.backgroundAgents > 0;
}

function hasActiveBackgroundCommandActivity(
  thread: ThreadActivityStateShape,
): boolean {
  return thread.activity.backgroundCommands > 0;
}

function hasActivePlanModeActivity(thread: ThreadActivityStateShape): boolean {
  return thread.activity.planMode > 0;
}

function hasActiveGoalActivity(thread: ThreadActivityStateShape): boolean {
  return thread.activity.goals > 0;
}

function isBusyThread(
  thread: ThreadRuntimeShape & ThreadActivityStateShape,
): boolean {
  return (
    isRuntimeBusyThread(thread) ||
    hasActiveWorkflowActivity(thread) ||
    hasActiveBackgroundAgentActivity(thread) ||
    hasActiveBackgroundCommandActivity(thread) ||
    hasActivePlanModeActivity(thread) ||
    hasActiveGoalActivity(thread)
  );
}

type PendingInteractionKind = "plan_approval" | "question";

export interface ThreadListIndicatorState {
  hasPendingInteraction: boolean;
  hasUnsubmittedDraft: boolean;
  hasUnreadError: boolean;
  hasUnreadSuccess: boolean;
  isBackgroundAgentActive: boolean;
  isBackgroundCommandActive: boolean;
  isGoalActive: boolean;
  isPlanModeActive: boolean;
  isRuntimeActive: boolean;
  isWorkflowActive: boolean;
  pendingInteractionKind: PendingInteractionKind | null;
  queuedWork: PluginSidebarThread["queuedWork"];
}

export type ThreadListIndicatorKind = PluginSidebarThreadIndicator;

const THREAD_LIST_INDICATOR_LABELS: Record<
  Exclude<ThreadListIndicatorKind, "none">,
  string
> = {
  "unread-error": "Unread thread failed",
  "waiting-for-input": "Thread needs user input",
  "waiting-for-plan-approval": "Thread needs plan approval",
  "waiting-for-answer": "Thread is waiting for your answer",
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

export function getThreadListIndicatorLabel(
  kind: ThreadListIndicatorKind,
): string | null {
  return kind === "none" ? null : THREAD_LIST_INDICATOR_LABELS[kind];
}

interface ThreadStatusResolution {
  accessibleLabel: string | null;
  indicatorKind: ThreadListIndicatorKind;
  rowStatusIsVisible: boolean;
}

export function resolveThreadStatus(
  state: ThreadListIndicatorState,
  rowStatus: PluginSidebarThreadRowStatus | null,
): ThreadStatusResolution {
  const indicatorKind = resolveThreadListIndicator(state);
  const rowStatusIsVisible =
    rowStatus !== null &&
    indicatorKind !== "runtime" &&
    indicatorKind !== "unread-error" &&
    indicatorKind !== "waiting-for-input" &&
    indicatorKind !== "waiting-for-plan-approval" &&
    indicatorKind !== "waiting-for-answer";
  return {
    accessibleLabel: rowStatusIsVisible
      ? rowStatus.label
      : getThreadListIndicatorLabel(indicatorKind),
    indicatorKind,
    rowStatusIsVisible,
  };
}

export function hasThreadListWorkingActivity(
  state: ThreadListIndicatorState,
  hasRunningPluginStatus = false,
): boolean {
  return (
    state.isRuntimeActive ||
    state.isWorkflowActive ||
    state.isBackgroundAgentActive ||
    state.isBackgroundCommandActive ||
    state.isPlanModeActive ||
    state.isGoalActive ||
    hasRunningPluginStatus
  );
}

function pendingInteractionKindOf(
  indicator: PluginSidebarThreadIndicator | string,
): PendingInteractionKind | null {
  if (indicator === "waiting-for-plan-approval") return "plan_approval";
  if (indicator === "waiting-for-answer") return "question";
  return null;
}

function waitingIndicatorForPendingInteraction(
  kind: string | null,
): ThreadListIndicatorKind {
  if (kind === "plan_approval") return "waiting-for-plan-approval";
  if (kind === "question") return "waiting-for-answer";
  return "waiting-for-input";
}

export function combineCollapsedPendingInteractionKind(
  own: ThreadListIndicatorState,
  children: CollapsedChildActivity,
): PendingInteractionKind | null {
  if (!children.pending) return own.pendingInteractionKind;
  if (!own.hasPendingInteraction) return children.pendingInteractionKind;
  return own.pendingInteractionKind === children.pendingInteractionKind
    ? own.pendingInteractionKind
    : null;
}

export function threadListIndicatorStateForThread(
  thread: ThreadStatusShape &
    ThreadRuntimeShape &
    ThreadActivityStateShape &
    Pick<
      PluginSidebarThread,
      "hasPendingInteraction" | "indicator" | "queuedWork"
    >,
  hasUnsubmittedDraft: boolean,
): ThreadListIndicatorState {
  const unreadDone = isUnreadDoneThread(thread);
  return {
    hasPendingInteraction: thread.hasPendingInteraction,
    hasUnsubmittedDraft,
    hasUnreadError: unreadDone && thread.status === "error",
    hasUnreadSuccess: unreadDone && thread.status !== "error",
    isBackgroundAgentActive: hasActiveBackgroundAgentActivity(thread),
    isBackgroundCommandActive: hasActiveBackgroundCommandActivity(thread),
    isGoalActive: hasActiveGoalActivity(thread),
    pendingInteractionKind: pendingInteractionKindOf(thread.indicator),
    queuedWork: thread.queuedWork,
    isPlanModeActive: hasActivePlanModeActivity(thread),
    isRuntimeActive: isRuntimeBusyThread(thread),
    isWorkflowActive: hasActiveWorkflowActivity(thread),
  };
}

export function resolveThreadListIndicator(
  state: ThreadListIndicatorState,
): ThreadListIndicatorKind {
  if (state.hasUnreadError) return "unread-error";
  if (state.hasPendingInteraction) {
    return waitingIndicatorForPendingInteraction(state.pendingInteractionKind);
  }

  const hasActiveWork = hasThreadListWorkingActivity(state);
  if (state.hasUnsubmittedDraft && hasActiveWork) return "working-draft";
  if (state.isPlanModeActive) return "plan-mode";
  if (state.isGoalActive) return "goal";
  if (state.isRuntimeActive) return "runtime";
  if (state.isWorkflowActive) return "workflow";
  if (state.queuedWork === "failed") return "queued-failed";
  if (state.hasUnreadSuccess) return "unread-success";
  if (state.isBackgroundAgentActive) return "background-agent";
  if (state.isBackgroundCommandActive) return "background-command";
  if (state.queuedWork === "waiting") return "queued-waiting";
  if (state.hasUnsubmittedDraft) return "draft";
  return "none";
}

export interface CollapsedChildActivity {
  threadIds: readonly string[];
  pending: boolean;
  pendingInteractionKind: PendingInteractionKind | null;
  working: boolean;
  runtimeWorking: boolean;
  workflow: boolean;
  backgroundAgent: boolean;
  backgroundCommand: boolean;
  planMode: boolean;
  goal: boolean;
  unread: boolean;
  unreadError: boolean;
}

export const NO_COLLAPSED_CHILD_ACTIVITY: CollapsedChildActivity = {
  threadIds: [],
  pending: false,
  pendingInteractionKind: null,
  working: false,
  runtimeWorking: false,
  workflow: false,
  backgroundAgent: false,
  backgroundCommand: false,
  planMode: false,
  goal: false,
  unread: false,
  unreadError: false,
};

type ThreadActivityShape = ThreadStatusShape &
  ThreadRuntimeShape &
  Pick<
    PluginSidebarThread,
    "id" | "activity" | "hasPendingInteraction" | "indicator"
  >;

export function getCollapsedChildActivity(
  threads: readonly ThreadActivityShape[],
): CollapsedChildActivity {
  const threadIds: string[] = [];
  let pending = false;
  let pendingInteractionKind: PendingInteractionKind | null = null;
  let pendingInteractionKindDecided = false;
  let working = false;
  let runtimeWorking = false;
  let workflow = false;
  let backgroundAgent = false;
  let backgroundCommand = false;
  let planMode = false;
  let goal = false;
  let unread = false;
  let unreadError = false;
  for (const thread of threads) {
    threadIds.push(thread.id);
    const childUnreadDone = isUnreadDoneThread(thread);
    if (childUnreadDone && thread.status === "error") {
      unreadError = true;
    } else if (childUnreadDone) {
      unread = true;
    }

    if (thread.hasPendingInteraction) {
      pending = true;
      const kind = pendingInteractionKindOf(thread.indicator);
      pendingInteractionKind = pendingInteractionKindDecided
        ? pendingInteractionKind === kind
          ? pendingInteractionKind
          : null
        : kind;
      pendingInteractionKindDecided = true;
    }
    if (isBusyThread(thread)) working = true;
    if (isRuntimeBusyThread(thread)) runtimeWorking = true;
    if (hasActiveWorkflowActivity(thread)) workflow = true;
    if (hasActiveBackgroundAgentActivity(thread)) backgroundAgent = true;
    if (hasActiveBackgroundCommandActivity(thread)) backgroundCommand = true;
    if (hasActivePlanModeActivity(thread)) planMode = true;
    if (hasActiveGoalActivity(thread)) goal = true;
  }
  return {
    threadIds,
    pending,
    pendingInteractionKind,
    working,
    runtimeWorking,
    workflow,
    backgroundAgent,
    backgroundCommand,
    planMode,
    goal,
    unread,
    unreadError,
  };
}

export function isUnreadDoneThread(thread: ThreadStatusShape): boolean {
  if (thread.parentThreadId != null) {
    return false;
  }
  return (DONE_THREAD_STATUSES[thread.status] ?? false) && thread.isUnread;
}
