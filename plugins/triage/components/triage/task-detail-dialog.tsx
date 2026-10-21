import * as React from "react";
import { toast } from "sonner";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Icon } from "@/components/ui/icon";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { StatusDot } from "@/components/ui/status-dot";
import {
  formatAbsolute,
  formatReasoningLevel,
  isTaskRunning,
  presentRunState,
  providerLabel,
} from "@/lib/triage-format";
import type { TriageRpc } from "@/lib/triage-store";
import type { Stage, Task } from "@/lib/triage-types";

function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="triage-detail-row">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

export interface TaskDetailDialogProps {
  task: Task | null;
  stages: Stage[];
  rpc: TriageRpc;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onEdit: () => void;
  onChanged: () => Promise<void>;
}

/** Read view for a card that has no thread to open yet. */
function TaskDetailDialog({
  task,
  stages,
  rpc,
  open,
  onOpenChange,
  onEdit,
  onChanged,
}: TaskDetailDialogProps) {
  if (!task) return null;

  const status = presentRunState(task);

  const action = async (operation: () => Promise<unknown>, message: string) => {
    try {
      await operation();
      toast.success(message);
      await onChanged();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="triage-detail-dialog sm:max-w-2xl">
        <DialogHeader>
          <div className="triage-detail-eyebrow">
            <span className="tabular-nums">Triage #{task.number}</span>
            <span className="triage-detail-status">
              <StatusDot tone={status.tone} />
              {status.label}
            </span>
          </div>
          <DialogTitle className="pr-8 text-xl leading-snug">{task.title}</DialogTitle>
          <DialogDescription className="sr-only">Triage task details and actions</DialogDescription>
        </DialogHeader>

        <div className="triage-detail-body">
          {task.attentionReason ? (
            <div className="triage-detail-attention">
              <Icon name="AlertTriangle" className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
              <div>
                <p className="font-semibold">Needs attention</p>
                <p className="mt-0.5 text-xs leading-relaxed">{task.attentionReason}</p>
              </div>
            </div>
          ) : null}

          <div className="triage-detail-prompt">
            {task.description ? (
              <p className="whitespace-pre-wrap">{task.description}</p>
            ) : (
              <p className="text-muted-foreground">No prompt was provided.</p>
            )}
          </div>

          <dl className="triage-detail-grid">
            <DetailRow label="Project">{task.projectName}</DetailRow>
            <DetailRow label="Branch">{task.branchName}</DetailRow>
            <DetailRow label="Machine">{task.machineName}</DetailRow>
            <DetailRow label="Agent">
              {providerLabel(task.providerId)} · {task.model} ·{" "}
              {formatReasoningLevel(task.reasoningLevel)}
            </DetailRow>
            {task.scheduledAt ? (
              <DetailRow label="Scheduled">{formatAbsolute(task.scheduledAt)}</DetailRow>
            ) : null}
            <DetailRow label="Stage">
              <Select
                value={task.stageId}
                onValueChange={(stageId) =>
                  void action(
                    () => rpc.call("moveTask", { number: task.number, stageId }),
                    `Moved Triage #${task.number}`,
                  )
                }
              >
                <SelectTrigger className="h-8" aria-label="Stage">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {stages.map((stage) => (
                    <SelectItem key={stage.id} value={stage.id}>
                      {stage.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </DetailRow>
          </dl>
        </div>

        <div className="triage-dialog-footer justify-between">
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button variant="ghost" className="text-destructive hover:text-destructive">
                <Icon name="Trash2" aria-hidden="true" />
                Delete
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Delete Triage #{task.number}?</AlertDialogTitle>
                <AlertDialogDescription>
                  The card and its event history are removed. The linked BB thread is kept.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  onClick={() =>
                    void action(
                      () => rpc.call("deleteTask", { number: task.number }),
                      `Deleted Triage #${task.number}`,
                    ).then(() => onOpenChange(false))
                  }
                >
                  Delete card
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={onEdit}>
              <Icon name="Edit" aria-hidden="true" />
              Edit
            </Button>
            {!task.threadId ? (
              <Button
                onClick={() =>
                  void action(
                    () => rpc.call("runTask", { number: task.number }),
                    `Started Triage #${task.number}`,
                  )
                }
              >
                <Icon name="Play" aria-hidden="true" />
                Run now
              </Button>
            ) : null}
            {isTaskRunning(task) ? (
              <Button
                variant="outline"
                onClick={() =>
                  void action(
                    () => rpc.call("stopTask", { number: task.number }),
                    `Stopped Triage #${task.number}`,
                  )
                }
              >
                <Icon name="Square" aria-hidden="true" />
                Stop agent
              </Button>
            ) : null}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export { TaskDetailDialog };
