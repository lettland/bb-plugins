import * as React from "react";
import { useSettings } from "@get-bb/plugin-sdk/app";
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
  DialogTrigger,
} from "@/components/ui/dialog";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { StatusDot } from "@/components/ui/status-dot";
import { stageTone } from "@/lib/triage-format";
import type { TriageRpc } from "@/lib/triage-store";
import type { Stage } from "@/lib/triage-types";

export interface ManageStagesDialogProps {
  stages: Stage[];
  rpc: TriageRpc;
  onChanged: () => Promise<void>;
}

/** Triage settings: the columns themselves, their order, and their names. */
function ManageStagesDialog({ stages, rpc, onChanged }: ManageStagesDialogProps) {
  const { values } = useSettings();
  const [savingSidebar, setSavingSidebar] = React.useState(false);
  const [drag, setDrag] = React.useState<{ id: string; startY: number; offset: number; index: number; target: number; step: number } | null>(null);
  const sidebarName = React.useId();
  const [reordering, setReordering] = React.useState(false);
  const reorder = async (id: string, targetId: string) => {
    if (id === targetId || reordering) return;
    setReordering(true);
    await handle(() => rpc.call("reorderStage", { id, targetId }));
    setReordering(false);
  };
  const [newName, setNewName] = React.useState("");
  const [names, setNames] = React.useState<Record<string, string>>({});

  React.useEffect(() => {
    setNames(Object.fromEntries(stages.map((stage) => [stage.id, stage.name])));
  }, [stages]);

  const handle = async (action: () => Promise<unknown>, success?: string) => {
    try {
      await action();
      if (success) toast.success(success);
      await onChanged();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="ghost" size="icon" className="size-8" aria-label="Triage settings">
          <Icon name="Settings" className="size-4" aria-hidden="true" />
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Triage settings</DialogTitle>
          <DialogDescription>
            Rename the columns and drag their handles to reorder them.
          </DialogDescription>
        </DialogHeader>
        <div className="triage-stage-list">
          {stages.map((stage, index) => (
            <div key={stage.id} className="triage-stage-row"
              data-dragging={drag?.id === stage.id ? "" : undefined}
              style={{ transform: `translateY(${drag ? drag.id === stage.id ? drag.offset : index > drag.index && index <= drag.target ? -drag.step : index < drag.index && index >= drag.target ? drag.step : 0 : 0}px)` }}>
              <Button variant="ghost" size="icon" className="triage-stage-handle size-8 shrink-0"
                disabled={reordering}
                aria-label={`Reorder ${stage.name}`}
                aria-description="Drag to reorder, or use the up and down arrow keys"
                onPointerDown={(event) => {
                  if (event.button !== 0) return;
                  const row = event.currentTarget.parentElement!;
                  const rows = Array.from(row.parentElement!.children);
                  const step = rows.length > 1
                    ? rows[1].getBoundingClientRect().top - rows[0].getBoundingClientRect().top
                    : row.getBoundingClientRect().height + 6;
                  event.currentTarget.setPointerCapture(event.pointerId);
                  setDrag({ id: stage.id, startY: event.clientY, offset: 0, index, target: index, step });
                }}
                onPointerMove={(event) => {
                  if (!drag || drag.id !== stage.id) return;
                  const offset = Math.max(-drag.index * drag.step, Math.min((stages.length - 1 - drag.index) * drag.step, event.clientY - drag.startY));
                  setDrag({ ...drag, offset, target: Math.max(0, Math.min(stages.length - 1, drag.index + Math.round(offset / drag.step))) });
                }}
                onPointerUp={() => {
                  if (!drag) return;
                  if (drag.index !== drag.target) void reorder(drag.id, stages[drag.target].id);
                  setDrag(null);
                }}
                onPointerCancel={() => setDrag(null)}
                onLostPointerCapture={() => setDrag(null)}
                onKeyDown={(event) => {
                  if (event.key === "Escape") { setDrag(null); return; }
                  const target = stages[index + (event.key === "ArrowUp" ? -1 : event.key === "ArrowDown" ? 1 : 0)];
                  if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
                  event.preventDefault();
                  if (target) void reorder(stage.id, target.id);
                }}>
                <Icon name="DragDropVertical" className="size-4" aria-hidden="true" />
              </Button>
              <StatusDot tone={stageTone(stage)} className="shrink-0" />
              <Input
                value={names[stage.id] ?? stage.name}
                onChange={(event) =>
                  setNames((current) => ({ ...current, [stage.id]: event.target.value }))
                }
                onBlur={() => {
                  const next = (names[stage.id] ?? "").trim();
                  if (next && next !== stage.name) {
                    void handle(
                      () => rpc.call("renameStage", { id: stage.id, name: next }),
                      `Renamed stage to ${next}`,
                    );
                  }
                }}
                className="h-8"
                aria-label={`Stage name ${stage.name}`}
              />
              <div className="flex shrink-0 items-center">
                {!stage.systemRole ? (
                  <AlertDialog>
                    <AlertDialogTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-8 hover:text-destructive"
                        aria-label={`Remove ${stage.name}`}
                      >
                        <Icon name="Trash2" className="size-4" aria-hidden="true" />
                      </Button>
                    </AlertDialogTrigger>
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle>Remove {stage.name}?</AlertDialogTitle>
                        <AlertDialogDescription>
                          This works only when the stage has no cards. This action cannot be undone.
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel>Cancel</AlertDialogCancel>
                        <AlertDialogAction
                          onClick={() =>
                            void handle(
                              () => rpc.call("deleteStage", { id: stage.id }),
                              `Removed ${stage.name}`,
                            )
                          }
                        >
                          Remove stage
                        </AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                ) : null}
              </div>
            </div>
          ))}
        </div>
        <form
          className="triage-dialog-footer"
          onSubmit={(event) => {
            event.preventDefault();
            const name = newName.trim();
            if (!name) return;
            void handle(() => rpc.call("createStage", { name }), `Added ${name}`).then(() =>
              setNewName(""),
            );
          }}
        >
          <Input
            value={newName}
            onChange={(event) => setNewName(event.target.value)}
            placeholder="New stage name"
            aria-label="New stage name"
            className="flex-1"
          />
          <Button type="submit" variant="outline">
            <Icon name="Plus" aria-hidden="true" />
            Add stage
          </Button>
        </form>
        <div className="triage-sidebar-setting">
          <label htmlFor={sidebarName}>Show Triage in sidebar</label>
          <input
            id={sidebarName}
            className="triage-sidebar-switch"
            type="checkbox"
            role="switch"
            checked={values?.showInSidebar === true}
            disabled={!values || savingSidebar}
            onChange={(event) => {
              const visible = event.currentTarget.checked;
              setSavingSidebar(true);
              void handle(() => rpc.call("setShowInSidebar", { visible }))
                .finally(() => setSavingSidebar(false));
            }}
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}

export { ManageStagesDialog };
