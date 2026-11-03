import type {
  experimental_resolveThreadStatus as ResolveThreadStatus,
  PluginThreadStatus,
} from "@get-bb/plugin-sdk/app";
import type { ForkThreadStatus } from "../../fork-sdk-types";

type ResolveThreadStatusInput = Parameters<typeof ResolveThreadStatus>[0];
type StatusThread = NonNullable<ResolveThreadStatusInput["thread"]>;
type PendingKind = "plan_approval" | "question" | null;

function pendingKindOf(thread: StatusThread): PendingKind {
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

export function withForkThreadStatus(resolve: typeof ResolveThreadStatus) {
  return (
    input: ResolveThreadStatusInput,
  ): ForkThreadStatus | PluginThreadStatus => {
    const status = resolve(input);
    if (status.indicator !== "waiting-for-input") return status;
    const pending = [input.thread, ...input.hiddenThreads].filter(
      (thread): thread is StatusThread =>
        thread !== null && thread.hasPendingInteraction,
    );
    const forkStatus = forkStatusFor(sharedKind(pending.map(pendingKindOf)));
    if (forkStatus === null) return status;
    return { ...status, ...forkStatus, rowStatus: null };
  };
}
