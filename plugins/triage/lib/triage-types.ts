import type { NewThreadRequest } from "@get-bb/plugin-sdk/app";

/** Shapes mirrored from the plugin server's RPC contract. */

export type StageRole = "intake" | "active" | "attention" | "done";

export interface Stage {
  id: string;
  name: string;
  position: number;
  systemRole: StageRole | null;
}

export type ReasoningLevel =
  | "none"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "ultracode"
  | "max"
  | "ultra";

export type RunState =
  | "queued"
  | "scheduled"
  | "dispatching"
  | "starting"
  | "working"
  | "idle"
  | "failed"
  | "completed"
  | "stopped";

export interface Task {
  id: string;
  number: number;
  title: string;
  description: string;
  stageId: string;
  projectId: string;
  projectName: string;
  machineId: string | null;
  machineName: string;
  branchName: string;
  providerId: string;
  model: string;
  reasoningLevel: ReasoningLevel;
  request: NewThreadRequest | null;
  scheduledAt: number | null;
  threadId: string | null;
  sidebarVisible?: boolean | null;
  runState: RunState;
  attentionReason: string | null;
  readAt: number | null;
  settledAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface ProjectOption {
  defaultMachineId?: string | null;
  id: string;
  kind: "personal" | "standard";
  name: string;
}

export interface MachineOption {
  id: string;
  name: string;
  status: "connected" | "disconnected";
}

export type NotificationLevel = "info" | "success" | "attention";

export interface TriageNotification {
  id: string;
  taskNumber: number | null;
  /** Short action phrase, e.g. "Moved to In Review". */
  action: string;
  /** Title of the task the action happened to, when it still exists. */
  taskTitle: string | null;
  title: string;
  body: string;
  level: NotificationLevel;
  readAt: number | null;
  createdAt: number;
}

export interface AgentModelOption {
  id: string;
  providerId: string;
  model: string;
  displayName: string;
  description: string;
  supportedReasoningEfforts: ReasoningLevel[];
  defaultReasoningEffort: ReasoningLevel;
}

export interface AgentOptions {
  providers: { id: string; name: string; available: boolean }[];
  models: AgentModelOption[];
}

export interface Snapshot {
  stages: Stage[];
  tasks: Task[];
  projects: ProjectOption[];
  machines: MachineOption[];
  notifications: TriageNotification[];
  unreadCount: number;
}
