import * as React from "react";
import {
  experimental_NewThreadComposer as NewThreadComposer,
  type NewThreadRequest,
} from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Field, FieldLabel } from "@/components/ui/field";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { formatWhen, titleFromPrompt, toDatetimeLocal } from "@/lib/triage-format";
import type { TriageRpc } from "@/lib/triage-store";
import type { Stage, Task } from "@/lib/triage-types";

import { StartPicker, type StartMode } from "./start-picker";

function descriptionFromRequest(request: NewThreadRequest): string {
  return request.input
    .filter(
      (part): part is Extract<(typeof request.input)[number], { type: "text" }> =>
        part.type === "text",
    )
    .filter((part) => part.visibility !== "agent-only")
    .map((part) => part.text.trim())
    .filter(Boolean)
    .join("\n\n");
}

interface TaskComposerDialogBaseProps {
  stages: Stage[];
  rpc: TriageRpc;
  onSaved: () => Promise<void>;
}

interface CreateTaskComposerDialogProps extends TaskComposerDialogBaseProps {
  mode: "create";
  defaultProjectId: string | null;
}

interface EditTaskComposerDialogProps extends TaskComposerDialogBaseProps {
  mode: "edit";
  task: Task | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export type TaskComposerDialogProps =
  | CreateTaskComposerDialogProps
  | EditTaskComposerDialogProps;

/**
 * One host-owned composer for both creating and editing cards. Editing restores
 * the exact request previously submitted, so project, workspace, provider,
 * model, reasoning, service tier, permissions, and prompt all use the same
 * controls as creation.
 */
function TaskComposerDialog(props: TaskComposerDialogProps) {
  const editing = props.mode === "edit";
  const task = editing ? props.task : null;
  const [createOpen, setCreateOpen] = React.useState(false);
  const open = editing ? props.open : createOpen;
  const setOpen = editing ? props.onOpenChange : setCreateOpen;
  const [title, setTitle] = React.useState("");
  const composerRef = React.useRef<HTMLDivElement>(null);
  const [saving, setSaving] = React.useState(false);
  const [editSession, setEditSession] = React.useState(() => crypto.randomUUID());
  const [startMode, setStartMode] = React.useState<StartMode>("now");
  const [scheduledLocal, setScheduledLocal] = React.useState("");

  const intakeStage = React.useMemo(
    () => props.stages.find((stage) => stage.systemRole === "intake") ?? props.stages[0],
    [props.stages],
  );
  const stageId = editing ? task?.stageId ?? "" : intakeStage?.id ?? "";
  const started = Boolean(task?.threadId);
  const savedRequest = task?.request ?? null;

  React.useEffect(() => {
    if (!open) return;
    if (task) {
      setTitle(task.title);
      setEditSession(crypto.randomUUID());
      setScheduledLocal(toDatetimeLocal(task.scheduledAt));
      setStartMode(task.scheduledAt === null ? "manual" : "later");
      return;
    }
    setTitle("");
    setScheduledLocal("");
    setStartMode("now");
  }, [intakeStage?.id, open, task?.id]);

  if (editing && !task) return null;

  const submit = async (request: NewThreadRequest) => {
    const description = descriptionFromRequest(request);
    const cleanTitle = title.trim() || titleFromPrompt(description);
    if (!cleanTitle) {
      toast.error("Describe the task or add a name");
      throw new Error("A task name is required");
    }
    if (!stageId) {
      toast.error(editing ? "Choose a stage" : "To Do stage is unavailable");
      throw new Error("A stage is required");
    }

    let scheduledAt = started ? task?.scheduledAt ?? null : null;
    if (!started && startMode === "later") {
      if (!scheduledLocal) {
        toast.error("Pick a date and time to schedule this task");
        throw new Error("A schedule is required");
      }
      scheduledAt = new Date(scheduledLocal).getTime();
      if (!Number.isFinite(scheduledAt) || scheduledAt <= Date.now()) {
        toast.error("Choose a future date and time");
        throw new Error("A future schedule is required");
      }
    }

    setSaving(true);
    try {
      if (!task) {
        const created = await props.rpc.call("createTask", {
          title: cleanTitle,
          description,
          stageId,
          scheduledAt,
          runNow: startMode === "now",
          request,
        });
        if (startMode !== "now") {
          toast.success("Created Triage #" + created.number, {
            description:
              startMode === "later" && scheduledAt
                ? "Scheduled " + formatWhen(scheduledAt) + "."
                : "Added to the board. Run it when ready.",
          });
        }
      } else {
        await props.rpc.call("updateTask", {
          number: task.number,
          title: cleanTitle,
          description,
          stageId,
          scheduledAt,
          request,
        });
        if (!started && startMode === "now") {
          await props.rpc.call("runTask", { number: task.number });
        }
        toast.success("Updated Triage #" + task.number);
      }

      await props.onSaved();
      setOpen(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not save task");
      throw error;
    } finally {
      setSaving(false);
    }
  };

  const defaultProjectId =
    savedRequest?.projectId ??
    task?.projectId ??
    (props.mode === "create" ? props.defaultProjectId ?? undefined : undefined);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      {!editing ? (
        <DialogTrigger asChild>
          <Button size="sm" className="h-8">
            <Icon name="Plus" aria-hidden="true" />
            New task
          </Button>
        </DialogTrigger>
      ) : null}
      <DialogContent className="triage-create-dialog max-h-[92vh] overflow-y-auto sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle>{task ? "Edit Triage #" + task.number : "New triage task"}</DialogTitle>
          {started ? (
            <DialogDescription>
              This agent thread already started. Prompt changes stay on the card, but execution
              choices cannot retarget the running thread.
            </DialogDescription>
          ) : null}
        </DialogHeader>

        <div className="triage-composer-shell" ref={composerRef}>
          <NewThreadComposer
            key={task ? `${task.id}-${editSession}` : "create"}
            defaultProjectId={defaultProjectId}
            defaultProviderId={savedRequest?.providerId ?? task?.providerId}
            defaultModel={savedRequest?.model ?? task?.model}
            defaultReasoningLevel={savedRequest?.reasoningLevel ?? task?.reasoningLevel}
            defaultServiceTier={savedRequest?.serviceTier}
            defaultPermissionMode={savedRequest?.permissionMode}
            defaultEnvironment={savedRequest?.environment}
            initialPrompt={task?.description}
            onSubmit={submit}
            placeholder="Describe the work and what done looks like"
            draftKey={task ? "triage-edit-task-" + task.id + "-" + editSession : "triage-create-task"}
            layout="document"
          />
        </div>

        <div className="triage-create-meta">
          <Field>
            <FieldLabel htmlFor="triage-task-name" optional={!editing}>
              Name
            </FieldLabel>
            <Input
              id="triage-task-name"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              maxLength={160}
              placeholder="Taken from the prompt when left blank"
            />
          </Field>
          <Field>
            <FieldLabel>Start</FieldLabel>
            {started ? (
              <div className="triage-locked-field">
                <Icon name="Play" className="size-4 shrink-0" aria-hidden="true" />
                Already started
              </div>
            ) : (
              <StartPicker
                mode={startMode}
                scheduledLocal={scheduledLocal}
                onModeChange={setStartMode}
                onScheduledLocalChange={setScheduledLocal}
              />
            )}
          </Field>
        </div>
        {editing ? (
          <div className="flex justify-end gap-2">
            <Button
              disabled={saving}
              onClick={() => {
                // Activate the native submit control so the host resolves the
                // current prompt, attachments, and execution selections together.
                const submitButton = composerRef.current?.querySelector<HTMLButtonElement>('button[type="submit"]');
                if (!submitButton || submitButton.disabled) {
                  toast.error("Complete the prompt and execution selections before saving");
                  return;
                }
                submitButton.click();
              }}
            >
              {saving ? "Saving…" : "Save changes"}
            </Button>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

export { TaskComposerDialog };
