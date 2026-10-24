// Shared fixtures and fakes for the components/triage suites.
import { vi } from "vitest";
import type { ComponentType } from "react";

import type {
  NewThreadRequest,
  PluginRealtimeConnectionState,
} from "@get-bb/plugin-sdk/app";
import type { TriageRpc } from "@/lib/triage-store";
import type {
  AgentOptions,
  Snapshot,
  Stage,
  Task,
  TriageNotification,
} from "@/lib/triage-types";

export function makeStage(overrides: Partial<Stage> = {}): Stage {
  return {
    id: "stage-1",
    name: "In box",
    position: 0,
    systemRole: "intake",
    ...overrides,
  };
}

export function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-1",
    number: 1,
    title: "Fix the login flow",
    description: "Sessions expire early.",
    stageId: "stage-1",
    projectId: "proj-1",
    projectName: "synthetic-project",
    machineId: "machine-1",
    machineName: "synthetic-box",
    branchName: "synthetic/branch",
    providerId: "claude-code",
    model: "test-model-large",
    reasoningLevel: "medium",
    request: null,
    scheduledAt: null,
    threadId: null,
    sidebarVisible: null,
    runState: "idle",
    attentionReason: null,
    readAt: null,
    settledAt: null,
    createdAt: Date.now() - 86_400_000,
    updatedAt: Date.now() - 3_600_000,
    ...overrides,
  };
}

export function makeNotification(
  overrides: Partial<TriageNotification> = {},
): TriageNotification {
  return {
    id: "note-1",
    taskNumber: 1,
    action: "Needs attention",
    taskTitle: "Fix the login flow",
    title: "Triage #1",
    body: "The agent is waiting for you.",
    level: "attention",
    readAt: null,
    createdAt: Date.now() - 60_000,
    ...overrides,
  };
}

export function makeSnapshot(overrides: Partial<Snapshot> = {}): Snapshot {
  return {
    stages: [
      makeStage(),
      makeStage({ id: "stage-2", name: "In progress", position: 1, systemRole: "active" }),
    ],
    tasks: [makeTask()],
    projects: [],
    machines: [],
    notifications: [],
    unreadCount: 0,
    ...overrides,
  };
}

export const agentOptions: AgentOptions = {
  providers: [{ id: "claude-code", name: "Claude Code", available: true }],
  models: [
    {
      id: "model-1",
      providerId: "claude-code",
      model: "test-model-large",
      displayName: "Test model",
      description: "Synthetic model entry",
      supportedReasoningEfforts: ["none", "medium", "high"],
      defaultReasoningEffort: "medium",
    },
  ],
};

/** Fake plugin RPC: route by method name, defaulting to a harmless result. */
export type FakeRpc = TriageRpc & { call: ReturnType<typeof vi.fn> };

const defaultResults: Record<string, (args: unknown) => unknown> = {
  snapshot: () => makeSnapshot(),
  agentOptions: () => agentOptions,
  createTask: () => ({ number: 7 }),
};

/** Fake plugin RPC: route by method name, defaulting to a harmless result. */
export function createFakeRpc(
  handlers: Record<string, (args: unknown) => unknown> = {},
): FakeRpc {
  const call = vi.fn(async (method: string, args?: unknown) => {
    const handler = handlers[method] ?? defaultResults[method];
    return handler ? handler(args) : { ok: true };
  });
  return { call } as FakeRpc;
}

/** Deferred promise the tests resolve or reject by hand. */
export function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Mutable knobs the SDK app mock reads, reset between tests. */
export const sdk = {
  rpc: createFakeRpc(),
  settingsValues: undefined as Record<string, string | number | boolean> | undefined,
  settingsLoading: false,
  connection: "connected" as PluginRealtimeConnectionState,
  navigate: {
    toThread: vi.fn(),
    toProject: vi.fn(),
    toPluginPanel: vi.fn(),
    toCompose: vi.fn(),
    openThreadPanel: vi.fn(() => false),
    openUrl: vi.fn(() => false),
    experimental_openFilePreview: vi.fn(() => false),
    experimental_openFileExternally: vi.fn(() => false),
  },
  sidebarThreads: {
    open: vi.fn(),
    openNewThread: vi.fn(),
    setPinned: vi.fn(async () => {}),
    setRead: vi.fn(async () => {}),
    rename: vi.fn(async () => {}),
    archive: vi.fn(),
    requestDelete: vi.fn(),
  },
  realtimeHandlers: [] as Array<(payload: unknown) => void>,
  composerProps: [] as Array<Record<string, unknown>>,
  composerRequest: null as NewThreadRequest | null,
  composerSubmitDisabled: false,
  composerRenderSubmitButton: true,
  composerPrompt: "",
};

/** Sonner stand-in shared by every suite that asserts toasts. */
export const toasts = { success: vi.fn(), error: vi.fn() };

export function createSonnerMock(): Record<string, unknown> {
  return { toast: toasts };
}

export function resetToasts(): void {
  toasts.success.mockClear();
  toasts.error.mockClear();
}

export function resetSdk(): void {
  sdk.rpc = createFakeRpc();
  sdk.settingsValues = undefined;
  sdk.settingsLoading = false;
  sdk.connection = "connected";
  resetToasts();
  for (const fn of Object.values(sdk.navigate)) fn.mockClear();
  for (const fn of Object.values(sdk.sidebarThreads)) fn.mockClear();
  sdk.realtimeHandlers = [];
  sdk.composerProps = [];
  sdk.composerRequest = null;
  sdk.composerSubmitDisabled = false;
  sdk.composerRenderSubmitButton = true;
  sdk.composerPrompt = "";
}

/** Minimal stand-in for the host's new-thread composer. */
function ComposerStub(props: Record<string, unknown>) {
  sdk.composerProps.push(props);
  const onSubmit = props.onSubmit as (request: NewThreadRequest) => Promise<void> | void;
  const doSubmit = () => {
    Promise.resolve(sdk.composerRequest ?? buildRequest())
      .then((request) => onSubmit(request as NewThreadRequest))
      .catch(() => {});
  };
  return (
    <div data-testid="composer-stub">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          doSubmit();
        }}
      >
        <textarea
          aria-label="Prompt"
          defaultValue={(props.initialPrompt as string | undefined) ?? ""}
          onChange={(event) => {
            sdk.composerPrompt = event.target.value;
          }}
        />
        {sdk.composerRenderSubmitButton ? (
          // jsdom never fires submit from a button click, so the host-style
          // programmatic click goes straight through the handler here too.
          <button
            type="submit"
            disabled={sdk.composerSubmitDisabled}
            onClick={doSubmit}
          >
            Submit composer
          </button>
        ) : null}
      </form>
    </div>
  );
}

/** The request the stub composer submits; tests override fields per case. */
export function buildRequest(
  overrides: Partial<NewThreadRequest> & { input?: NewThreadRequest["input"] } = {},
): NewThreadRequest {
  return {
    projectId: "proj-1",
    providerId: "claude-code",
    model: "test-model-large",
    reasoningLevel: "medium",
    permissionMode: "auto",
    executionInputSources: {},
    environment: { type: "project-default" },
    input: [{ type: "text", mentions: [], text: "Sessions expire early." }],
    ...overrides,
  };
}

/** Module the test files hand to vi.mock("@get-bb/plugin-sdk/app"). */
export function createSdkAppMock(): Record<string, unknown> {
  return {
    useRpc: () => sdk.rpc,
    useSettings: () => ({ values: sdk.settingsValues, isLoading: sdk.settingsLoading }),
    useRealtimeConnectionState: () => sdk.connection,
    useBbNavigate: () => sdk.navigate,
    experimental_useSidebarThreadActions: () => sdk.sidebarThreads,
    useRealtime: (_channel: string, handler: (payload: unknown) => void) => {
      sdk.realtimeHandlers.push(handler);
    },
    experimental_NewThreadComposer:
      ComposerStub as ComponentType<Record<string, unknown>>,
  };
}
