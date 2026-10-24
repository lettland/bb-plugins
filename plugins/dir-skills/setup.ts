import { existsSync, linkSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { pinKey, type ConfigDirPin } from "./profile";
import {
  detectScope,
  type Candidate,
  type Match,
  type SetupProject,
  type SkipReason,
} from "./detect";
import { activeScopes, parseScopes, type Scope } from "./scopes";

export const ACP_PLUGIN_IDS = ["provider-acp", "bb--provider-acp-next"] as const;
export const SETUP_RECORD_KEY = "auto-setup";

export interface SetupReport {
  outcome: "wrote" | "skipped" | "dry-run";
  reason?: SkipReason;
  candidate?: Candidate;
  matches: Match[];
  profileSource?: string;
  affectedThreads: string[];
}

export interface SetupRecord {
  outcome: "wrote" | "skipped";
  reason?: SkipReason;
}

export interface SetupDeps {
  home: string;
  userFile: string;
  sdk: {
    plugins: {
      getSettings(args: {
        pluginId: string;
      }): Promise<{ values: Record<string, unknown> }>;
    };
    projects: {
      list(args: {
        includePersonal: boolean;
      }): Promise<ReadonlyArray<SetupProject>>;
    };
    threads: { get(args: { threadId: string }): Promise<{ projectId: string }> };
  };
  kv: Pick<BbPluginApi["storage"]["kv"], "get" | "set" | "list">;
  log: Pick<BbPluginApi["log"], "debug" | "info" | "warn">;
  reload(): void;
}

export class SetupError extends Error {}


export function writeScopesFile(
  target: string,
  candidate: Candidate,
  home: string,
): "wrote" | "exists" {
  const dir = path.dirname(target);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const temp = path.join(dir, `.scopes-${randomBytes(8).toString("hex")}.tmp`);
  try {
    writeFileSync(temp, JSON.stringify({ scopes: [candidate] }, null, 2) + "\n", {
      flag: "wx",
      mode: 0o600,
    });
    parseScopes(temp, home);
    try {
      linkSync(temp, target);
      return "wrote";
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return "exists";
      throw new SetupError("could not write scopes.json");
    }
  } catch (error) {
    throw error instanceof SetupError
      ? error
      : new SetupError("could not write scopes.json");
  } finally {
    rmSync(temp, { force: true });
  }
}

async function readCustomAgents(
  deps: SetupDeps,
  pluginId: string,
): Promise<string | null> {
  try {
    const { values } = await deps.sdk.plugins.getSettings({ pluginId });
    return typeof values.customAgents === "string" ? values.customAgents : null;
  } catch {
    deps.log.debug("auto-setup: settings of an ACP provider plugin are not readable");
    return null;
  }
}

async function listProjects(deps: SetupDeps): Promise<ReadonlyArray<SetupProject>> {
  try {
    return await deps.sdk.projects.list({ includePersonal: true });
  } catch {
    deps.log.warn("auto-setup: project list unavailable");
    throw new SetupError("could not list projects");
  }
}

async function affectedThreadsOf(
  deps: SetupDeps,
  scope: Scope,
  projects: ReadonlyArray<SetupProject>,
): Promise<string[]> {
  const sources = new Map(
    projects.map((project) => [
      project.id,
      (project.sources ?? []).flatMap((s) => (s.path ? [s.path] : [])),
    ]),
  );
  const prefix = pinKey("");
  const affected: string[] = [];
  for (const key of await deps.kv.list(prefix)) {
    const pin = await deps.kv.get<ConfigDirPin>(key);
    if (!pin || pin.dir !== null) continue;
    const threadId = key.slice(prefix.length);
    const projectId = await deps.sdk.threads.get({ threadId }).then(
      (thread) => thread.projectId,
      () => null,
    );
    const paths = projectId === null ? undefined : sources.get(projectId);
    if (paths && activeScopes([scope], paths).length > 0)
      affected.push(threadId);
  }
  return affected.sort();
}

async function record(deps: SetupDeps, report: SetupReport): Promise<void> {
  if (report.outcome === "dry-run") return;
  if (report.reason === "exists" && (await deps.kv.get(SETUP_RECORD_KEY)))
    return;
  await deps.kv.set(SETUP_RECORD_KEY, {
    outcome: report.outcome,
    ...(report.reason ? { reason: report.reason } : {}),
  } satisfies SetupRecord);
}

async function detectAndWrite(
  deps: SetupDeps,
  dryRun: boolean,
): Promise<SetupReport> {
  const fileExists = existsSync(deps.userFile);
  if (fileExists && !dryRun)
    return {
      outcome: "skipped",
      reason: "exists",
      matches: [],
      affectedThreads: [],
    };
  const customAgents = await Promise.all(
    ACP_PLUGIN_IDS.map(async (source) => ({
      source,
      value: await readCustomAgents(deps, source),
    })),
  );
  const projects = await listProjects(deps);
  const detection = detectScope({ home: deps.home, customAgents, projects });
  if (!detection.ok)
    return {
      outcome: "skipped",
      reason: detection.reason,
      matches: detection.matches,
      ...(detection.profileSource
        ? { profileSource: detection.profileSource }
        : {}),
      affectedThreads: [],
    };
  const found = {
    candidate: detection.candidate,
    matches: detection.matches,
    profileSource: detection.profileSource,
  };
  if (dryRun)
    return {
      outcome: "dry-run",
      ...(fileExists ? { reason: "exists" as const } : {}),
      ...found,
      affectedThreads: [],
    };
  if (writeScopesFile(deps.userFile, detection.candidate, deps.home) === "exists")
    return {
      outcome: "skipped",
      reason: "exists",
      matches: [],
      affectedThreads: [],
    };
  let written: Scope | undefined;
  try {
    deps.reload();
    written = parseScopes(deps.userFile, deps.home).find(
      (scope) => scope.name === detection.candidate.name,
    );
  } catch {
    throw new SetupError(
      "scopes.json was written but could not be reloaded; run `bb plugin reload dir-skills`",
    );
  }
  return {
    outcome: "wrote",
    ...found,
    // v8 ignore start -- @preserve written is never undefined here: the file was just written from the candidate, so the reload always finds it.
    affectedThreads: written
      ? await affectedThreadsOf(deps, written, projects)
      : [],
    // v8 ignore stop -- @preserve
  };
}

export async function runSetup(
  deps: SetupDeps,
  options: { dryRun: boolean },
): Promise<SetupReport> {
  const report = await detectAndWrite(deps, options.dryRun);
  if (report.outcome === "wrote") deps.log.info("auto-setup: wrote scopes.json");
  else if (report.outcome === "skipped")
    deps.log.info(`auto-setup: skipped (${report.reason})`);
  await record(deps, report);
  return report;
}

const SKIP_HINTS: Record<SkipReason, string> = {
  exists: "scopes.json already exists; setup only creates a missing file",
  "no-profile":
    "no ACP custom agent sets env.CLAUDE_CONFIG_DIR to a separate profile directory",
  "ambiguous-profiles":
    "more than one distinct CLAUDE_CONFIG_DIR profile found; write scopes.json by hand or remove the extra CLAUDE_CONFIG_DIR",
  "no-self-hosted-marketplace":
    "the profile has no git marketplace on a self-hosted host that the default profile lacks",
  "no-project-match":
    "no bb project with a local checkout has a remote on a self-hosted marketplace host and group",
  "no-common-parent":
    "the matching checkouts do not share one parent directory, or it is your home directory or a parent of it",
  "parent-has-non-work-entries":
    "the parent directory holds an entry that is not a git checkout of a work remote",
};

export function formatReport(report: SetupReport, userFile: string): string {
  const lines: string[] = [];
  if (report.outcome === "skipped") {
    lines.push(`setup: skipped (${report.reason})`, `  ${SKIP_HINTS[report.reason!]}`);
  } else if (report.outcome === "dry-run") {
    lines.push("setup (dry run): would write", `  ${userFile}`);
    if (report.reason) lines.push(`would skip: ${report.reason}`);
  } else {
    lines.push(`setup: wrote ${userFile}`);
  }
  if (report.profileSource) lines.push(`profile from: ${report.profileSource}`);
  const c = report.candidate;
  if (c)
    lines.push(
      "scope:",
      `  name: ${c.name}`,
      `  paths: ${c.paths.join(", ")}`,
      `  skills: ${c.skills.join(", ")}`,
      `  claudeConfigDir: ${c.claudeConfigDir}`,
    );
  if (report.matches.length > 0) {
    lines.push("matched projects:");
    for (const m of report.matches)
      lines.push(`  ${m.projectId}  ${m.path}  (${m.key})`);
  }
  if (report.affectedThreads.length > 0) {
    lines.push("threads pinned to the default profile that this scope now covers:");
    for (const id of report.affectedThreads)
      lines.push(`  ${id}  -> bb dir-skills unpin ${id}`);
  }
  return lines.join("\n") + "\n";
}

export function setupExitCode(report: SetupReport): number {
  return report.outcome === "skipped" ? 2 : 0;
}

export async function setupCommand(
  deps: SetupDeps,
  flags: string[],
  json: boolean,
): Promise<{ exitCode: number; stdout?: string; stderr?: string }> {
  const unknown = flags.find((flag) => flag !== "--dry-run");
  if (unknown !== undefined)
    return {
      exitCode: 2,
      stderr: "usage: bb dir-skills setup [--dry-run] [--json]\n",
    };
  let report: SetupReport;
  try {
    report = await runSetup(deps, { dryRun: flags.includes("--dry-run") });
  } catch (error) {
    return {
      exitCode: 1,
      stderr: `setup: ${error instanceof SetupError ? error.message : "failed"}\n`,
    };
  }
  return {
    exitCode: setupExitCode(report),
    stdout: json
      ? JSON.stringify(report, null, 2) + "\n"
      : formatReport(report, deps.userFile),
  };
}

export function autoSetupLine(entry: SetupRecord | undefined): string | null {
  if (!entry) return null;
  return entry.outcome === "wrote"
    ? "auto-setup: wrote"
    : `auto-setup: skipped (${entry.reason})`;
}

export async function autoSetup(deps: SetupDeps): Promise<void> {
  try {
    await runSetup(deps, { dryRun: false });
  } catch (error) {
    deps.log.warn(
      `auto-setup: ${error instanceof SetupError ? error.message : "failed"}`,
    );
  }
}
