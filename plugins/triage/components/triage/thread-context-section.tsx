import {
  experimental_InfoList as InfoList,
  experimental_ThreadContextCardRow as ThreadContextCardRow,
  useBbNavigate,
  useRealtime,
} from "@get-bb/plugin-sdk/app";

import { StatusDot } from "@/components/ui/status-dot";
import {
  formatShortWhen,
  isTaskRunning,
  keepsFailedCardVisible,
  runStateLabel,
  stageTone,
} from "@/lib/triage-format";
import { claimTriageRefresh } from "@/lib/triage-mounts";
import { useTriage } from "@/lib/triage-store";
import type { Stage, Task } from "@/lib/triage-types";

type ThreadTask = Task & { threadId: string };

const GROUP_ROLES = ["active", "attention", "done"] as const;

export function TriageThreadsSection({ threadId }: { threadId?: string }) {
  const { snapshot, refresh } = useTriage();
  const navigate = useBbNavigate();
  useRealtime("triage", (payload) => {
    if (claimTriageRefresh(payload)) void refresh();
  });
  if (!snapshot) return null;

  const groups = GROUP_ROLES.flatMap((role) => {
    const stage = snapshot.stages.find((candidate) => candidate.systemRole === role);
    if (!stage) return [];
    const rows = snapshot.tasks
      .filter((task): task is ThreadTask => task.stageId === stage.id && task.threadId !== null)
      .filter((task) => task.runState !== "failed" || keepsFailedCardVisible(task, snapshot.stages))
      .filter((task) => task.settledAt === null)
      .sort((a, b) => b.updatedAt - a.updatedAt);
    return rows.length === 0 ? [] : [{ stage, rows }];
  });
  if (groups.length === 0) return null;

  const renderRow = (stage: Stage) => (task: ThreadTask) => {
    const running = isTaskRunning(task);
    const announced = running || task.runState === "failed";
    const label = `${task.projectName} · ${task.title}`;
    const isCurrent = threadId === task.threadId;
    return (
      <li
        className={isCurrent ? "list-none triage-current-thread" : "list-none"}
        aria-current={isCurrent ? "true" : undefined}
      >
        <ThreadContextCardRow
          leading={<StatusDot tone={stageTone(stage)} pulse={running} label={announced ? runStateLabel(task.runState) : undefined} />}
          label={label}
          title={label}
          trailing={formatShortWhen(task.updatedAt)}
          onClick={() => navigate.toThread(task.threadId)}
        />
      </li>
    );
  };

  return (
    <>
      {groups.map(({ stage, rows }) => (
        <div key={stage.id}>
          <h4 className="px-2 text-[11px] font-medium text-muted-foreground">{stage.name}</h4>
          <InfoList items={rows} getKey={(task) => task.id} limit={rows.length} renderItem={renderRow(stage)} />
        </div>
      ))}
    </>
  );
}
