import { statSync } from "node:fs";
import type {
  BbPluginApi,
  ExperimentalPluginProviderEnvContext,
  ExperimentalPluginProviderEnvEntry,
} from "@get-bb/plugin-sdk";
import { configDirFor, type Scope } from "./scopes";

export interface ProjectSource {
  path: string;
  hostId: string | null;
}

/** What a thread was started with; fixed at its first resolution. */
export interface ConfigDirPin {
  dir: string | null;
  scope: string | null;
  /** Why a null pin is the default profile when a scope would have set one. */
  reason?: "unknown-project" | "missing-dir";
}

export interface PinDecision {
  pin: ConfigDirPin;
  /** unknown: project not resolved; none: no scope sets a dir; profile: a scope's dir applies; missing-dir: the chosen dir is not a directory. */
  status: "unknown" | "none" | "profile" | "missing-dir";
  /** The dir and scope that were chosen but unusable (missing-dir only). */
  configured?: { dir: string; scope: string };
  conflict: string[];
  warnings: string[];
}

/** What the Claude profile logic needs from the plugin. */
export interface ClaudeProfileDeps {
  scopes: Scope[];
  log: Pick<BbPluginApi["log"], "debug" | "warn">;
  kv: Pick<BbPluginApi["storage"]["kv"], "get" | "set" | "delete">;
  isDir(p: string): boolean;
  /** A project's checkout sources; refreshes the cache once (time-capped) when it is unknown. */
  sourcesFor(projectId: string): Promise<ProjectSource[] | undefined>;
}

export const PROJECT_LOOKUP_TIMEOUT_MS = 3_000;
const CONFIG_DIR_ENV = "CLAUDE_CONFIG_DIR";

export function pinKey(threadId: string): string {
  return `claude-config-dir:${threadId}`;
}

export function isDirectory(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

export function warnMissingConfigDirs(
  scopes: Scope[],
  log: Pick<BbPluginApi["log"], "warn">,
): void {
  for (const scope of scopes) {
    if (scope.claudeConfigDir && !isDirectory(scope.claudeConfigDir)) {
      log.warn(
        `scope "${scope.name}" claudeConfigDir ${scope.claudeConfigDir} is not a directory; threads there start with the default profile`,
      );
    }
  }
}

export async function withTimeout(
  task: Promise<void>,
  ms: number,
): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
  });
  try {
    await Promise.race([task, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function pinEntries(pin: ConfigDirPin): ExperimentalPluginProviderEnvEntry[] {
  if (!pin.dir) return [];
  return [
    {
      name: CONFIG_DIR_ENV,
      value: pin.dir,
      reason: `dir-skills scope "${pin.scope}"`,
    },
  ];
}

/**
 * The pin a project's checkouts select. Shared by the env resolver and
 * `check`. `hostId` null means every host's checkouts count.
 */
export function decidePin(
  scopes: Scope[],
  sources: ProjectSource[] | undefined,
  hostId: string | null,
  isDir: (p: string) => boolean,
): PinDecision {
  const none: ConfigDirPin = { dir: null, scope: null };
  if (!sources)
    return {
      pin: { ...none, reason: "unknown-project" },
      status: "unknown",
      conflict: [],
      warnings: [],
    };
  const paths = sources
    .filter((source) => hostId === null || source.hostId === hostId)
    .map((source) => source.path);
  const choice = configDirFor(scopes, paths);
  const warnings: string[] = [];
  if (choice.conflict.length > 0) {
    warnings.push(
      `project matches scopes with different claudeConfigDir: ${[choice.scope, ...choice.conflict].join(", ")}; using "${choice.scope}"`,
    );
  }
  if (!choice.dir || !choice.scope)
    return { pin: none, status: "none", conflict: choice.conflict, warnings };
  if (!isDir(choice.dir)) {
    warnings.push(
      `scope "${choice.scope}" claudeConfigDir ${choice.dir} is not a directory; starting with default profile`,
    );
    return {
      pin: { ...none, reason: "missing-dir" },
      status: "missing-dir",
      configured: { dir: choice.dir, scope: choice.scope },
      conflict: choice.conflict,
      warnings,
    };
  }
  return {
    pin: { dir: choice.dir, scope: choice.scope },
    status: "profile",
    conflict: choice.conflict,
    warnings,
  };
}

export async function resolveClaudeEnv(
  deps: ClaudeProfileDeps,
  ctx: ExperimentalPluginProviderEnvContext,
): Promise<ExperimentalPluginProviderEnvEntry[]> {
  const { log, kv } = deps;
  if (ctx.threadId === null) {
    // A provider process serving no thread (e.g. a model catalog listing):
    // resolve from the scopes alone; there is no thread to pin for.
    const sources =
      ctx.projectId !== null
        ? await deps.sourcesFor(ctx.projectId)
        : undefined;
    const decision = decidePin(deps.scopes, sources, ctx.hostId, deps.isDir);
    for (const warning of decision.warnings)
      log.warn(`project ${ctx.projectId ?? "none"} provider process without a thread: ${warning}`);
    log.debug(
      `env thread=null project=${ctx.projectId} host=${ctx.hostId} provider process without a thread, no pin -> ${decision.pin.dir ?? "default profile"}`,
    );
    return pinEntries(decision.pin);
  }
  const key = pinKey(ctx.threadId);
  const pinned = await kv.get<ConfigDirPin>(key);
  if (pinned) {
    if (pinned.dir && !deps.isDir(pinned.dir)) {
      // Fail closed: the thread must not silently fall back to the personal login.
      log.warn(
        `thread ${ctx.threadId} is pinned to ${pinned.dir}, which is not a directory now; still passing it, Claude will start a fresh profile there`,
      );
    }
    log.debug(
      `env thread=${ctx.threadId} project=${ctx.projectId} pinned -> ${pinned.dir ?? "default profile"}`,
    );
    return pinEntries(pinned);
  }
  const sources =
    ctx.projectId !== null ? await deps.sourcesFor(ctx.projectId) : undefined;
  const decision = decidePin(deps.scopes, sources, ctx.hostId, deps.isDir);
  if (decision.status === "unknown") {
    log.warn(
      `project ${ctx.projectId ?? "none"} not resolved; thread ${ctx.threadId} starts with default profile for good - run \`bb dir-skills unpin ${ctx.threadId}\` to re-resolve`,
    );
  }
  for (const warning of decision.warnings)
    log.warn(`project ${ctx.projectId ?? "none"} thread ${ctx.threadId}: ${warning}`);
  await kv.set(key, decision.pin);
  log.debug(
    `env thread=${ctx.threadId} project=${ctx.projectId} host=${ctx.hostId} -> ${decision.pin.dir ?? "default profile"}`,
  );
  return pinEntries(decision.pin);
}

/** What `check` reports: the decision for a project (all hosts) and the current thread's pin. */
export async function checkClaudeProfile(
  deps: ClaudeProfileDeps,
  projectId: string | null,
  threadId: string | undefined,
): Promise<{ decision: PinDecision | null; pinned: ConfigDirPin | null }> {
  const decision = projectId
    ? decidePin(
        deps.scopes,
        await deps.sourcesFor(projectId),
        null,
        deps.isDir,
      )
    : null;
  const pinned = threadId
    ? ((await deps.kv.get<ConfigDirPin>(pinKey(threadId))) ?? null)
    : null;
  return { decision, pinned };
}

/* v8 ignore start -- @preserve exhaustive-switch guard: TypeScript narrows the default case's status to never, so this can only run if a new status is added without its case. */
function assertNever(value: never): never {
  throw new Error(`unexpected status ${String(value)}`);
}
/* v8 ignore stop -- @preserve */

const REASON_TEXT = {
  "unknown-project": "project not resolved",
  "missing-dir": "configured directory is not a directory",
} as const;

const UNPIN_HINT = (id: string) =>
  `run \`bb dir-skills unpin ${id}\` to re-resolve`;

export function claudeProfileLines(
  decision: PinDecision | null,
  pinned: ConfigDirPin | null,
  threadId: string | undefined,
): string[] {
  const lines: string[] = [];
  if (!decision) lines.push("Claude profile: needs --project");
  else {
    let what: string;
    let hint = false;
    switch (decision.status) {
      case "profile":
        what = `${decision.pin.dir}  (scope ${decision.pin.scope})`;
        break;
      case "none":
        what = "none";
        break;
      case "unknown":
        what = "unknown project";
        hint = true;
        break;
      case "missing-dir":
        what = `none (scope ${decision.configured?.scope} sets ${decision.configured?.dir}, which is not a directory)`;
        hint = true;
        break;
      /* v8 ignore next 2 -- @preserve exhaustive-switch guard: see assertNever above. */
      default:
        return assertNever(decision.status);
    }
    lines.push(`Claude profile (by project checkout, all hosts): ${what}`);
    if (hint) lines.push(`  ${UNPIN_HINT("<thread-id>")}`);
    if (decision.conflict.length > 0)
      lines.push(`  conflicts with scope(s): ${decision.conflict.join(", ")}`);
  }
  if (threadId) {
    const state = !pinned
      ? "not pinned yet"
      : (pinned.dir ??
        `none (default profile${pinned.reason ? `: ${REASON_TEXT[pinned.reason]}; ${UNPIN_HINT(threadId)}` : ""})`);
    lines.push(`Claude profile pinned for thread ${threadId}: ${state}`);
  }
  return lines;
}

/** Recovery: forget a thread's pinned profile (default: the current thread) so its next turn resolves afresh. */
export async function unpinThread(
  kv: Pick<BbPluginApi["storage"]["kv"], "get" | "delete">,
  explicitId: string | undefined,
  currentThreadId: string | undefined,
): Promise<{ exitCode: number; stdout?: string; stderr?: string }> {
  if (explicitId?.startsWith("-"))
    return {
      exitCode: 2,
      stderr: "usage: bb dir-skills unpin [<thread-id>]\n",
    };
  const threadId = explicitId ?? currentThreadId;
  if (!threadId)
    return {
      exitCode: 2,
      stderr: "unpin: give a thread id, or run from inside a bb thread\n",
    };
  const pinned = await kv.get<ConfigDirPin>(pinKey(threadId));
  if (!pinned) return { exitCode: 0, stdout: `thread ${threadId}: no pin\n` };
  await kv.delete(pinKey(threadId));
  return {
    exitCode: 0,
    stdout:
      `thread ${threadId}: removed pin (${pinned.dir ? `${pinned.dir}, scope ${pinned.scope}` : "default profile"})\n` +
      "note: the thread's earlier Claude session stays in its previous profile; the next turn may start without it\n",
  };
}
