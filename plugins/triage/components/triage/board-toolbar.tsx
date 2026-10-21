import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Icon } from "@/components/ui/icon";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Segmented, type SegmentedOption } from "@/components/ui/segmented";
import type { TriageRpc } from "@/lib/triage-store";
import type { MachineOption, ProjectOption, Stage } from "@/lib/triage-types";

import { TaskComposerDialog } from "./task-composer-dialog";

export type TaskFilter = "all" | "live" | "unread" | "settled";

export interface BoardToolbarProps {
  projects: ProjectOption[];
  machines: MachineOption[];
  stages: Stage[];
  projectFilter: string;
  machineFilter: string;
  taskFilter: TaskFilter;
  counts: Record<TaskFilter, number>;
  defaultProjectId: string | null;
  rpc: TriageRpc;
  onProjectFilterChange: (value: string) => void;
  onMachineFilterChange: (value: string) => void;
  onTaskFilterChange: (value: TaskFilter) => void;
  onCreated: () => Promise<void>;
}

/**
 * Scope on the left, lens and creation on the right. The machine picker is
 * omitted entirely when there is only one machine to choose.
 */
function BoardToolbar({
  projects,
  machines,
  stages,
  projectFilter,
  machineFilter,
  taskFilter,
  counts,
  defaultProjectId,
  rpc,
  onProjectFilterChange,
  onMachineFilterChange,
  onTaskFilterChange,
  onCreated,
}: BoardToolbarProps) {
  const [projectPickerOpen, setProjectPickerOpen] = useState(false);
  const [projectQuery, setProjectQuery] = useState("");
  const projectOptions = [
    { id: "all", name: "All projects" },
    ...projects.map((project) => ({ id: project.id, name: project.kind === "personal" ? "Personal" : project.name })),
  ];
  const matches = projectOptions.filter((project) => project.name.toLowerCase().includes(projectQuery.trim().toLowerCase()));
  const showMachines = machines.length > 1;

  const filterOptions: SegmentedOption<TaskFilter>[] = [
    { value: "all", label: "All", count: counts.all, hint: "Every card on the board" },
    { value: "live", label: "Running", count: counts.live, hint: "An agent is working right now" },
    { value: "unread", label: "Unread", count: counts.unread, hint: "Cards with updates you have not opened" },
    { value: "settled", label: "Settled", count: counts.settled, hint: "Resolved cards kept for reference" },
  ];

  return (
    <div className="triage-toolbar">
      <div className="triage-toolbar-group">
        <Popover open={projectPickerOpen} onOpenChange={(open) => { setProjectPickerOpen(open); if (!open) setProjectQuery(""); }}>
          <PopoverTrigger asChild>
            <Button variant="outline" className="h-8 w-[172px] justify-between gap-2" aria-label="Filter by project">
              <Icon name="Folder" className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
              <span className="truncate">{projectOptions.find((project) => project.id === projectFilter)?.name ?? "All projects"}</span>
              <Icon name="ChevronDown" className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            </Button>
          </PopoverTrigger>
          <PopoverContent align="start" className="w-72 p-2" mobileTitle="Projects">
            <Input className="focus-visible:ring-0" placeholder="Search projects…" aria-label="Search projects" value={projectQuery}
              onChange={(event) => setProjectQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "ArrowDown") {
                  event.preventDefault();
                  event.currentTarget.parentElement?.querySelector<HTMLButtonElement>("[role=option]")?.focus();
                }
              }} />
            <div role="listbox" aria-label="Projects" className="mt-2 max-h-64 overflow-y-auto"
              onKeyDown={(event) => {
                const options = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("[role=option]"));
                const index = options.indexOf(document.activeElement as HTMLButtonElement);
                const next = event.key === "ArrowDown" ? Math.min(index + 1, options.length - 1)
                  : event.key === "ArrowUp" ? Math.max(index - 1, 0)
                  : event.key === "Home" ? 0 : event.key === "End" ? options.length - 1 : null;
                if (next !== null) { event.preventDefault(); options[next]?.focus(); }
              }}>
              {matches.map((project) => (
                <button key={project.id} type="button" role="option" aria-selected={project.id === projectFilter}
                  className="flex w-full items-center justify-between gap-2 rounded-md px-2 py-2 text-left text-sm hover:bg-state-hover focus-visible:bg-state-hover focus-visible:outline-none"
                  onClick={() => { onProjectFilterChange(project.id); setProjectPickerOpen(false); setProjectQuery(""); }}>
                  <span className="truncate">{project.name}</span>
                  {project.id === projectFilter ? <Icon name="Check" className="size-4 shrink-0" aria-hidden="true" /> : null}
                </button>
              ))}
              {matches.length === 0 ? <p className="px-2 py-4 text-sm text-muted-foreground">No projects found.</p> : null}
            </div>
          </PopoverContent>
        </Popover>
        {showMachines ? (
          <Select value={machineFilter} onValueChange={onMachineFilterChange}>
            <SelectTrigger className="h-8 w-[168px] gap-2" aria-label="Filter by machine">
              <Icon
                name="Laptop"
                className="size-4 shrink-0 text-muted-foreground"
                aria-hidden="true"
              />
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All machines</SelectItem>
              <SelectSeparator />
              {machines.map((machine) => (
                <SelectItem key={machine.id} value={machine.id}>
                  {machine.name}
                  {machine.status === "disconnected" ? " · offline" : ""}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : null}
      </div>

      <div className="triage-toolbar-group justify-end">
        <Segmented
          aria-label="Filter cards"
          size="sm"
          value={taskFilter}
          options={filterOptions}
          onValueChange={onTaskFilterChange}
        />
        <TaskComposerDialog
          mode="create"
          stages={stages}
          defaultProjectId={defaultProjectId}
          rpc={rpc}
          onSaved={onCreated}
        />
      </div>
    </div>
  );
}

export { BoardToolbar };
