import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

const stageSchema = z.object({
  id: z.string(),
  name: z.string(),
  position: z.number().int(),
  systemRole: z.enum(["intake", "active", "attention", "done"]).nullable(),
});

const reasoningLevelSchema = z.enum([
  "none",
  "low",
  "medium",
  "high",
  "xhigh",
  "ultracode",
  "max",
  "ultra",
]);

const executionSourceSchema = z.enum(["explicit", "client-preference"]);
export const newThreadRequestSchema = z
  .object({
    projectId: z.string().min(1),
    providerId: z.string().min(1),
    model: z.string().min(1),
    reasoningLevel: reasoningLevelSchema,
    permissionMode: z.enum(["accept-edits", "auto", "full"]),
    serviceTier: z.enum(["default", "fast"]).optional(),
    executionInputSources: z
      .object({
        providerId: executionSourceSchema.optional(),
        model: executionSourceSchema.optional(),
        serviceTier: executionSourceSchema.optional(),
        reasoningLevel: executionSourceSchema.optional(),
        permissionMode: executionSourceSchema.optional(),
      })
      .strict(),
    environment: z.object({ type: z.string().min(1) }).passthrough(),
    input: z.array(z.object({ type: z.string().min(1) }).passthrough()).min(1),
  })
  .strict();

const taskSchema = z.object({
  id: z.string(),
  number: z.number().int().positive(),
  title: z.string(),
  description: z.string(),
  stageId: z.string(),
  projectId: z.string(),
  projectName: z.string(),
  machineId: z.string().nullable(),
  machineName: z.string(),
  branchName: z.string(),
  providerId: z.string(),
  model: z.string(),
  reasoningLevel: reasoningLevelSchema,
  request: newThreadRequestSchema.nullable(),
  scheduledAt: z.number().int().nullable(),
  threadId: z.string().nullable(),
  sidebarVisible: z.boolean().nullable().default(null),
  runState: z.enum([
    "queued",
    "scheduled",
    "dispatching",
    "starting",
    "working",
    "idle",
    "failed",
    "completed",
    "stopped",
  ]),
  attentionReason: z.string().nullable(),
  readAt: z.number().int().nullable(),
  settledAt: z.number().int().nullable(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
});

const notificationSchema = z.object({
  id: z.string(),
  taskNumber: z.number().int().nullable(),
  action: z.string(),
  taskTitle: z.string().nullable(),
  title: z.string(),
  body: z.string(),
  level: z.enum(["info", "success", "attention"]),
  readAt: z.number().int().nullable(),
  createdAt: z.number().int(),
});

const projectOptionSchema = z.object({
  defaultMachineId: z.string().nullable(),
  id: z.string(),
  kind: z.enum(["personal", "standard"]),
  name: z.string(),
});
const machineOptionSchema = z.object({
  id: z.string(),
  name: z.string(),
  status: z.enum(["connected", "disconnected"]),
});

const agentOptionsSchema = z.object({
  providers: z.array(
    z.object({ id: z.string(), name: z.string(), available: z.boolean() }),
  ),
  models: z.array(
    z.object({
      id: z.string(),
      providerId: z.string(),
      model: z.string(),
      displayName: z.string(),
      description: z.string(),
      supportedReasoningEfforts: z.array(reasoningLevelSchema),
      defaultReasoningEffort: reasoningLevelSchema,
    }),
  ),
});

export const rpcContract = defineRpcContract({
  snapshot: {
    input: z.null(),
    output: z.object({
      stages: z.array(stageSchema),
      tasks: z.array(taskSchema),
      projects: z.array(projectOptionSchema),
      machines: z.array(machineOptionSchema),
      notifications: z.array(notificationSchema),
      unreadCount: z.number().int().nonnegative(),
    }),
  },
  importThread: {
    input: z.object({ threadId: z.string().min(1) }).strict(),
    output: taskSchema,
  },
  setShowInSidebar: {
    input: z.object({ visible: z.boolean() }).strict(),
    output: z.object({ ok: z.literal(true) }),
  },
  setThreadSidebar: {
    input: z.object({ number: z.number().int().positive(), visible: z.boolean() }).strict(),
    output: z.object({ ok: z.literal(true) }),
  },
  createTask: {
    input: z
      .object({
        title: z.string().trim().min(1).max(160),
        description: z.string().max(50_000),
        stageId: z.string().min(1),
        scheduledAt: z.number().int().nullable(),
        runNow: z.boolean(),
        request: newThreadRequestSchema,
      })
      .strict(),
    output: taskSchema,
  },
  moveTask: {
    input: z
      .object({
        number: z.number().int().positive(),
        stageId: z.string().min(1),
        summary: z.string().max(2_000).optional(),
      })
      .strict(),
    output: taskSchema,
  },
  renameTask: {
    input: z.object({ number: z.number().int().positive(), title: z.string().trim().min(1).max(160) }).strict(),
    output: taskSchema,
  },
  updateTask: {
    input: z
      .object({
        number: z.number().int().positive(),
        title: z.string().trim().min(1).max(160),
        description: z.string().max(50_000),
        stageId: z.string().min(1),
        scheduledAt: z.number().int().nullable(),
        /** Agent retargeting; accepted only before a thread exists. */
        providerId: z.string().min(1).optional(),
        model: z.string().min(1).optional(),
        reasoningLevel: reasoningLevelSchema.optional(),
        /** Full composer state; accepted only before a thread exists. */
        request: newThreadRequestSchema.optional(),
      })
      .strict(),
    output: taskSchema,
  },
  setTaskSettled: {
    input: z
      .object({ number: z.number().int().positive(), settled: z.boolean() })
      .strict(),
    output: taskSchema,
  },
  setTaskRead: {
    input: z.object({ number: z.number().int().positive(), read: z.boolean() }).strict(),
    output: taskSchema,
  },
  agentOptions: {
    input: z.null(),
    output: agentOptionsSchema,
  },
  runTask: {
    input: z.object({ number: z.number().int().positive() }).strict(),
    output: taskSchema,
  },
  stopTask: {
    input: z.object({ number: z.number().int().positive() }).strict(),
    output: taskSchema,
  },
  deleteTask: {
    input: z.object({ number: z.number().int().positive() }).strict(),
    output: z.object({ ok: z.literal(true) }),
  },
  createStage: {
    input: z.object({ name: z.string().trim().min(1).max(50) }).strict(),
    output: stageSchema,
  },
  renameStage: {
    input: z
      .object({ id: z.string().min(1), name: z.string().trim().min(1).max(50) })
      .strict(),
    output: stageSchema,
  },
  reorderStage: {
    input: z
      .object({ id: z.string().min(1), direction: z.enum(["left", "right"]).optional(), targetId: z.string().min(1).optional() })
      .strict(),
    output: z.object({ stages: z.array(stageSchema) }),
  },
  deleteStage: {
    input: z.object({ id: z.string().min(1) }).strict(),
    output: z.object({ ok: z.literal(true) }),
  },
  markNotificationsRead: {
    input: z
      .object({
        /** null is the explicit "mark all" action; ids is a popover snapshot. */
        ids: z.array(z.string().min(1)).max(50).nullable(),
      })
      .strict(),
    output: z.object({ ok: z.literal(true) }),
  },
  deleteNotifications: {
    input: z.object({ ids: z.array(z.string().min(1)).min(1).max(50) }).strict(),
    output: z.object({ ok: z.literal(true) }),
  },
});

interface StageRow {
  id: string;
  name: string;
  position: number;
  system_role: "intake" | "active" | "attention" | "done" | null;
}

interface TaskRow {
  id: string;
  number: number;
  title: string;
  description: string;
  stage_id: string;
  project_id: string;
  project_name: string;
  machine_id: string | null;
  machine_name: string;
  provider_id: string;
  model: string;
  request_json: string;
  scheduled_at: number | null;
  thread_id: string | null;
  run_state:
    | "queued"
    | "scheduled"
    | "dispatching"
    | "starting"
    | "working"
    | "idle"
    | "failed"
    | "completed"
    | "stopped";
  attention_reason: string | null;
  read_at: number | null;
  created_at: number;
  updated_at: number;
  settled_at: number | null;
}

interface NotificationRow {
  id: string;
  task_number: number | null;
  action: string | null;
  task_title: string | null;
  title: string;
  body: string;
  level: "info" | "success" | "attention";
  read_at: number | null;
  created_at: number;
}

const migrations = [
  `CREATE TABLE IF NOT EXISTS triage_stages (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL COLLATE NOCASE UNIQUE,
    position INTEGER NOT NULL UNIQUE,
    system_role TEXT UNIQUE CHECK (system_role IN ('intake', 'active', 'attention', 'done') OR system_role IS NULL)
  )`,
  `CREATE TABLE IF NOT EXISTS triage_tasks (
    id TEXT PRIMARY KEY,
    number INTEGER NOT NULL UNIQUE,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    stage_id TEXT NOT NULL REFERENCES triage_stages(id),
    project_id TEXT NOT NULL,
    project_name TEXT NOT NULL,
    machine_id TEXT,
    machine_name TEXT NOT NULL,
    provider_id TEXT NOT NULL,
    model TEXT NOT NULL,
    request_json TEXT NOT NULL,
    scheduled_at INTEGER,
    thread_id TEXT UNIQUE,
    run_state TEXT NOT NULL CHECK (run_state IN ('queued','scheduled','dispatching','starting','working','idle','failed','completed','stopped')),
    attention_reason TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS triage_tasks_due_idx ON triage_tasks(run_state, scheduled_at)`,
  `CREATE INDEX IF NOT EXISTS triage_tasks_thread_idx ON triage_tasks(thread_id)`,
  `CREATE TABLE IF NOT EXISTS triage_events (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES triage_tasks(id) ON DELETE CASCADE,
    actor TEXT NOT NULL,
    event TEXT NOT NULL,
    summary TEXT,
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS triage_notifications (
    id TEXT PRIMARY KEY,
    task_number INTEGER,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    level TEXT NOT NULL CHECK (level IN ('info','success','attention')),
    read_at INTEGER,
    created_at INTEGER NOT NULL
  )`,
  `INSERT OR IGNORE INTO triage_stages (id, name, position, system_role) VALUES
    ('stage-todo', 'To Do', 100, 'intake'),
    ('stage-progress', 'In Progress', 200, 'active'),
    ('stage-attention', 'Human Review', 300, 'attention'),
    ('stage-completed', 'Completed', 400, 'done')`,
  `CREATE TABLE IF NOT EXISTS triage_meta (
    key TEXT PRIMARY KEY,
    value INTEGER NOT NULL
  )`,
  `INSERT OR IGNORE INTO triage_meta (key, value)
    SELECT 'next_task_number', COALESCE(MAX(number), 0) + 1 FROM triage_tasks`,
  // The notification list shows "what happened" above "which card it happened
  // to", so both are stored rather than parsed back out of the prose title.
  `ALTER TABLE triage_notifications ADD COLUMN action TEXT`,
  `ALTER TABLE triage_notifications ADD COLUMN task_title TEXT`,
  // Settled is orthogonal to workflow stage: archive a resolved card without losing its column.
  `ALTER TABLE triage_tasks ADD COLUMN settled_at INTEGER`,
  `ALTER TABLE triage_tasks ADD COLUMN read_at INTEGER`,
];

function toStage(row: StageRow) {
  return {
    id: row.id,
    name: row.name,
    position: row.position,
    systemRole: row.system_role,
  };
}

function toTask(row: TaskRow) {
  const storedRequest = newThreadRequestSchema.safeParse(JSON.parse(row.request_json));
  const environment = storedRequest.success ? storedRequest.data.environment : null;
  const workspace = environment && typeof environment.workspace === "object" && environment.workspace !== null ? environment.workspace as Record<string, unknown> : null;
  const branch = workspace && typeof workspace.branch === "object" && workspace.branch !== null ? workspace.branch as Record<string, unknown> : null;
  const baseBranch = workspace && typeof workspace.baseBranch === "object" && workspace.baseBranch !== null ? workspace.baseBranch as Record<string, unknown> : null;
  const branchName = branch?.kind === "existing" && typeof branch.name === "string" ? branch.name
    : branch?.kind === "new" && typeof branch.baseBranch === "string" ? `new from ${branch.baseBranch}`
      : baseBranch?.kind === "named" && typeof baseBranch.name === "string" ? `new from ${baseBranch.name}`
        : environment?.type === "reuse" ? "Reused workspace"
          : workspace?.type === "personal" ? "No branch"
            : "Default branch";
  return {
    id: row.id,
    number: row.number,
    title: row.title,
    description: row.description,
    stageId: row.stage_id,
    projectId: row.project_id,
    projectName: row.project_name,
    machineId: row.machine_id,
    machineName: row.machine_name,
    branchName,
    providerId: row.provider_id,
    model: row.model,
    reasoningLevel: storedRequest.success ? storedRequest.data.reasoningLevel : "none" as const,
    request: storedRequest.success ? storedRequest.data : null,
    scheduledAt: row.scheduled_at,
    threadId: row.thread_id,
    runState: row.run_state,
    attentionReason: row.attention_reason,
    readAt: row.read_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    settledAt: row.settled_at,
  };
}

/** Recover a short action phrase from a legacy "Triage #12 started" title. */
function actionFromTitle(title: string, taskNumber: number | null): string {
  if (taskNumber === null) return title;
  const stripped = title.replace(new RegExp(`^Triage #${taskNumber}\\s+`), "");
  if (stripped === title) return title;
  return stripped.charAt(0).toUpperCase() + stripped.slice(1);
}

function toNotification(row: NotificationRow) {
  return {
    id: row.id,
    taskNumber: row.task_number,
    // Rows written before the split still carry the action inside the title.
    action: row.action ?? actionFromTitle(row.title, row.task_number),
    taskTitle: row.task_title,
    title: row.title,
    body: row.body,
    level: row.level,
    readAt: row.read_at,
    createdAt: row.created_at,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

export default async function plugin(bb: BbPluginApi) {
  const db = bb.storage.database();
  bb.storage.migrate(db, migrations);

  // Cards and native sessions are separate sidebar preferences.
  const settings = bb.settings.define({
    showThreadsInSidebar: {
      type: "boolean",
      label: "Show Triage sessions in the sidebar",
      description: "Show linked sessions in the regular sidebar list. Changing this applies to all existing Triage sessions; individual sessions can also be shown or hidden from their Triage menu.",
      default: false,
    },
    showInSidebar: {
      type: "boolean",
      label: "Show Triage in the sidebar",
      description:
        "List your Triage cards above the threads in BB's sidebar, ordered by what needs you first.",
      default: false,
    },
  });

  let showThreadsInSidebar = (await settings.get()).showThreadsInSidebar;
  const pendingVisibility = new Map<string, { visible: boolean }>();
  let disposed = false;
  bb.onDispose(() => { disposed = true; pendingVisibility.clear(); });
  let sidebarWrites: Promise<unknown> = Promise.resolve();
  const applySidebarVisibility = (threadId: string, change: { visible: boolean }) => {
    const operation = sidebarWrites.then(async () => {
      if (disposed || pendingVisibility.get(threadId) !== change) return;
      await bb.sdk.threads.update({ threadId, visibility: change.visible ? "visible" : "hidden" });
      if (disposed) return;
      if (pendingVisibility.get(threadId) === change) pendingVisibility.delete(threadId);
      publish();
    });
    sidebarWrites = operation.catch(() => {});
    return operation;
  };
  const setSidebarVisibility = (threadId: string, visible: boolean) => {
    const change = { visible };
    pendingVisibility.set(threadId, change);
    return applySidebarVisibility(threadId, change);
  };
  const syncSidebarVisibility = async () => {
    for (const [threadId, change] of pendingVisibility) {
      try {
        await applySidebarVisibility(threadId, change);
      } catch (error) {
        if (!disposed) bb.log.warn(`Could not update sidebar visibility: ${errorMessage(error)}`);
      }
    }
  };
  settings.onChange((next, prev) => {
    showThreadsInSidebar = next.showThreadsInSidebar;
    if (next.showThreadsInSidebar === prev.showThreadsInSidebar) return;
    const rows = db.prepare("SELECT thread_id FROM triage_tasks WHERE thread_id IS NOT NULL").all() as { thread_id: string }[];
    for (const row of rows) pendingVisibility.set(row.thread_id, { visible: showThreadsInSidebar });
    void syncSidebarVisibility();
  });

  const listStages = () =>
    (db
      .prepare("SELECT id, name, position, system_role FROM triage_stages ORDER BY position")
      .all() as StageRow[]).map(toStage);

  const listTasks = () =>
    (db
      .prepare("SELECT * FROM triage_tasks ORDER BY updated_at DESC, number DESC")
      .all() as TaskRow[]).map(toTask);

  const getTaskRow = (number: number) => {
    const row = db
      .prepare("SELECT * FROM triage_tasks WHERE number = ?")
      .get(number) as TaskRow | undefined;
    if (!row) throw new Error(`Triage #${number} was not found`);
    return row;
  };

  const getTaskByThread = (threadId: string) =>
    db.prepare("SELECT * FROM triage_tasks WHERE thread_id = ?").get(threadId) as
      | TaskRow
      | undefined;

  const getStageRow = (id: string) => {
    const row = db
      .prepare("SELECT id, name, position, system_role FROM triage_stages WHERE id = ?")
      .get(id) as StageRow | undefined;
    if (!row) throw new Error("Stage was not found");
    return row;
  };

  const getSystemStage = (role: StageRow["system_role"]) => {
    const row = db
      .prepare("SELECT id, name, position, system_role FROM triage_stages WHERE system_role = ?")
      .get(role) as StageRow | undefined;
    if (!row) throw new Error(`The ${role} stage is not configured`);
    return row;
  };

  const addEvent = (
    taskId: string,
    actor: string,
    event: string,
    summary?: string,
  ) => {
    db.prepare(
      "INSERT INTO triage_events (id, task_id, actor, event, summary, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(crypto.randomUUID(), taskId, actor, event, summary ?? null, Date.now());
  };

  const publish = (notification?: {
    taskNumber: number | null;
    action: string;
    taskTitle: string | null;
    title: string;
    body: string;
    level: "info" | "success" | "attention";
  }) => {
    bb.realtime.publish("triage", {
      kind: "changed",
      at: Date.now(),
      ...(notification ? { notification } : {}),
    });
  };

  const notify = (input: {
    taskNumber: number | null;
    /** Short phrase: what just happened. */
    action: string;
    /** Title of the card it happened to, so the list can name it. */
    taskTitle: string | null;
    body: string;
    level: "info" | "success" | "attention";
  }) => {
    const title = input.taskNumber === null
      ? input.action
      : `Triage #${input.taskNumber} · ${input.action}`;
    db.prepare(
      "INSERT INTO triage_notifications (id, task_number, action, task_title, title, body, level, read_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)",
    ).run(
      crypto.randomUUID(),
      input.taskNumber,
      input.action,
      input.taskTitle,
      title,
      input.body,
      input.level,
      Date.now(),
    );
    publish({
      taskNumber: input.taskNumber,
      action: input.action,
      taskTitle: input.taskTitle,
      title,
      body: input.body,
      level: input.level,
    });
  };

  const moveTask = (
    number: number,
    stageId: string,
    actor: string,
    summary?: string,
    shouldNotify = false,
  ) => {
    const task = getTaskRow(number);
    const stage = getStageRow(stageId);
    const now = Date.now();
    const nextRunState = stage.system_role === "done" ? "completed" : task.run_state;
    db.prepare(
      `UPDATE triage_tasks SET stage_id = ?, run_state = ?,
       attention_reason = CASE WHEN ? = 'attention' THEN attention_reason ELSE NULL END,
       read_at = CASE WHEN ? = 'agent' THEN NULL ELSE read_at END, updated_at = ? WHERE id = ?`,
    ).run(stage.id, nextRunState, stage.system_role, actor, now, task.id);
    addEvent(task.id, actor, `moved to ${stage.name}`, summary);
    if (shouldNotify) {
      notify({
        taskNumber: number,
        action: `Moved to ${stage.name}`,
        taskTitle: task.title,
        body: summary?.trim() || "The assigned agent moved this card.",
        level: stage.system_role === "attention" ? "attention" : "success",
      });
    } else {
      publish();
    }
    return toTask(getTaskRow(number));
  };

  const resolveMachine = async (environment: Record<string, unknown>) => {
    let machineId = typeof environment.hostId === "string" ? environment.hostId : null;
    if (!machineId && environment.type === "reuse" && typeof environment.environmentId === "string") {
      try {
        const resolved = await bb.sdk.environments.get({
          environmentId: environment.environmentId,
        });
        machineId = resolved.hostId;
      } catch {
        machineId = null;
      }
    }
    if (!machineId) return { machineId: null, machineName: "Project default" };
    try {
      const host = await bb.sdk.hosts.get({ hostId: machineId });
      return { machineId, machineName: host.name };
    } catch {
      return { machineId, machineName: machineId };
    }
  };

  const stageInstructions = () => {
    const intake = getSystemStage("intake").name;
    const active = getSystemStage("active").name;
    const attention = getSystemStage("attention").name;
    const done = getSystemStage("done").name;
    return `Available stages: ${listStages().map((stage) => stage.name).join(", ")}. ` +
      `Keep the card's stage accurate using triage_move_task. ${intake} means work has not started; use ${active} while working, including when resuming a completed task for new requests. ` +
      `Before your final response, call triage_move_task with ${done} when the requested scope is satisfied, relevant verification passed, and no required work remains. Do not leave finished work in ${intake} or ${active}. ` +
      `Use ${attention} when a person must approve, decide, provide access, or interpret incomplete verification. Explain what is needed in the summary. ` +
      `A turn ending does not by itself mean the task is complete. For a user-created stage, use it only when its name unambiguously matches the work state; otherwise use ${attention} and explain why.`;
  };

  const dispatchTask = async (number: number, throwOnFailure: boolean) => {
    const current = getTaskRow(number);
    if (current.thread_id) return toTask(current);
    const claimed = db
      .prepare(
        "UPDATE triage_tasks SET run_state = 'dispatching', scheduled_at = NULL, updated_at = ? WHERE id = ? AND thread_id IS NULL AND run_state IN ('queued','scheduled','failed')",
      )
      .run(Date.now(), current.id);
    if (claimed.changes === 0) return toTask(getTaskRow(number));

    try {
      const request = newThreadRequestSchema.parse(JSON.parse(current.request_json));
      // Older composer builds persisted visible text as `visibility: "user"`.
      // The thread API represents visible input by omitting visibility and only
      // accepts the explicit value `agent-only`, so normalize stored requests
      // before a delayed dispatch.
      const normalizedInput = request.input.map((part) => {
        if (part.visibility === "agent-only" || part.visibility === undefined) return part;
        const { visibility: _visibility, ...visiblePart } = part;
        return visiblePart;
      });
      const input = [
        ...normalizedInput,
        {
          type: "text" as const,
          visibility: "agent-only" as const,
          text:
            `You are assigned to Triage #${number}. ${stageInstructions()}`,
          mentions: [],
        },
      ];
      type SpawnArgs = Parameters<BbPluginApi["sdk"]["threads"]["spawn"]>[0];
      const spawnArgs = {
        ...request,
        input,
        title: `Triage #${number}: ${current.title}`,
        visibility: showThreadsInSidebar ? "visible" as const : "hidden" as const,
      } as SpawnArgs;
      const thread = await bb.sdk.threads.spawn(spawnArgs);
      const activeStage = getSystemStage("active");
      db.prepare(
        "UPDATE triage_tasks SET thread_id = ?, stage_id = ?, run_state = 'starting', attention_reason = NULL, updated_at = ? WHERE id = ?",
      ).run(thread.id, activeStage.id, Date.now(), current.id);
      addEvent(current.id, "scheduler", "agent dispatched");
      notify({
        taskNumber: number,
        action: "Agent started",
        taskTitle: current.title,
        body: `Assigned to ${current.provider_id} · ${current.model}.`,
        level: "info",
      });
      return toTask(getTaskRow(number));
    } catch (error) {
      const message = errorMessage(error);
      const attention = getSystemStage("attention");
      db.prepare(
        "UPDATE triage_tasks SET stage_id = ?, run_state = 'failed', attention_reason = ?, read_at = NULL, updated_at = ? WHERE id = ?",
      ).run(attention.id, message, Date.now(), current.id);
      addEvent(current.id, "scheduler", "dispatch failed", message);
      notify({
        taskNumber: number,
        action: "Needs attention",
        taskTitle: current.title,
        body: message,
        level: "attention",
      });
      if (throwOnFailure) throw error;
      return toTask(getTaskRow(number));
    }
  };

  const snapshot = async () => {
    const [projectRows, machineRows] = await Promise.all([
      bb.sdk.projects.list({ includePersonal: true }),
      bb.sdk.hosts.list(),
    ]);
    const projects = [...projectRows]
      .sort((left, right) => {
        if (left.kind === right.kind) return 0;
        return left.kind === "personal" ? -1 : 1;
      })
      .map((project) => ({
        id: project.id, kind: project.kind,
        name: project.kind === "personal" ? "Personal" : project.name,
        defaultMachineId: project.sources?.find((source) => source.isDefault)?.hostId ?? null,
      }));
    const machines = machineRows.map((machine) => ({
      id: machine.id,
      name: machine.name,
      status: machine.status,
    }));
    const notifications = (
      db
        .prepare("SELECT * FROM triage_notifications ORDER BY created_at DESC LIMIT 50")
        .all() as NotificationRow[]
    ).map(toNotification);
    const unreadCount = (
      db.prepare("SELECT COUNT(*) AS count FROM triage_notifications WHERE read_at IS NULL").get() as {
        count: number;
      }
    ).count;
    const environments = new Map<string, ReturnType<typeof bb.sdk.environments.get>>();
    const tasks = await Promise.all(listTasks().map(async (task) => {
      const thread = task.threadId
        ? await bb.sdk.threads.get({ threadId: task.threadId }).catch(() => null)
        : null;
      const requestEnvironment = task.request?.environment;
      const environmentId = thread?.environmentId ??
        (requestEnvironment?.type === "reuse" && typeof requestEnvironment.environmentId === "string"
          ? requestEnvironment.environmentId : null);
      let branchName = task.branchName;
      if (environmentId) {
        try {
          let pending = environments.get(environmentId);
          if (!pending) {
            pending = bb.sdk.environments.get({ environmentId });
            environments.set(environmentId, pending);
          }
          const environment = await pending;
          branchName = environment.branchName || (environment.isGitRepo ? "Detached HEAD" : "No branch");
        } catch {
          // Keep the saved workspace description when the host is unavailable.
        }
      }
      return { ...task, branchName, sidebarVisible: thread ? thread.visibility === "visible" : null };
    }));
    return { stages: listStages(), tasks, projects, machines, notifications, unreadCount };
  };

  /**
   * Provider and model catalogue for the edit dialog's agent picker. A host
   * that cannot enumerate one provider should still offer the others, so each
   * lookup fails on its own.
   */
  const agentOptions = async () => {
    const providers = await bb.sdk.providers.list();
    const models: {
      id: string;
      providerId: string;
      model: string;
      displayName: string;
      description: string;
      supportedReasoningEfforts: (typeof reasoningLevelSchema)["options"][number][];
      defaultReasoningEffort: (typeof reasoningLevelSchema)["options"][number];
    }[] = [];
    for (const provider of providers) {
      if (!provider.available) continue;
      try {
        const result = await bb.sdk.providers.models({ providerId: provider.id });
        for (const model of result.models) {
          models.push({
            id: `${provider.id}:${model.id}`,
            providerId: provider.id,
            model: model.model,
            displayName: model.displayName,
            description: model.description,
            supportedReasoningEfforts: model.supportedReasoningEfforts.map(
              (effort) => effort.reasoningEffort,
            ),
            defaultReasoningEffort: model.defaultReasoningEffort,
          });
        }
      } catch (error) {
        bb.log.warn(
          `Triage could not list models for ${provider.id}: ${errorMessage(error)}`,
        );
      }
    }
    return {
      providers: providers.map((provider) => ({
        id: provider.id,
        name: provider.displayName,
        available: provider.available,
      })),
      models,
    };
  };

  bb.rpc.register(rpcContract, {
    snapshot: () => snapshot(),
    agentOptions: () => agentOptions(),
    async importThread({ threadId }) {
      const thread = await bb.sdk.threads.get({ threadId });
      if (thread.deletedAt !== null || thread.archivedAt !== null) {
        throw new Error("Open an unarchived session before moving it to Triage");
      }
      const existing = getTaskByThread(threadId);
      if (existing) {
        await setSidebarVisibility(threadId, false);
        publish();
        return toTask(existing);
      }
      const project = await bb.sdk.projects.get({ projectId: thread.projectId });
      const execution = await bb.sdk.threads.defaultExecutionOptions({ threadId });
      const machine = await resolveMachine({ type: "reuse", environmentId: thread.environmentId });
      // The unique thread_id plus this synchronous transaction makes retries and
      // concurrent imports converge on one card and one ticket number.
      const task = db.transaction(() => {
        const duplicate = getTaskByThread(threadId);
        if (duplicate) return duplicate;
        const { value: number } = db.prepare(
          "SELECT value FROM triage_meta WHERE key = 'next_task_number'",
        ).get() as { value: number };
        const now = Date.now();
        const active = thread.status === "active" || thread.status === "starting";
        const stage = getSystemStage(active ? "active" : "intake");
        db.prepare(`INSERT INTO triage_tasks (
          id, number, title, description, stage_id, project_id, project_name,
          machine_id, machine_name, provider_id, model, request_json,
          thread_id, run_state, created_at, updated_at
        ) VALUES (?, ?, ?, '', ?, ?, ?, ?, ?, ?, ?, 'null', ?, ?, ?, ?)`).run(
          crypto.randomUUID(), number,
          (thread.title || thread.titleFallback || "Untitled session").slice(0, 160),
          stage.id, thread.projectId, project.name, machine.machineId, machine.machineName,
          thread.providerId, execution?.model ?? "Default model", threadId,
          active ? "working" : thread.status === "error" ? "failed" : "idle", now, now,
        );
        db.prepare("UPDATE triage_meta SET value = value + 1 WHERE key = 'next_task_number'").run();
        const created = getTaskRow(number);
        addEvent(created.id, "user", "moved session to triage");
        return created;
      })();
      // Persist the card before hiding its session so a failed host update
      // leaves the conversation accessible; retry uses the existing card.
      publish();
      await setSidebarVisibility(threadId, false);
      return toTask(task);
    },
    async setShowInSidebar({ visible }) {
      await settings.experimental_set({ showInSidebar: visible });
      return { ok: true as const };
    },
    async setThreadSidebar({ number, visible }) {
      const task = getTaskRow(number);
      if (!task.thread_id) throw new Error("Start this task before showing its session in the sidebar");
      await setSidebarVisibility(task.thread_id, visible);
      publish();
      return { ok: true as const };
    },
    async createTask(input) {
      getStageRow(input.stageId);
      const project = await bb.sdk.projects.get({ projectId: input.request.projectId });
      const machine = await resolveMachine(input.request.environment);
      const allocateNumber = db.transaction(() => {
        const row = db
          .prepare("SELECT value FROM triage_meta WHERE key = 'next_task_number'")
          .get() as { value: number } | undefined;
        if (!row) throw new Error("Triage number counter is unavailable");
        db.prepare("UPDATE triage_meta SET value = value + 1 WHERE key = 'next_task_number'").run();
        return row.value;
      });
      const nextNumber = allocateNumber();
      const now = Date.now();
      const runState = input.scheduledAt === null ? "queued" : "scheduled";
      const id = crypto.randomUUID();
      db.prepare(
        `INSERT INTO triage_tasks (
          id, number, title, description, stage_id, project_id, project_name,
          machine_id, machine_name, provider_id, model, request_json,
          scheduled_at, thread_id, run_state, attention_reason, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL, ?, ?)`,
      ).run(
        id,
        nextNumber,
        input.title.trim(),
        input.description,
        input.stageId,
        input.request.projectId,
        project.name,
        machine.machineId,
        machine.machineName,
        input.request.providerId,
        input.request.model,
        JSON.stringify(input.request),
        input.scheduledAt,
        runState,
        now,
        now,
      );
      addEvent(id, "user", input.scheduledAt === null ? "created" : "scheduled");
      publish();
      if (input.runNow) return dispatchTask(nextNumber, true);
      return toTask(getTaskRow(nextNumber));
    },
    moveTask: ({ number, stageId, summary }) =>
      moveTask(number, stageId, "user", summary, false),
    setTaskSettled({ number, settled }) {
      const task = getTaskRow(number);
      const now = Date.now();
      db.prepare(
        "UPDATE triage_tasks SET settled_at = ?, updated_at = ? WHERE id = ?",
      ).run(settled ? now : null, now, task.id);
      addEvent(task.id, "user", settled ? "marked settled" : "reopened");
      publish();
      return toTask(getTaskRow(number));
    },
    setTaskRead({ number, read }) {
      const task = getTaskRow(number);
      db.prepare("UPDATE triage_tasks SET read_at = ? WHERE id = ?").run(read ? Date.now() : null, task.id);
      publish();
      return toTask(getTaskRow(number));
    },
    async updateTask(input) {
      const task = getTaskRow(input.number);
      const stage = getStageRow(input.stageId);
      if (input.scheduledAt !== null && input.scheduledAt <= Date.now()) {
        throw new Error("Choose a future date and time");
      }
      if (task.thread_id && input.scheduledAt !== task.scheduled_at) {
        throw new Error("A task cannot be rescheduled after its agent thread has started");
      }

      const retargeting =
        input.providerId !== undefined ||
        input.model !== undefined ||
        input.reasoningLevel !== undefined;
      if (task.thread_id && retargeting) {
        throw new Error("A task cannot change agent after its thread has started");
      }

      let request = newThreadRequestSchema.parse(JSON.parse(task.request_json));
      let projectId = task.project_id;
      let projectName = task.project_name;
      let machineId = task.machine_id;
      let machineName = task.machine_name;

      if (!task.thread_id && input.request) {
        request = input.request;
        const project = await bb.sdk.projects.get({ projectId: request.projectId });
        const machine = await resolveMachine(request.environment);
        projectId = request.projectId;
        projectName = project.name;
        machineId = machine.machineId;
        machineName = machine.machineName;
      } else {
        if (retargeting) {
          request.providerId = input.providerId ?? request.providerId;
          request.model = input.model ?? request.model;
          request.reasoningLevel = input.reasoningLevel ?? request.reasoningLevel;
          // The picked values are now the user's, not a client preference.
          request.executionInputSources = {
            ...request.executionInputSources,
            ...(input.providerId !== undefined ? { providerId: "explicit" as const } : {}),
            ...(input.model !== undefined ? { model: "explicit" as const } : {}),
            ...(input.reasoningLevel !== undefined
              ? { reasoningLevel: "explicit" as const }
              : {}),
          };
        }
        if (!task.thread_id) {
          const visibleTextIndex = request.input.findIndex(
            (part) => part.type === "text" && part.visibility !== "agent-only",
          );
          const visibleText = {
            type: "text" as const,
            text: input.description,
            mentions: [],
          };
          const remaining = request.input.filter(
            (part) => part.type !== "text" || part.visibility === "agent-only",
          );
          remaining.splice(Math.max(0, visibleTextIndex), 0, visibleText);
          request.input = remaining;
        }
      }
      const editableRunState = task.thread_id
        ? task.run_state
        : input.scheduledAt === null
          ? "queued"
          : "scheduled";
      const nextRunState = stage.system_role === "done"
        ? "completed"
        : editableRunState;
      db.prepare(
        `UPDATE triage_tasks
         SET title = ?, description = ?, stage_id = ?, request_json = ?,
             project_id = ?, project_name = ?, machine_id = ?, machine_name = ?,
             provider_id = ?, model = ?,
             scheduled_at = ?, run_state = ?, updated_at = ?
         WHERE id = ?`,
      ).run(
        input.title.trim(),
        input.description,
        input.stageId,
        JSON.stringify(request),
        projectId,
        projectName,
        machineId,
        machineName,
        request.providerId,
        request.model,
        input.scheduledAt,
        nextRunState,
        Date.now(),
        task.id,
      );
      addEvent(task.id, "user", "edited task");
      if (task.thread_id && input.title.trim() !== task.title) {
        try {
          await bb.sdk.threads.update({
            threadId: task.thread_id,
            title: `Triage #${task.number}: ${input.title.trim()}`,
          });
        } catch (error) {
          bb.log.warn(
            `Updated Triage #${task.number}, but its thread title could not be synced: ${errorMessage(error)}`,
          );
        }
      }
      publish();
      return toTask(getTaskRow(input.number));
    },
    async renameTask({ number, title }) {
      const task = getTaskRow(number);
      if (task.thread_id) {
        await bb.sdk.threads.update({ threadId: task.thread_id, title: `Triage #${number}: ${title}` });
      }
      db.prepare("UPDATE triage_tasks SET title = ?, updated_at = ? WHERE id = ?").run(title, Date.now(), task.id);
      addEvent(task.id, "user", "renamed task");
      publish();
      return toTask(getTaskRow(number));
    },
    runTask: ({ number }) => dispatchTask(number, true),
    async stopTask({ number }) {
      const task = getTaskRow(number);
      if (!task.thread_id) throw new Error(`Triage #${number} has no agent thread to stop`);
      if (!["dispatching", "starting", "working"].includes(task.run_state)) {
        throw new Error(`Triage #${number} is not currently running`);
      }
      await bb.sdk.threads.stop({ threadId: task.thread_id });
      db.prepare(
        "UPDATE triage_tasks SET run_state = 'stopped', updated_at = ? WHERE id = ?",
      ).run(Date.now(), task.id);
      addEvent(task.id, "user", "agent stopped");
      publish();
      return toTask(getTaskRow(number));
    },
    deleteTask({ number }) {
      const task = getTaskRow(number);
      if (task.thread_id) pendingVisibility.delete(task.thread_id);
      db.transaction(() => {
        // Keep deletion correct even if a host has SQLite foreign keys disabled.
        db.prepare("DELETE FROM triage_events WHERE task_id = ?").run(task.id);
        db.prepare("DELETE FROM triage_tasks WHERE id = ?").run(task.id);
      })();
      publish();
      return { ok: true as const };
    },
    createStage({ name }) {
      const position = (
        db.prepare("SELECT COALESCE(MAX(position), 0) + 100 AS position FROM triage_stages").get() as {
          position: number;
        }
      ).position;
      const id = crypto.randomUUID();
      db.prepare("INSERT INTO triage_stages (id, name, position, system_role) VALUES (?, ?, ?, NULL)").run(
        id,
        name.trim(),
        position,
      );
      publish();
      return toStage(getStageRow(id));
    },
    renameStage({ id, name }) {
      getStageRow(id);
      db.prepare("UPDATE triage_stages SET name = ? WHERE id = ?").run(name.trim(), id);
      publish();
      return toStage(getStageRow(id));
    },
    reorderStage({ id, direction, targetId }) {
      const stages = listStages();
      const index = stages.findIndex((stage) => stage.id === id);
      if (targetId) {
        getStageRow(id);
        getStageRow(targetId);
        const targetIndex = stages.findIndex((stage) => stage.id === targetId);
        const [moved] = stages.splice(index, 1);
        stages.splice(targetIndex, 0, moved!);
        db.transaction(() => {
          stages.forEach((stage, position) => db.prepare("UPDATE triage_stages SET position = ? WHERE id = ?").run(-position - 1, stage.id));
          stages.forEach((stage, position) => db.prepare("UPDATE triage_stages SET position = ? WHERE id = ?").run(position, stage.id));
        })();
        publish();
        return { stages: listStages() };
      }
      if (!direction) throw new Error("Provide a direction or target stage");
      const otherIndex = direction === "left" ? index - 1 : index + 1;
      if (index >= 0 && otherIndex >= 0 && otherIndex < stages.length) {
        const first = stages[index]!;
        const second = stages[otherIndex]!;
        const swap = db.transaction(() => {
          db.prepare("UPDATE triage_stages SET position = -1 WHERE id = ?").run(first.id);
          db.prepare("UPDATE triage_stages SET position = ? WHERE id = ?").run(
            first.position,
            second.id,
          );
          db.prepare("UPDATE triage_stages SET position = ? WHERE id = ?").run(
            second.position,
            first.id,
          );
        });
        swap();
        publish();
      }
      return { stages: listStages() };
    },
    deleteStage({ id }) {
      const stage = getStageRow(id);
      if (stage.system_role) throw new Error("Core workflow stages can be renamed but not removed");
      const count = (
        db.prepare("SELECT COUNT(*) AS count FROM triage_tasks WHERE stage_id = ?").get(id) as {
          count: number;
        }
      ).count;
      if (count > 0) throw new Error("Move every card out of this stage before removing it");
      db.prepare("DELETE FROM triage_stages WHERE id = ?").run(id);
      publish();
      return { ok: true as const };
    },
    markNotificationsRead({ ids }) {
      if (ids === null) {
        db.prepare("UPDATE triage_notifications SET read_at = ? WHERE read_at IS NULL").run(
          Date.now(),
        );
      } else if (ids.length > 0) {
        const placeholders = ids.map(() => "?").join(", ");
        db.prepare(
          `UPDATE triage_notifications SET read_at = ? WHERE read_at IS NULL AND id IN (${placeholders})`,
        ).run(Date.now(), ...ids);
      }
      publish();
      return { ok: true as const };
    },
    deleteNotifications({ ids }) {
      const placeholders = ids.map(() => "?").join(", ");
      db.prepare(`DELETE FROM triage_notifications WHERE id IN (${placeholders})`).run(...ids);
      publish();
      return { ok: true as const };
    },
  });

  bb.agents.registerTool({
    name: "triage_move_task",
    description:
      "Move the Triage card assigned to this BB thread into another workflow stage and leave a concise handoff summary.",
    instructions:
      "Keep the assigned card accurate when work starts or resumes. Before the final response, move completed work to the completion stage or work requiring user input to the attention stage, with a concise summary.",
    presentation: {
      label: {
        pending: "Updating the Triage card",
        completed: "Updated the Triage card",
      },
    },
    parameters: z.object({
      number: z.number().int().positive().describe("The number in Triage #42"),
      stage: z.string().trim().min(1).describe("The destination stage name"),
      summary: z.string().trim().min(1).max(2_000).describe("What changed or what the user needs to know"),
    }),
    execute({ number, stage, summary }, context) {
      const task = getTaskRow(number);
      if (task.thread_id !== context.threadId) {
        throw new Error(`Triage #${number} is not assigned to this thread`);
      }
      const destination = db
        .prepare(
          "SELECT id, name, position, system_role FROM triage_stages WHERE name = ? COLLATE NOCASE",
        )
        .get(stage) as StageRow | undefined;
      if (!destination) {
        throw new Error(`Unknown stage “${stage}”. Available stages: ${listStages().map((item) => item.name).join(", ")}`);
      }
      moveTask(number, destination.id, "agent", summary, true);
      return `Moved Triage #${number} to ${destination.name}.`;
    },
  });

  bb.agents.configure((context) => {
    const task = getTaskByThread(context.thread.id);
    if (!task) return { tools: [], skills: [] };
    return {
      tools: ["triage_move_task"],
      skills: [],
      instructions:
        `You own Triage #${task.number}: ${task.title}. ` +
        `Current stage: ${getStageRow(task.stage_id).name}. ` +
        stageInstructions(),
    };
  });

  bb.events.on("thread.active", ({ thread }) => {
    const task = getTaskByThread(thread.id);
    if (!task) return;
    const active = getSystemStage("active");
    db.prepare(
      "UPDATE triage_tasks SET stage_id = ?, run_state = 'working', attention_reason = NULL, settled_at = NULL, updated_at = ? WHERE id = ?",
    ).run(active.id, Date.now(), task.id);
    addEvent(task.id, "bb", "agent active");
    publish();
  });

  bb.events.on("thread.idle", ({ thread }) => {
    const task = getTaskByThread(thread.id);
    if (!task) return;
    if (task.run_state === "stopped" || getStageRow(task.stage_id).system_role === "done") {
      publish();
      return;
    }
    db.prepare("UPDATE triage_tasks SET run_state = 'idle', read_at = NULL, updated_at = ? WHERE id = ?").run(
      Date.now(),
      task.id,
    );
    const stage = getStageRow(task.stage_id);
    if (stage.system_role === "active") {
      notify({
        taskNumber: task.number,
        action: "Waiting for you",
        taskTitle: task.title,
        body: "The agent finished its turn. Open the thread to review its update.",
        level: "info",
      });
    } else {
      publish();
    }
  });

  bb.events.on("thread.failed", ({ thread, error }) => {
    const task = getTaskByThread(thread.id);
    if (!task) return;
    const attention = getSystemStage("attention");
    const reason = error?.trim() || "The assigned BB thread failed.";
    db.prepare(
      "UPDATE triage_tasks SET stage_id = ?, run_state = 'failed', attention_reason = ?, updated_at = ? WHERE id = ?",
    ).run(attention.id, reason, Date.now(), task.id);
    addEvent(task.id, "bb", "agent failed", reason);
    notify({
      taskNumber: task.number,
      action: "Needs attention",
      taskTitle: task.title,
      body: reason,
      level: "attention",
    });
  });

  bb.events.on("thread.deleted", ({ thread }) => {
    pendingVisibility.delete(thread.id);
    const task = getTaskByThread(thread.id);
    if (!task) return;
    db.prepare(
      "UPDATE triage_tasks SET thread_id = NULL, run_state = 'stopped', attention_reason = 'The linked BB thread was deleted.', updated_at = ? WHERE id = ?",
    ).run(Date.now(), task.id);
    notify({
      taskNumber: task.number,
      action: "Lost its thread",
      taskTitle: task.title,
      body: "The linked BB thread was deleted. You can run the card again.",
      level: "attention",
    });
  });

  bb.cli.register({
    name: "triage",
    summary: "List, inspect, run, and move Triage cards",
    commands: [
      { name: "list", summary: "List Triage cards", usage: "bb triage list [--json]" },
      { name: "show", summary: "Show a Triage card", usage: "bb triage show <number> [--json]" },
      { name: "run", summary: "Run a Triage card now", usage: "bb triage run <number> [--json]" },
      { name: "move", summary: "Move a Triage card", usage: "bb triage move <number> <stage> [--summary <text>] [--json]" },
      { name: "stages", summary: "List workflow stages", usage: "bb triage stages [--json]" },
    ],
    async run(argv) {
      const json = argv.includes("--json");
      const args = argv.filter((arg) => arg !== "--json");
      const [command, numberText, ...rest] = args;
      try {
        if (!command || command === "help" || command === "--help") {
          return {
            exitCode: 0,
            stdout:
              "Usage: bb triage list|show|run|move|stages\n" +
              "Cards use GitHub-style numbers, for example: bb triage show 42",
          };
        }
        if (command === "list") {
          const tasks = listTasks();
          return {
            exitCode: 0,
            stdout: json
              ? JSON.stringify({ tasks })
              : tasks.map((task) => `Triage #${task.number}\t${getStageRow(task.stageId).name}\t${task.title}`).join("\n") ||
                "No Triage cards.",
          };
        }
        if (command === "stages") {
          const stages = listStages();
          return {
            exitCode: 0,
            stdout: json ? JSON.stringify({ stages }) : stages.map((stage) => stage.name).join("\n"),
          };
        }
        const number = Number(numberText);
        if (!Number.isInteger(number) || number <= 0) throw new Error("Provide a positive Triage number");
        if (command === "show") {
          const task = toTask(getTaskRow(number));
          return {
            exitCode: 0,
            stdout: json ? JSON.stringify({ task }) : `Triage #${task.number}: ${task.title}\nStage: ${getStageRow(task.stageId).name}\nRun: ${task.runState}`,
          };
        }
        if (command === "run") {
          const task = await dispatchTask(number, true);
          return {
            exitCode: 0,
            stdout: json ? JSON.stringify({ task }) : `Started Triage #${number}.`,
          };
        }
        if (command === "move") {
          const summaryIndex = rest.indexOf("--summary");
          const stageParts = summaryIndex >= 0 ? rest.slice(0, summaryIndex) : rest;
          const summary = summaryIndex >= 0 ? rest.slice(summaryIndex + 1).join(" ") : undefined;
          const stageName = stageParts.join(" ").trim();
          const stage = db
            .prepare("SELECT id, name, position, system_role FROM triage_stages WHERE name = ? COLLATE NOCASE")
            .get(stageName) as StageRow | undefined;
          if (!stage) throw new Error(`Unknown stage “${stageName}”`);
          const task = moveTask(number, stage.id, "cli", summary, false);
          return {
            exitCode: 0,
            stdout: json ? JSON.stringify({ task }) : `Moved Triage #${number} to ${stage.name}.`,
          };
        }
        throw new Error(`Unknown command “${command}”`);
      } catch (error) {
        return { exitCode: 1, stderr: errorMessage(error) };
      }
    },
  });

  bb.background.service("scheduler", {
    async start(signal) {
      while (!signal.aborted) {
        await syncSidebarVisibility();
        if (signal.aborted) break;
        const due = db
          .prepare(
            "SELECT number FROM triage_tasks WHERE run_state = 'scheduled' AND scheduled_at IS NOT NULL AND scheduled_at <= ? ORDER BY scheduled_at LIMIT 20",
          )
          .all(Date.now()) as Array<{ number: number }>;
        for (const task of due) {
          if (signal.aborted) break;
          await dispatchTask(task.number, false);
        }
        await sleep(10_000, signal);
      }
    },
  });

  bb.log.info("Triage loaded");
}
