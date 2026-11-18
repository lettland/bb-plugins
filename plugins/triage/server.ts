import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

const stageSchema = z.object({
  id: z.string(),
  name: z.string(),
  position: z.number().int(),
  systemRole: z.enum(["intake", "active", "attention", "done"]).nullable(),
});

const executionSourceSchema = z.enum(["explicit", "client-preference"]);
export const newThreadRequestSchema = z
  .object({
    projectId: z.string().min(1),
    providerId: z.string().min(1),
    model: z.string().min(1),
    // SDK providers can report reasoning levels and service tiers beyond the
    // known values, so the wire accepts any string; only display labels stay
    // closed (triage-format).
    reasoningLevel: z.string(),
    permissionMode: z.enum(["accept-edits", "auto", "full"]),
    serviceTier: z.string().optional(),
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
  reasoningLevel: z.string(),
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
      supportedReasoningEfforts: z.array(z.string()),
      defaultReasoningEffort: z.string(),
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
        reasoningLevel: z.string().optional(),
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

type CardOrigin = "manual" | "mirror";

type ThreadListArgs = Parameters<BbPluginApi["sdk"]["threads"]["list"]>[0];
type ThreadListItem = Awaited<ReturnType<BbPluginApi["sdk"]["threads"]["list"]>>[number];
// The fields a card needs; threads.get, threads.list and thread events all carry them.
type CardThread = Pick<
  ThreadListItem,
  | "id" | "projectId" | "environmentId" | "providerId" | "status" | "title" | "titleFallback" | "archivedAt" | "deletedAt"
  | "parentThreadId" | "visibility" | "latestAttentionAt" | "lastReadAt"
>;
/** A thread as the root walk and shouldMirror read it. */
type RootThread = CardThread & { originPluginId: string | null };

/** Per-pass lookup caches: each value is the pending promise, so concurrent cards share one call. */
interface LookupCaches {
  projects: Map<string, Promise<string>>;
  environments: Map<string, Promise<string | null>>;
  hosts: Map<string, Promise<string>>;
}

const newLookupCaches = (): LookupCaches => ({
  projects: new Map(),
  environments: new Map(),
  hosts: new Map(),
});

const memoize = <T>(cache: Map<string, Promise<T>> | undefined, key: string, load: () => Promise<T>) => {
  if (!cache) return load();
  let pending = cache.get(key);
  if (!pending) {
    pending = load();
    cache.set(key, pending);
  }
  return pending;
};

// threads.list takes at most 200 thread ids per call and 200 rows per page.
const THREAD_LIST_BATCH = 200;
/** Only visible top-level sessions get board cards: sub-threads and hidden workers never do. */
const isMirrorable = (thread: Pick<CardThread, "parentThreadId" | "visibility">) =>
  thread.parentThreadId === null && thread.visibility === "visible";
// One shared trailing timer coalesces the bursts that thread events produce.
const PUBLISH_DEBOUNCE_MS = 250;

const nativeRead = (thread: Pick<CardThread, "latestAttentionAt" | "lastReadAt">) =>
  thread.latestAttentionAt != null && thread.latestAttentionAt > 0 && thread.lastReadAt != null && thread.lastReadAt >= thread.latestAttentionAt;

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
  origin: CardOrigin;
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
  // Mirror cards are a view of a session; manual cards are a commitment to it.
  `ALTER TABLE triage_tasks ADD COLUMN origin TEXT NOT NULL DEFAULT 'manual'`,
  // Deleting a mirror card opts that session out of mirroring; see shouldMirror.
  `CREATE TABLE IF NOT EXISTS triage_mirror_tombstones (
    thread_id TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL
  )`,
  // Mirror cards from before the idle/failed settle fix stayed unsettled; settle them once.
  `UPDATE triage_tasks SET settled_at = CAST(strftime('%s','now') AS INTEGER) * 1000 WHERE origin = 'mirror' AND settled_at IS NULL AND run_state IN ('idle','failed')`,
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
    autoCardThreads: {
      type: "boolean",
      label: "Automatically card every session",
      description: "Mirror every session onto the board as a view-only card. Turning it off stops new mirroring; existing mirrored cards stay until deleted.",
      default: true,
    },
  });

  const initialSettings = await settings.get();
  let showThreadsInSidebar = initialSettings.showThreadsInSidebar;
  let autoCardThreads = initialSettings.autoCardThreads;
  let mirroringGeneration = 0;
  const pendingVisibility = new Map<string, { visible: boolean }>();
  // A mirror card's creation in flight, by thread id. Lifecycle events for that
  // thread wait for it, or they find no card yet and are lost.
  const pendingMirror = new Map<string, Promise<void>>();
  let disposed = false;
  let publishTimer: ReturnType<typeof setTimeout> | undefined;
  bb.onDispose(() => {
    disposed = true;
    pendingVisibility.clear();
    pendingMirror.clear();
    clearTimeout(publishTimer);
  });
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
    if (next.autoCardThreads !== prev.autoCardThreads || next.showThreadsInSidebar !== prev.showThreadsInSidebar) mirroringGeneration += 1;
    showThreadsInSidebar = next.showThreadsInSidebar;
    autoCardThreads = next.autoCardThreads;
    // Turning mirroring off is not destructive; turning it on catches up.
    if (next.autoCardThreads && !prev.autoCardThreads) void runBackfill();
    if (next.showThreadsInSidebar === prev.showThreadsInSidebar) return;
    // Mirror cards are a view and never take sidebar writes.
    const rows = db.prepare("SELECT thread_id FROM triage_tasks WHERE thread_id IS NOT NULL AND origin = 'manual'").all() as { thread_id: string }[];
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

  const sameReadTarget = (before: TaskRow, after: TaskRow) =>
    before.id === after.id && before.thread_id === after.thread_id && before.stage_id === after.stage_id &&
    before.run_state === after.run_state && before.updated_at === after.updated_at &&
    before.read_at === after.read_at && before.settled_at === after.settled_at &&
    before.attention_reason === after.attention_reason && before.title === after.title && before.origin === after.origin;

  const captureTarget = (row: TaskRow) => ({
    row,
    eventId: (db.prepare("SELECT rowid FROM triage_events WHERE task_id = ? ORDER BY rowid DESC LIMIT 1").get(row.id) as { rowid: number } | undefined)?.rowid,
    readGeneration: threadReadGeneration.get(row.thread_id!) ?? 0,
    broadReadGeneration,
  });

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

  /** Remove a mirror card and its history. */
  const deleteMirrorCard = (taskId: string) =>
    db.transaction(() => {
      db.prepare("DELETE FROM triage_events WHERE task_id = ?").run(taskId);
      db.prepare("DELETE FROM triage_tasks WHERE id = ?").run(taskId);
    })();

  /** Track a card creation in flight; `creation` never rejects. */
  const trackMirror = (threadId: string, creation: Promise<void>) => {
    pendingMirror.set(threadId, creation);
    void creation.finally(() => {
      if (pendingMirror.get(threadId) === creation) pendingMirror.delete(threadId);
    });
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

  /** Trailing-debounced publish for thread events; RPC handlers publish directly. */
  const publishSoon = () => {
    clearTimeout(publishTimer);
    publishTimer = setTimeout(() => {
      publishTimer = undefined;
      publish();
    }, PUBLISH_DEBOUNCE_MS);
  };

  type NativeRetry = { threadId: string; freshInput?: boolean; expected?: ReturnType<typeof captureTarget>; generation?: number };
  const responseChecks = new Map<string, Set<{ valid: boolean; retry?: NativeRetry }>>();
  const invalidateResponseChecks = (threadId: string) => {
    for (const check of responseChecks.get(threadId) ?? []) check.valid = false;
  };

  let readStateGeneration = 0;
  let broadReadGeneration = 0;
  const threadReadGeneration = new Map<string, number>();
  const unsubscribeReadState = bb.sdk.subscribe({ event: "thread:changed", callback: (event) => {
    if (event.changes.includes("interactions-changed")) {
      if (event.id) { invalidateResponseChecks(event.id); void reconcileNative(event.id); }
      else {
        for (const threadId of responseChecks.keys()) invalidateResponseChecks(threadId);
        void reconcileAll();
      }
    }
    if (!event.changes.includes("read-state-changed")) return;
    readStateGeneration += 1;
    if (event.id) {
      threadReadGeneration.set(event.id, (threadReadGeneration.get(event.id) ?? 0) + 1);
      invalidateResponseChecks(event.id);
      const task = getTaskByThread(event.id);
      if (task) void reconcileNative(event.id);
      if (!task) return;
    } else {
      broadReadGeneration += 1;
      for (const threadId of responseChecks.keys()) invalidateResponseChecks(threadId);
      void reconcileAll();
    }
    publishSoon();
  } });
  bb.onDispose(unsubscribeReadState);
  bb.events.on("interaction.pending", ({ thread }) => { invalidateResponseChecks(thread.id); void reconcileNative(thread.id, false, undefined, true); });

  const notify = (input: {
    taskNumber: number | null;
    /** Short phrase: what just happened. */
    action: string;
    /** Title of the card it happened to, so the list can name it. */
    taskTitle: string | null;
    body: string;
    level: "info" | "success" | "attention";
  }) => {
    const title =
      // v8 ignore start -- @preserve no current caller reaches the untitled side: every notify() call site passes a real card number (moveTask server.ts:637, dispatchTask server.ts:730 and server.ts:745, thread idle server.ts:1299, agent failed server.ts:1320, thread.deleted server.ts:1336). The per-line split was measured: v8 keeps the dead arm's row and hides the live arm's instead, so the pair must cover the whole ternary.
      input.taskNumber === null
        ? input.action
      // v8 ignore stop
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
  ) => {
    const task = getTaskRow(number);
    const stage = getStageRow(stageId);
    const now = Date.now();
    const nextRunState = stage.system_role === "done" ? "completed" : task.run_state;
    db.prepare(
      `UPDATE triage_tasks SET stage_id = ?, run_state = ?, updated_at = ? WHERE id = ?`,
    ).run(stage.id, nextRunState, now, task.id);
    addEvent(task.id, actor, `moved to ${stage.name}`, summary);
    publish();
    return toTask(getTaskRow(number));
  };

  const resolveMachine = async (environment: Record<string, unknown>, caches?: LookupCaches) => {
    let machineId = typeof environment.hostId === "string" ? environment.hostId : null;
    if (!machineId && environment.type === "reuse" && typeof environment.environmentId === "string") {
      const environmentId = environment.environmentId;
      machineId = await memoize(caches?.environments, environmentId, async () => {
        try {
          return (await bb.sdk.environments.get({ environmentId })).hostId;
        } catch {
          return null;
        }
      });
    }
    if (!machineId) return { machineId: null, machineName: "Project default" };
    const hostId = machineId;
    const machineName = await memoize(caches?.hosts, hostId, async () => {
      try {
        return (await bb.sdk.hosts.get({ hostId })).name;
      } catch {
        return hostId;
      }
    });
    return { machineId, machineName };
  };

  /**
   * Create the card for a session unless it already has one. The unique
   * thread_id plus the synchronous transaction makes retries and concurrent
   * callers (import, mirror, backfill) converge on one card and one number.
   * Returns undefined for deleted or archived sessions that have no card.
   */
  const ensureCardForThread = async (
    thread: CardThread,
    origin: CardOrigin,
    caches?: LookupCaches,
    options: { model?: string; event?: string; settleIfDormant?: boolean } = {},
  ) => {
    const generation = mirroringGeneration;
    const existing = getTaskByThread(thread.id);
    if (existing) return existing;
    if (thread.deletedAt !== null || thread.archivedAt !== null) return undefined;
    // A project that cannot be read still gets a card, named by its id.
    const projectName = await memoize(caches?.projects, thread.projectId, async () => {
      try {
        return (await bb.sdk.projects.get({ projectId: thread.projectId })).name;
      } catch {
        return thread.projectId;
      }
    });
    const machine = await resolveMachine({ type: "reuse", environmentId: thread.environmentId }, caches);
    if (disposed) return undefined;
    return db.transaction(() => {
      const duplicate = getTaskByThread(thread.id);
      if (duplicate) return duplicate;
      if (origin === "mirror" && (!autoCardThreads || generation !== mirroringGeneration ||
        db.prepare("SELECT 1 FROM triage_mirror_tombstones WHERE thread_id = ?").get(thread.id) !== undefined)) return undefined;
      const { value: number } = db.prepare(
        "SELECT value FROM triage_meta WHERE key = 'next_task_number'",
      ).get() as { value: number };
      const now = Date.now();
      const active = thread.status === "active" || thread.status === "starting";
      const stage = getSystemStage(active ? "active" : "intake");
      // Dormant history (idle or failed sessions) starts settled; live ones stay on the board.
      const settledAt = options.settleIfDormant && (thread.status === "idle" || thread.status === "error") ? now : null;
      db.prepare(`INSERT INTO triage_tasks (
        id, number, title, description, stage_id, project_id, project_name,
        machine_id, machine_name, provider_id, model, request_json,
        thread_id, run_state, origin, settled_at, created_at, updated_at
      ) VALUES (?, ?, ?, '', ?, ?, ?, ?, ?, ?, ?, 'null', ?, ?, ?, ?, ?, ?)`).run(
        crypto.randomUUID(), number,
        (thread.title || thread.titleFallback || "Untitled session").slice(0, 160),
        stage.id, thread.projectId, projectName, machine.machineId, machine.machineName,
        thread.providerId, options.model ?? "Default model", thread.id,
        active ? "working" : thread.status === "error" ? "failed" : "idle",
        origin, settledAt, now, now,
      );
      db.prepare("UPDATE triage_meta SET value = value + 1 WHERE key = 'next_task_number'").run();
      const created = getTaskRow(number);
      if (origin === "mirror") addEvent(created.id, "bb", options.event ?? "mirrored");
      else addEvent(created.id, "user", "moved session to triage");
      return created;
    })();
  };

  const dispatchTask = async (number: number, throwOnFailure: boolean) => {
    const current = getTaskRow(number);
    if (current.thread_id) return toTask(current);
    const claimed = db
      .prepare(
        "UPDATE triage_tasks SET run_state = 'dispatching', scheduled_at = NULL, updated_at = ? WHERE id = ? AND thread_id IS NULL AND run_state IN ('queued','scheduled','failed','stopped')",
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
      type SpawnArgs = Parameters<BbPluginApi["sdk"]["threads"]["spawn"]>[0];
      const spawnArgs = {
        ...request,
        input: normalizedInput,
        title: `Triage #${number}: ${current.title}`,
        visibility: showThreadsInSidebar ? "visible" as const : "hidden" as const,
      } as SpawnArgs;
      const thread = await bb.sdk.threads.spawn(spawnArgs);
      const activeStage = getSystemStage("active");
      db.transaction(() => {
        // The spawn can announce its thread before this link lands, so a mirror
        // card may already hold the id. The composer card is the commitment and
        // adopts the thread; the mirror card goes away with its history.
        db.prepare(
          "DELETE FROM triage_events WHERE task_id IN (SELECT id FROM triage_tasks WHERE thread_id = ? AND origin = 'mirror')",
        ).run(thread.id);
        db.prepare("DELETE FROM triage_tasks WHERE thread_id = ? AND origin = 'mirror'").run(thread.id);
        db.prepare(
          "UPDATE triage_tasks SET thread_id = ?, stage_id = ?, run_state = 'starting', attention_reason = NULL, updated_at = ? WHERE id = ?",
        ).run(thread.id, activeStage.id, Date.now(), current.id);
      })();
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
      db.prepare(
        "UPDATE triage_tasks SET run_state = 'failed', attention_reason = ?, updated_at = ? WHERE id = ?",
      ).run(message, Date.now(), current.id);
      addEvent(current.id, "scheduler", "dispatch failed", message);
      publish();
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
    const environments = new Map<string, ReturnType<typeof bb.sdk.environments.get>>();
    const snapshotRows = db.prepare("SELECT * FROM triage_tasks ORDER BY updated_at DESC, number DESC").all() as TaskRow[];
    const cards = snapshotRows.map(toTask);
    const snapshotTargets = new Map(snapshotRows.flatMap((row) => row.thread_id ? [[row.thread_id, captureTarget(row)] as const] : []));
    const capturedReadStateGeneration = readStateGeneration;
    const capturedSettingsGeneration = mirroringGeneration;
    const capturedChildEvents = childEventCount;
    // Sessions come from batched threads.list calls, not one threads.get per
    // card (SDK bundled-types ThreadListArgs doc, bb-plugin-sdk.d.ts:18210-18232):
    //  - at most 200 ids per call, so ids go out in chunks;
    //  - unknown and deleted ids are silently dropped, so a gone session just
    //    has no entry (its card keeps the saved workspace description);
    //  - includeHidden is required or hidden sessions (plugin-spawned workers,
    //    Triage's own sessions) vanish from the answer;
    //  - archived is a selector, not an include flag: archived:true returns
    //    only the archived half, so each chunk needs a companion call or the
    //    settled cards of archived sessions lose their visibility and branch.
    const listBatch = (args: ThreadListArgs) => bb.sdk.threads.list(args);
    const threadIds = cards.flatMap((card) => (card.threadId ? [card.threadId] : []));
    const batches: Promise<ThreadListItem[]>[] = [];
    for (let start = 0; start < threadIds.length; start += THREAD_LIST_BATCH) {
      const chunk = threadIds.slice(start, start + THREAD_LIST_BATCH);
      batches.push(listBatch({ threadIds: chunk, includeHidden: true, limit: THREAD_LIST_BATCH }));
      batches.push(listBatch({ threadIds: chunk, archived: true, includeHidden: true, limit: THREAD_LIST_BATCH }));
    }
    const threadsById = new Map<string, ThreadListItem>();
    try {
      for (const batch of await Promise.all(batches)) {
        for (const listed of batch) threadsById.set(listed.id, listed);
      }
    } catch (error) {
      bb.log.warn(`Triage could not look up sessions to reconcile: ${errorMessage(error)}`);
      throw error;
    }
    if (mirroringGeneration === capturedSettingsGeneration) {
      if (pendingChildHandlers > 0) deferredSnapshots.push({ targets: snapshotTargets, generation: capturedSettingsGeneration });
      else if (childEventCount !== capturedChildEvents) await reconcileAll(undefined, snapshotTargets);
      else await reconcileAll(undefined, snapshotTargets, threadsById);
    }
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
    const doneId = getSystemStage("done").id;
    const synchronizedCards = cards.map((task) => {
      const thread = task.threadId ? threadsById.get(task.threadId) : undefined;
      if (readStateGeneration === capturedReadStateGeneration && task.stageId === doneId && task.runState === "completed" && thread?.archivedAt === null && thread.deletedAt === null && thread.latestAttentionAt != null && thread.latestAttentionAt > 0) {
        const read = nativeRead(thread);
        const lastAction = db.prepare("SELECT event, created_at FROM triage_events WHERE task_id = ? AND actor = 'user' AND event IN ('marked settled', 'reopened') ORDER BY rowid DESC LIMIT 1").get(task.id) as { event: string; created_at: number } | undefined;
        const explicitlySettled = task.readAt !== null && lastAction?.event === "marked settled" && lastAction.created_at >= task.readAt;
        if ((read && (task.readAt === null || task.settledAt === null)) || (!read && task.readAt !== null && !explicitlySettled)) {
          const now = Date.now();
          db.prepare("UPDATE triage_tasks SET read_at = ?, settled_at = ?, updated_at = ? WHERE id = ? AND stage_id = ? AND run_state = ? AND updated_at = ? AND read_at IS ? AND settled_at IS ?")
            .run(read ? thread.lastReadAt : null, read ? (task.settledAt ?? now) : null, now, task.id, task.stageId, task.runState, task.updatedAt, task.readAt, task.settledAt);
        }
      }
      const current = db.prepare("SELECT * FROM triage_tasks WHERE id = ?").get(task.id) as TaskRow | undefined;
      return current ? toTask(current) : null;
    }).filter((task): task is NonNullable<typeof task> => task !== null);
    const visibleCards = synchronizedCards.filter((task) => {
      if (!task.threadId) return true;
      const thread = threadsById.get(task.threadId);
      return thread === undefined || thread.archivedAt === null;
    });
    const tasks = await Promise.all(visibleCards.map(async (task) => {
      const thread = task.threadId ? threadsById.get(task.threadId) ?? null : null;
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
      supportedReasoningEfforts: string[];
      defaultReasoningEffort: string;
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

  /** Sessions the knob still wants mirrored; checked before every page and every card. */
  const mirroringWanted = () => autoCardThreads && !disposed;
  let backfilling = false;
  let retryBackfill = false;
  let pendingChildHandlers = 0;
  const childRetries = new Set<NativeRetry>();
  let retryAllAfterChildren = false;
  const deferredSnapshots: { targets: Map<string, ReturnType<typeof captureTarget>>; generation: number }[] = [];

  const startBackfillRetry = () => {
    if (!retryBackfill || pendingChildHandlers > 0 || backfilling || !mirroringWanted()) return;
    retryBackfill = false;
    void runBackfill();
  };

  const trackChildHandler = async (handler: Promise<string | undefined>) => {
    pendingChildHandlers += 1;
    try {
      const rootId = await handler;
      if (rootId) childRetries.add({ threadId: rootId });
    } finally {
      pendingChildHandlers -= 1;
      startBackfillRetry();
      if (pendingChildHandlers === 0 && !disposed) {
        const retries = [...childRetries];
        childRetries.clear();
        for (const snapshot of deferredSnapshots.splice(0)) {
          if (snapshot.generation === mirroringGeneration) void reconcileAll(undefined, snapshot.targets);
        }
        if (retryAllAfterChildren) {
          retryAllAfterChildren = false;
          void reconcileAll();
        } else for (const retry of retries) void reconcileNative(retry.threadId, false, undefined, retry.freshInput, retry.expected, undefined, retry.generation);
      }
    }
  };

  /**
   * The top-level thread above `thread`, found by walking parentThreadId. The
   * visited set ends a walk through a parent cycle at the last thread reached;
   * that thread still has a parent, so it is never mirrorable.
   */
  const topLevelOf = async (thread: RootThread, getThread: (threadId: string) => Promise<RootThread>) => {
    const seen = new Set([thread.id]);
    let current = thread;
    while (current.parentThreadId !== null) {
      if (seen.has(current.parentThreadId)) break;
      seen.add(current.parentThreadId);
      current = await getThread(current.parentThreadId);
    }
    return current;
  };
  /** A threads.get that memoizes per walk; an absent answer is a failed lookup. */
  const parentLookup = () => {
    const pending = new Map<string, Promise<RootThread>>();
    return (threadId: string) =>
      memoize(pending, threadId, async () => {
        const found = await bb.sdk.threads.get({ threadId });
        if (!found) throw new Error(`session ${threadId} was not found`);
        return found;
      });
  };

  /**
   * Top-level threads that are running or have a running descendant, by id.
   * `undefined` when any lookup fails: callers then leave cards unchanged.
   * threads.listRunning returns only threads in `starting` or `active`
   * (SDK bundled-types ThreadsArea.listRunning), so it needs no paging; its ids
   * are resolved with the same batched threads.list calls as snapshot
   * (archived is a selector, so each chunk needs the archived companion call).
   */
  const liveRoots = async () => {
    try {
      const running = await bb.sdk.threads.listRunning();
      const threadIds = [...new Set(running.map((entry) => entry.id))];
      const batches: Promise<ThreadListItem[]>[] = [];
      for (let from = 0; from < threadIds.length; from += THREAD_LIST_BATCH) {
        const chunk = threadIds.slice(from, from + THREAD_LIST_BATCH);
        batches.push(bb.sdk.threads.list({ threadIds: chunk, includeHidden: true, limit: THREAD_LIST_BATCH }));
        batches.push(bb.sdk.threads.list({ threadIds: chunk, archived: true, includeHidden: true, limit: THREAD_LIST_BATCH }));
      }
      const listed = new Map<string, RootThread>();
      for (const batch of await Promise.all(batches)) {
        for (const thread of batch) listed.set(thread.id, thread);
      }
      const lookup = parentLookup();
      const getThread = async (threadId: string) => listed.get(threadId) ?? lookup(threadId);
      const roots = new Map<string, RootThread>();
      for (const threadId of threadIds) {
        // A thread that was deleted since listRunning answered is not listed, and one that stopped is no longer
        // `active` or `starting`: neither is live.
        const thread = listed.get(threadId);
        if (!thread || (thread.status !== "active" && thread.status !== "starting")) continue;
        const root = await topLevelOf(thread, getThread);
        roots.set(root.id, root);
      }
      return roots;
    } catch (error) {
      bb.log.warn(`Triage could not look up running sessions: ${errorMessage(error)}`);
      return undefined;
    }
  };

  // A child event can be waiting for its parent lookup before it touches the card.
  const childEventSeq = new Map<string, number>();
  let childEventCount = 0;
  const stampChildEvent = (threadId: string) => {
    for (const checks of responseChecks.values()) for (const check of checks) if (check.retry) childRetries.add(check.retry);
    childEventSeq.set(threadId, ++childEventCount);
    return childEventCount;
  };

  const reconcileNative = async (threadId: string, settle = false, liveness?: [ReturnType<typeof liveRoots>, () => ReturnType<typeof liveRoots>], freshInput = false, expected?: ReturnType<typeof captureTarget>, initialThread?: RootThread, retryGeneration?: number) => {
    if (disposed) return;
    if (retryGeneration !== undefined && retryGeneration !== mirroringGeneration) return;
    const task = getTaskByThread(threadId);
    if (!task || task.run_state === "stopped" || task.run_state === "queued" || task.run_state === "scheduled" || task.run_state === "dispatching") return;
    if (task.origin === "mirror" && db.prepare("SELECT 1 FROM triage_mirror_tombstones WHERE thread_id = ?").get(threadId) !== undefined) return;
    const retry = { threadId, freshInput, expected: expected ?? captureTarget(task), generation: retryGeneration ?? mirroringGeneration };
    if (pendingChildHandlers > 0) { childRetries.add(retry); return; }
    const childEvents = childEventCount;
    const generation = mirroringGeneration;
    const readGeneration = threadReadGeneration.get(threadId) ?? 0;
    const broadRead = broadReadGeneration;
    const placement = db.prepare("SELECT rowid FROM triage_events WHERE task_id = ? ORDER BY rowid DESC LIMIT 1").get(task.id) as { rowid: number } | undefined;
    if (expected && (!sameReadTarget(expected.row, task) || expected.eventId !== placement?.rowid || expected.readGeneration !== readGeneration || expected.broadReadGeneration !== broadRead)) {
      bb.log.warn(`Triage could not detect session ${threadId}`);
      return;
    }
    const check = { valid: true, retry };
    const checks = responseChecks.get(threadId) ?? new Set();
    checks.add(check);
    responseChecks.set(threadId, checks);
    const wanted = () => {
      const valid = check.valid && !disposed && generation === mirroringGeneration && readGeneration === (threadReadGeneration.get(threadId) ?? 0) && broadRead === broadReadGeneration && childEvents === childEventCount && pendingChildHandlers === 0;
      if (!valid && !disposed) bb.log.warn(`Triage could not detect session ${threadId}`);
      return valid;
    };
    let reading = true;
    try {
      const thread = initialThread ?? await bb.sdk.threads.get({ threadId });
      if (!wanted()) return;
      if (!thread) {
        bb.log.warn(`Triage could not detect session ${threadId}: session ${threadId} was not found`);
        return;
      }
      if (thread.archivedAt !== null || thread.deletedAt !== null || (task.origin === "mirror" && !isMirrorable(thread))) return;
      if (!["active", "starting", "idle", "error"].includes(thread.status)) return;
      const interactions = await bb.sdk.threads.interactions.list({ threadId });
      if (!wanted()) return;
      const live = await (liveness?.[0] ?? liveRoots());
      if (!live || !wanted()) return;
      const latestThread = await bb.sdk.threads.get({ threadId });
      if (!wanted()) return;
      const latestInteractions = await bb.sdk.threads.interactions.list({ threadId });
      if (!wanted()) return;
      const latestLive = await (liveness?.[1]() ?? liveRoots());
      if (!wanted()) return;
      const current = getTaskByThread(threadId);
      const latestPlacement = db.prepare("SELECT rowid FROM triage_events WHERE task_id = ? ORDER BY rowid DESC LIMIT 1").get(task.id) as { rowid: number } | undefined;
      if (!latestThread) {
        bb.log.warn(`Triage could not detect session ${threadId}: session ${threadId} was not found`);
        return;
      }
      if (!current || !sameReadTarget(task, current) || latestPlacement?.rowid !== placement?.rowid || latestThread.archivedAt !== thread.archivedAt || latestThread.deletedAt !== thread.deletedAt || latestThread.visibility !== thread.visibility || latestThread.parentThreadId !== thread.parentThreadId || latestThread.status !== thread.status || latestThread.latestAttentionAt !== thread.latestAttentionAt || latestThread.lastReadAt !== thread.lastReadAt || JSON.stringify(latestInteractions) !== JSON.stringify(interactions) || !latestLive || latestLive.has(threadId) !== live.has(threadId)) {
        bb.log.warn(`Triage could not detect session ${threadId}`);
        return;
      }
      reading = false;
      const pending = interactions.length > 0;
      const working = thread.status === "active" || thread.status === "starting" || live.has(threadId);
      const role = pending ? "attention" : thread.status === "error" ? "active" : working ? "active" : "done";
      const stage = getStageRow(task.stage_id).system_role === null ? task.stage_id : getSystemStage(role).id;
      const failure = db.prepare("SELECT summary FROM triage_events WHERE task_id = ? AND event = 'agent failed' ORDER BY rowid DESC LIMIT 1").get(task.id) as { summary: string | null } | undefined;
      const payload = interactions[0]?.payload;
      const inputReason = payload && ("title" in payload ? payload.title : "questions" in payload ? payload.questions[0]?.prompt : payload.reason);
      const reason = pending ? inputReason || "Waiting for you" : thread.status === "error" ? failure?.summary ?? (task.run_state === "failed" ? task.attention_reason : null) ?? "The assigned BB thread failed." : null;
      const state = pending ? "idle" : thread.status === "error" ? "failed" : working ? "working" : "completed";
      const acknowledgment = db.prepare("SELECT event, created_at FROM triage_events WHERE task_id = ? AND actor = 'user' AND event IN ('marked settled', 'reopened') ORDER BY rowid DESC LIMIT 1").get(task.id) as { event: string; created_at: number } | undefined;
      const inputAfterRead = pending && task.read_at !== null && interactions.some((interaction) => interaction.createdAt > task.read_at!);
      const inputAfterSettlement = pending && task.settled_at !== null && interactions.some((interaction) => interaction.createdAt > task.settled_at!);
      const unacknowledgedHistoryInput = pending && task.origin === "mirror" && task.settled_at === task.created_at && task.read_at === null &&
        interactions.some((interaction) => interaction.createdAt > (thread.lastReadAt ?? 0) &&
          (acknowledgment?.event !== "marked settled" || interaction.createdAt > acknowledgment.created_at));
      const newInput = inputAfterRead || inputAfterSettlement || unacknowledgedHistoryInput || (pending && task.read_at === null && task.settled_at === null && (freshInput || task.attention_reason === null || task.run_state !== "idle"));
      const explicitlySettled = acknowledgment?.event === "marked settled" && acknowledgment.created_at >= (thread.latestAttentionAt ?? 0);
      const explicitlyReopened = acknowledgment?.event === "reopened" && acknowledgment.created_at >= (thread.latestAttentionAt ?? 0);
      const newActivity = state === "working" && !(thread.status === "idle" && explicitlySettled) && (task.run_state !== "working" || (thread.latestAttentionAt ?? 0) > (task.settled_at ?? Infinity));
      const unreadOutput = state === "completed" && !nativeRead(thread) && (thread.latestAttentionAt ?? 0) > (task.read_at ?? 0) && !explicitlySettled;
      const settledAt = settle && !pending && (role === "done" || thread.status === "error") ? Date.now() : inputAfterSettlement || unacknowledgedHistoryInput || newActivity || unreadOutput || (explicitlyReopened && acknowledgment.created_at >= (task.settled_at ?? 0)) ? null : task.settled_at;
      const cardRead = (thread.latestAttentionAt ?? 0) > 0 && (task.read_at ?? 0) >= thread.latestAttentionAt!;
      const completedUnread = state === "completed" && task.run_state !== "completed" && !nativeRead(thread) && !cardRead;
      const readAt = inputAfterRead || newActivity || completedUnread || unreadOutput ? null : state === "completed" && nativeRead(thread) ? thread.lastReadAt : task.read_at;
      const acknowledgedAt = getStageRow(stage).system_role === "done" && state === "completed" && (nativeRead(thread) || cardRead) && !explicitlyReopened ? settledAt ?? Date.now() : settledAt;
      if (stage === task.stage_id && state === task.run_state && reason === task.attention_reason && acknowledgedAt === task.settled_at && readAt === task.read_at) {
        if (settle && acknowledgedAt !== null) addEvent(task.id, "user", "marked settled");
        return;
      }
      const now = Date.now();
      const changed = db.transaction(() => {
        const updated = db.prepare("UPDATE triage_tasks SET stage_id = ?, run_state = ?, attention_reason = ?, read_at = ?, settled_at = ?, updated_at = ? WHERE id = ?")
          .run(stage, state, reason, readAt, acknowledgedAt, now, task.id);
        if (!updated.changes) return false;
        if (pending && thread.status === "error" && task.run_state === "failed" && task.attention_reason && !failure?.summary) addEvent(task.id, "bb", "agent failed", task.attention_reason);
        if (settle && stage !== task.stage_id) addEvent(task.id, "bb", `moved to ${getStageRow(stage).name}`);
        if (state === "completed" && (task.run_state !== "completed" || (role === "done" && stage !== task.stage_id))) addEvent(task.id, "bb", "turn completed");
        if (settle && acknowledgedAt !== null) addEvent(task.id, "user", "marked settled");
        return true;
      })();
      if (!changed) return;
      if (newInput && reason && acknowledgedAt === null) notify({ taskNumber: task.number, action: "Waiting for you", taskTitle: task.title, body: reason, level: "attention" });
      publishSoon();
    } catch (error) {
      if (!reading) throw error;
      if (!disposed) bb.log.warn(`Triage could not detect session ${threadId}: ${errorMessage(error)}`);
    } finally {
      checks.delete(check);
      if (checks.size === 0) responseChecks.delete(threadId);
    }
  };

  const reconcileAll = async (initialLive?: Awaited<ReturnType<typeof liveRoots>>, targets?: Map<string, ReturnType<typeof captureTarget>>, threads?: Map<string, ThreadListItem>) => {
    if (disposed) return;
    if (pendingChildHandlers > 0) {
      if (backfilling) retryBackfill = true;
      else retryAllAfterChildren = true;
      return;
    }
    const rows = (db.prepare("SELECT * FROM triage_tasks WHERE thread_id IS NOT NULL").all() as TaskRow[]).filter((row) => {
      if (targets && !targets.has(row.thread_id!)) return false;
      if (["stopped", "queued", "scheduled", "dispatching"].includes(row.run_state)) return false;
      const thread = threads?.get(row.thread_id!);
      return !thread || (thread.archivedAt === null && thread.deletedAt === null && (row.origin !== "mirror" || isMirrorable(thread)) && ["active", "starting", "idle", "error"].includes(thread.status));
    });
    if (rows.length === 0) return;
    const liveness: [ReturnType<typeof liveRoots>, () => ReturnType<typeof liveRoots>] = [initialLive ? Promise.resolve(initialLive) : liveRoots(), () => liveRoots()];
    for (let start = 0; start < rows.length; start += 8) {
      await Promise.all(rows.slice(start, start + 8).map(({ thread_id }) => reconcileNative(thread_id!, false, liveness, false, targets?.get(thread_id!), threads?.get(thread_id!))));
    }
  };

  const childChanged = async (child: RootThread, create = false) => {
    const stamp = stampChildEvent(child.id);
    try {
      const root = await topLevelOf(child, parentLookup());
      const creating = pendingMirror.get(root.id);
      if (creating) await creating;
      if (disposed || childEventSeq.get(child.id) !== stamp) return;
      if (create && !getTaskByThread(root.id) && shouldMirror(root)) {
        try {
          await ensureCardForThread(root, "mirror");
        } catch (error) {
          bb.log.warn(`Triage could not card session ${root.id}: ${errorMessage(error)}`);
        }
      }
      return root.id;
    } catch (error) {
      bb.log.warn(`Triage could not find the top-level session of ${child.id}: ${errorMessage(error)}`);
    }
  };

  const reconcileMirrorHousekeeping = async (passRows: TaskRow[], targets: Map<string, ReturnType<typeof captureTarget>>) => {
    const cards = passRows.filter((card) => card.origin === "mirror" && card.settled_at === null && card.thread_id !== null);
    if (cards.length === 0) return;
    const generation = mirroringGeneration;
    const childEvents = childEventCount;
    const batches: Promise<ThreadListItem[]>[] = [];
    for (let start = 0; start < cards.length; start += THREAD_LIST_BATCH) {
      const threadIds = cards.slice(start, start + THREAD_LIST_BATCH).map((card) => card.thread_id!);
      batches.push(bb.sdk.threads.list({ threadIds, includeHidden: true, limit: THREAD_LIST_BATCH }));
      batches.push(bb.sdk.threads.list({ threadIds, archived: true, includeHidden: true, limit: THREAD_LIST_BATCH }));
    }
    const found = new Map<string, RootThread>();
    try {
      for (const batch of await Promise.all(batches)) for (const thread of batch) found.set(thread.id, thread);
      await Promise.all(cards.map(async (card) => {
        if (!found.has(card.thread_id!)) {
          try {
            const thread = await bb.sdk.threads.get({ threadId: card.thread_id! });
            if (thread) found.set(card.thread_id!, thread);
          } catch (error) {
            bb.log.warn(`Triage could not confirm session ${card.thread_id}: ${errorMessage(error)}`);
          }
        }
      }));
    } catch (error) {
      bb.log.warn(`Triage could not look up sessions to reconcile: ${errorMessage(error)}`);
      return;
    }
    if (childEvents !== childEventCount || pendingChildHandlers > 0) {
      retryBackfill = true;
      return;
    }
    if (!mirroringWanted() || generation !== mirroringGeneration) return;
    for (const card of cards) {
      const thread = found.get(card.thread_id!);
      const current = getTaskByThread(card.thread_id!);
      if (!thread || !current || !sameReadTarget(card, current) || captureTarget(current).eventId !== targets.get(card.thread_id!)?.eventId) continue;
      if (thread.deletedAt !== null) deleteMirrorCard(card.id);
      else if (thread.archivedAt !== null || !isMirrorable(thread)) {
        db.prepare("UPDATE triage_tasks SET settled_at = ?, run_state = CASE WHEN run_state = 'working' THEN 'idle' ELSE run_state END, updated_at = ? WHERE id = ?")
          .run(Date.now(), Date.now(), card.id);
      }
    }
  };

  /**
   * Give every existing session a mirror card. Pages are collected first, then
   * carded oldest-first so card numbers follow session age. Failures are
   * logged, never thrown: a failed page aborts the pass, a failed session is
   * skipped.
   */
  const runBackfill = async () => {
    if (backfilling) return;
    if (pendingChildHandlers === 0) retryBackfill = false;
    backfilling = true;
    try {
      const caches = newLookupCaches();
      const collected = new Map<string, ThreadListItem>();
      let offset = 0;
      const passGeneration = mirroringGeneration;
      const passWanted = () => mirroringWanted() && passGeneration === mirroringGeneration;
      const passRows = db.prepare("SELECT * FROM triage_tasks").all() as TaskRow[];
      const targets = new Map(passRows.flatMap((row) => row.thread_id ? [[row.thread_id, captureTarget(row)] as const] : []));
      const rememberCreated = (card: TaskRow | undefined) => {
        if (!card?.thread_id || targets.has(card.thread_id)) return;
        const last = db.prepare("SELECT event FROM triage_events WHERE task_id = ? ORDER BY rowid DESC LIMIT 1").get(card.id) as { event: string } | undefined;
        if (last?.event === "backfilled") targets.set(card.thread_id, captureTarget(card));
      };
      let completed = false;
      while (passWanted()) {
        let page: ThreadListItem[];
        try {
          // Quirks from the SDK bundled-types ThreadListArgs doc
          // (bb-plugin-sdk.d.ts:18210-18232): includeHidden is required or hidden
          // sessions (plugin-spawned workers) are left out; archived:false
          // selects the unarchived half. The host may also cap a page below the
          // requested limit, so a short page does not end the pass.
          page = await bb.sdk.threads.list({ archived: false, includeHidden: true, limit: THREAD_LIST_BATCH, offset });
        } catch (error) {
          bb.log.warn(`Triage could not list sessions to card: ${errorMessage(error)}`);
          return;
        }
        // An empty page, or one that repeats rows already seen, ends the pass.
        const fresh = page.filter((listed) => !collected.has(listed.id));
        if (fresh.length === 0) {
          completed = true;
          break;
        }
        for (const listed of fresh) collected.set(listed.id, listed);
        offset += page.length;
      }
      if (!passWanted()) {
        if (mirroringWanted()) retryBackfill = true;
        return;
      }
      // threads.list has no sort parameter, so page order says nothing about
      // age: sort by createdAt here (SDK bundled-types ThreadListArgs lists no
      // ordering option).
      const oldestFirst = [...collected.values()].sort(
        (left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id),
      );
      // Sessions whose mirror card was deleted by hand stay off the board.
      const optedOut = new Set(
        (db.prepare("SELECT thread_id FROM triage_mirror_tombstones").all() as { thread_id: string }[])
          .map((row) => row.thread_id),
      );
      for (const listed of oldestFirst) {
        if (!passWanted()) break;
        if (optedOut.has(listed.id) || !isMirrorable(listed)) continue;
        try {
          rememberCreated(await ensureCardForThread(listed, "mirror", caches, { event: "backfilled", settleIfDormant: true }));
        } catch (error) {
          bb.log.warn(`Triage could not card session ${listed.id}: ${errorMessage(error)}`);
        }
      }
      if (completed && passWanted()) {
        await reconcileMirrorHousekeeping(passRows, targets);
        const childEvents = childEventCount;
        const live = pendingChildHandlers === 0 && passWanted() ? await liveRoots() : undefined;
        if (childEvents !== childEventCount || pendingChildHandlers > 0) retryBackfill = true;
        else if (live && passWanted()) {
          for (const root of live.values()) {
            if (!passWanted()) break;
            if (!shouldMirror(root) || root.archivedAt !== null || root.deletedAt !== null) continue;
            try {
              rememberCreated(await ensureCardForThread(root, "mirror", caches, { event: "backfilled", settleIfDormant: true }));
            } catch (error) {
              bb.log.warn(`Triage could not card session ${root.id}: ${errorMessage(error)}`);
            }
          }
          if (passWanted() && childEvents === childEventCount) await reconcileAll(live, targets);
          else if (passWanted()) retryBackfill = true;
        }
      }
      if (passWanted()) publish();
      else if (mirroringWanted()) retryBackfill = true;
    } finally {
      backfilling = false;
      startBackfillRetry();
    }
  };

  /**
   * Events for sessions the board should mirror: the knob is on, Triage did not
   * spawn them, and nobody deleted their mirror card. A deleted mirror card is
   * an opt-out from mirroring that session (deleteTask writes the tombstone);
   * thread.deleted needs none, because the session is gone and cannot be listed
   * again.
   */
  const shouldMirror = (thread: Pick<CardThread, "id" | "parentThreadId" | "visibility"> & { originPluginId: string | null }) =>
    autoCardThreads && isMirrorable(thread) && thread.originPluginId !== bb.pluginId &&
    db.prepare("SELECT 1 FROM triage_mirror_tombstones WHERE thread_id = ?").get(thread.id) === undefined;

  bb.rpc.register(rpcContract, {
    snapshot: () => snapshot(),
    agentOptions: () => agentOptions(),
    async importThread({ threadId }) {
      const thread = await bb.sdk.threads.get({ threadId });
      if (thread.deletedAt !== null || thread.archivedAt !== null) {
        throw new Error("Open an unarchived session before moving it to Triage");
      }
      // A manual move always wins over an old opt-out from mirroring.
      db.prepare("DELETE FROM triage_mirror_tombstones WHERE thread_id = ?").run(threadId);
      const existing = getTaskByThread(threadId);
      if (existing) {
        // A deliberate move turns a mirror card into a manual one: the user now
        // commits to the session, so it reopens and gets agent tooling.
        if (existing.origin === "mirror") {
          db.prepare(
            "UPDATE triage_tasks SET origin = 'manual', settled_at = NULL, updated_at = ? WHERE id = ?",
          ).run(Date.now(), existing.id);
          addEvent(existing.id, "user", "moved session to triage");
        }
        await setSidebarVisibility(threadId, false);
        await reconcileNative(threadId);
        publish();
        return toTask(getTaskRow(existing.number));
      }
      const execution = await bb.sdk.threads.defaultExecutionOptions({ threadId });
      // The thread was checked above, so the card cannot come back undefined.
      const task = (await ensureCardForThread(thread, "manual", undefined, {
        model: execution?.model ?? "Default model",
      }))!;
      // Persist the card before hiding its session so a failed host update
      // leaves the conversation accessible; retry uses the existing card.
      publish();
      await setSidebarVisibility(threadId, false);
      await reconcileNative(threadId);
      return toTask(getTaskRow(task.number));
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
          scheduled_at, thread_id, run_state, attention_reason, origin, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL, 'manual', ?, ?)`,
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
      moveTask(number, stageId, "user", summary),
    async setTaskSettled({ number, settled }) {
      let task = getTaskRow(number);
      if (settled && task.thread_id && task.run_state !== "stopped") {
        await reconcileNative(task.thread_id, true);
        return toTask(getTaskRow(number));
      }
      const reopenRead = !settled && task.read_at !== null && getStageRow(task.stage_id).system_role === "done";
      if (reopenRead && task.thread_id) {
        await bb.sdk.threads.markUnread({ threadId: task.thread_id });
        const current = getTaskRow(number);
        if (!sameReadTarget(task, current)) return toTask(current);
        task = current;
      }
      const now = Date.now();
      db.prepare(
        "UPDATE triage_tasks SET settled_at = ?, read_at = CASE WHEN ? THEN NULL ELSE read_at END, updated_at = ? WHERE id = ?",
      ).run(settled ? now : null, reopenRead ? 1 : 0, now, task.id);
      addEvent(task.id, "user", settled ? "marked settled" : "reopened");
      publish();
      return toTask(getTaskRow(number));
    },
    async setTaskRead({ number, read }) {
      let task = getTaskRow(number);
      const done = getStageRow(task.stage_id).system_role === "done";
      if (done && task.thread_id) {
        if (read) await bb.sdk.threads.markRead({ threadId: task.thread_id });
        else await bb.sdk.threads.markUnread({ threadId: task.thread_id });
        const current = getTaskRow(number);
        if (!sameReadTarget(task, current)) return toTask(current);
        task = current;
      }
      const now = Date.now();
      if (done) db.prepare("UPDATE triage_tasks SET read_at = ?, settled_at = ?, updated_at = ? WHERE id = ?").run(read ? now : null, read ? now : null, now, task.id);
      else db.prepare("UPDATE triage_tasks SET read_at = ? WHERE id = ?").run(read ? now : null, task.id);
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
        if (task.origin === "mirror" && task.thread_id) {
          db.prepare("INSERT OR REPLACE INTO triage_mirror_tombstones (thread_id, created_at) VALUES (?, ?)")
            .run(task.thread_id, Date.now());
        }
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

  bb.events.on("thread.created", ({ thread }) => {
    invalidateResponseChecks(thread.id);
    if (!shouldMirror(thread)) return;
    // Not awaited: the lookups must not hold up the host's event dispatch.
    // Later events for this thread wait on it through pendingMirror.
    let creation!: Promise<void>;
    creation = (async () => {
      try {
        await ensureCardForThread(thread, "mirror");
        if (pendingMirror.get(thread.id) !== creation) return;
        await reconcileNative(thread.id);
        publishSoon();
      } catch (error) {
        bb.log.warn(`Triage could not card session ${thread.id}: ${errorMessage(error)}`);
      }
    })();
    trackMirror(thread.id, creation);
  });

  bb.events.on("thread.active", async ({ thread }) => {
    invalidateResponseChecks(thread.id);
    const check = { valid: true };
    const checks = responseChecks.get(thread.id) ?? new Set();
    checks.add(check);
    responseChecks.set(thread.id, checks);
    try {
      if (thread.parentThreadId !== null) await trackChildHandler(childChanged(thread, true));
      const creating = pendingMirror.get(thread.id);
      if (creating) await creating;
      if (disposed) return;
      const before = getTaskByThread(thread.id);
      if (before?.origin === "mirror" && (!isMirrorable(thread) || thread.archivedAt !== null || thread.deletedAt !== null)) return;
      await reconcileNative(thread.id);
      if (disposed) return;
      const task = getTaskByThread(thread.id);
      if (check.valid && task?.origin === "mirror" && isMirrorable(thread) && thread.archivedAt === null && thread.deletedAt === null && task.run_state === "working") {
        const machine = await resolveMachine({ type: "reuse", environmentId: thread.environmentId });
        if (!check.valid || disposed) return;
        const current = getTaskByThread(thread.id);
        if (!current || !sameReadTarget(task, current)) return;
        db.prepare("UPDATE triage_tasks SET title = ?, provider_id = ?, machine_id = ?, machine_name = ? WHERE id = ?")
          .run((thread.title || thread.titleFallback || task.title).slice(0, 160), thread.providerId, machine.machineId, machine.machineName, task.id);
        publishSoon();
      }
    } finally {
      checks.delete(check);
      if (checks.size === 0) responseChecks.delete(thread.id);
    }
  });

  bb.events.on("thread.idle", async ({ thread }) => {
    invalidateResponseChecks(thread.id);
    if (thread.parentThreadId !== null) await trackChildHandler(childChanged(thread));
    const creating = pendingMirror.get(thread.id);
    if (creating) await creating;
    if (disposed) return;
    const task = getTaskByThread(thread.id);
    if (!task) return;
    if (task.origin === "mirror" && (!isMirrorable(thread) || thread.archivedAt !== null || thread.deletedAt !== null)) return;
    await reconcileNative(thread.id);
    if (disposed) return;
    if (task.origin === "manual" && task.run_state !== "stopped" && task.run_state !== "completed" && getTaskByThread(thread.id)?.run_state === "completed") {
      notify({ taskNumber: task.number, action: "Update ready", taskTitle: task.title,
        body: "The agent finished its turn. Open the thread to review its update.", level: "info" });
    }
  });

  bb.events.on("thread.failed", async ({ thread, error }) => {
    invalidateResponseChecks(thread.id);
    if (thread.parentThreadId !== null) await trackChildHandler(childChanged(thread));
    const creating = pendingMirror.get(thread.id);
    if (creating) await creating;
    if (disposed) return;
    const task = getTaskByThread(thread.id);
    if (!task || task.run_state === "stopped") return;
    if (task.origin === "mirror" && (!isMirrorable(thread) || thread.archivedAt !== null || thread.deletedAt !== null)) return;
    const reason = error?.trim() || "The assigned BB thread failed.";
    addEvent(task.id, "bb", "agent failed", reason);
    await reconcileNative(thread.id);
  });

  bb.events.on("thread.archived", async ({ thread }) => {
    invalidateResponseChecks(thread.id);
    if (thread.parentThreadId !== null) await trackChildHandler(childChanged(thread));
    const creating = pendingMirror.get(thread.id);
    if (creating) await creating;
    if (disposed) return;
    const task = getTaskByThread(thread.id);
    if (task?.origin === "mirror") {
      db.prepare(
        "UPDATE triage_tasks SET settled_at = ?, run_state = CASE WHEN run_state = 'working' THEN 'idle' ELSE run_state END, updated_at = ? WHERE id = ?",
      ).run(Date.now(), Date.now(), task.id);
      publishSoon();
    }
  });

  bb.events.on("thread.unarchived", async ({ thread }) => {
    invalidateResponseChecks(thread.id);
    const creating = pendingMirror.get(thread.id);
    if (creating) await creating;
    if (disposed) return;
    let task = getTaskByThread(thread.id);
    if (!task && shouldMirror(thread)) {
      const creation = ensureCardForThread(thread, "mirror", undefined, { settleIfDormant: true });
      // Later events wait on a copy that never rejects; this handler still sees the error.
      trackMirror(thread.id, creation.then(() => {}, () => {}));
      task = await creation;
    }
    if (disposed) return;
    if (task?.origin === "mirror" && (!isMirrorable(thread) || thread.archivedAt !== null || thread.deletedAt !== null)) return;
    await reconcileNative(thread.id);
    if (task) publishSoon();
  });

  bb.events.on("thread.deleted", async ({ thread }) => {
    invalidateResponseChecks(thread.id);
    pendingVisibility.delete(thread.id);
    if (thread.parentThreadId !== null) await trackChildHandler(childChanged(thread));
    const creating = pendingMirror.get(thread.id);
    if (creating) await creating;
    if (disposed) return;
    const task = getTaskByThread(thread.id);
    if (!task) return;
    if (task.origin === "mirror") {
      // Mirror metadata goes away with its session; no orphan cards.
      deleteMirrorCard(task.id);
      publish();
      return;
    }
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
          const task = moveTask(number, stage.id, "cli", summary);
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

  // Start after the factory returns so every handler is registered first.
  // Not awaited: the pass pages through every session.
  if (autoCardThreads) void Promise.resolve().then(runBackfill);

  bb.log.info("Triage loaded");
}
