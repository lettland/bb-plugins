import { RenameTaskDialog } from "./rename-task-dialog";
import { useState } from "react";
import { useBbNavigate, useRealtime } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Icon } from "@/components/ui/icon";
import { useTriage } from "@/lib/triage-store";
import { claimTriageRefresh } from "@/lib/triage-mounts";

export function ThreadTriageAction({ threadId, sidebar = false, isCompactViewport = false }: { threadId: string; sidebar?: boolean; isCompactViewport?: boolean }) {
  const { snapshot, rpc, refresh } = useTriage();
  const navigate = useBbNavigate();
  const [renaming, setRenaming] = useState(false);
  const [pending, setPending] = useState(false);
  useRealtime("triage", (payload) => {
    if (claimTriageRefresh(payload)) void refresh();
  });
  const task = snapshot?.tasks.find((item) => item.threadId === threadId);
  const run = async (operation: () => Promise<unknown>, message: string) => {
    if (pending) return;
    setPending(true);
    try {
      await operation();
      await refresh();
      toast.success(message);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
      await refresh();
    } finally {
      setPending(false);
    }
  };
  if (!snapshot) return null;
  if (!task) return (
    <Button variant="ghost" size={isCompactViewport ? "icon" : "sm"} disabled={pending} aria-label="Move session to Triage"
      onClick={() => void run(() => rpc.call("importThread", { threadId }), "Session moved to Triage")}>
      <Icon name="ListTodo" className="size-4" aria-hidden="true" />
      {isCompactViewport ? null : sidebar ? "Move current session to Triage" : "Move to Triage"}
    </Button>
  );
  return (
    <>
    {renaming ? <RenameTaskDialog task={task} open={renaming} onOpenChange={setRenaming} /> : null}
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size={isCompactViewport ? "icon" : "sm"} disabled={pending} aria-label={`Triage #${task.number} actions`}>
          <Icon name="ListTodo" className="size-4" aria-hidden="true" />
          {isCompactViewport ? null : `Triage #${task.number}`}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={() => requestAnimationFrame(() => setRenaming(true))}>Edit title</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => navigate.toPluginPanel("triage")}>Open Triage board</DropdownMenuItem>
        <DropdownMenuItem disabled={task.sidebarVisible == null || pending} onSelect={() => void run(
          () => rpc.call("setThreadSidebar", { number: task.number, visible: !task.sidebarVisible }),
          task.sidebarVisible ? "Session hidden from sidebar" : "Session shown in sidebar",
        )}>{task.sidebarVisible ? "Hide session from sidebar" : "Show session in sidebar"}</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
    </>
  );
}
