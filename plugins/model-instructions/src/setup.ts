import { existsSync } from "node:fs";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import {
  detectScope,
  type Candidate,
  type Match,
  type SetupProject,
  type SkipReason,
} from "./detect.js";
import { activeScopes } from "./paths.js";
import { pinKey, type ConfigDirPin } from "./profile.js";
import { readProfiles, writeProfilesFile, type ProfileScope } from "./profiles-file.js";

export const ACP_PLUGIN_IDS = ["provider-acp", "bb--provider-acp-next"] as const;

export interface SetupReport {
  outcome: "wrote" | "skipped" | "dry-run";
  reason?: SkipReason;
  candidate?: Candidate;
  matches: Match[];
  profileSource?: string;
  affectedThreads: string[];
}

export interface SetupDeps {
  home: string;
  /** `~/.bb/model-instructions/profiles.json`. */
  profilesFile: string;
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
  kv: Pick<BbPluginApi["storage"]["kv"], "get" | "list">;
  log: Pick<BbPluginApi["log"], "debug" | "info" | "warn">;
  /** Re-reads profiles.json into the running plugin, so the new scope applies at once. */
  reload(): void;
}

export class SetupError extends Error {}

/** Writes profiles.json with one scope, only when no file is there. Throws SetupError on any other failure. */
export function writeProfilesCandidate(
  target: string,
  candidate: Candidate,
  home: string,
): "wrote" | "exists" {
  try {
    return writeProfilesFile(target, [candidate], home);
  } catch {
    throw new SetupError("could not write profiles.json");
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
    deps.log.debug("setup: settings of an ACP provider plugin are not readable");
    return null;
  }
}

async function listProjects(deps: SetupDeps): Promise<ReadonlyArray<SetupProject>> {
  try {
    return await deps.sdk.projects.list({ includePersonal: true });
  } catch {
    deps.log.warn("setup: project list unavailable");
    throw new SetupError("could not list projects");
  }
}

async function affectedThreadsOf(
  deps: SetupDeps,
  scope: ProfileScope,
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

async function detectAndWrite(
  deps: SetupDeps,
  dryRun: boolean,
): Promise<SetupReport> {
  const fileExists = existsSync(deps.profilesFile);
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
  if (writeProfilesCandidate(deps.profilesFile, detection.candidate, deps.home) === "exists")
    return {
      outcome: "skipped",
      reason: "exists",
      matches: [],
      affectedThreads: [],
    };
  let written: ProfileScope | undefined;
  try {
    deps.reload();
    const state = readProfiles(deps.profilesFile, deps.home);
    written =
      state.state === "valid"
        ? state.scopes.find((scope) => scope.name === detection.candidate.name)
        : undefined;
  } catch {
    throw new SetupError(
      "profiles.json was written but could not be reloaded; run `bb plugin reload model-instructions`",
    );
  }
  return {
    outcome: "wrote",
    ...found,
    affectedThreads: written
      ? await affectedThreadsOf(deps, written, projects)
      : [],
  };
}

export async function runSetup(
  deps: SetupDeps,
  options: { dryRun: boolean },
): Promise<SetupReport> {
  const report = await detectAndWrite(deps, options.dryRun);
  if (report.outcome === "wrote") deps.log.info("setup: wrote profiles.json");
  else if (report.outcome === "skipped")
    deps.log.info(`setup: skipped (${report.reason})`);
  return report;
}

const SKIP_HINTS: Record<SkipReason, string> = {
  exists: "profiles.json already exists; setup only creates a missing file",
  "no-profile":
    "no ACP custom agent sets env.CLAUDE_CONFIG_DIR to a separate profile directory",
  "ambiguous-profiles":
    "more than one distinct CLAUDE_CONFIG_DIR profile found; write profiles.json by hand or remove the extra CLAUDE_CONFIG_DIR",
  "no-self-hosted-marketplace":
    "the profile has no git marketplace on a self-hosted host that the default profile lacks",
  "no-project-match":
    "no bb project with a local checkout has a remote on a self-hosted marketplace host and group",
  "no-common-parent":
    "the matching checkouts do not share one parent directory, or it is your home directory or a parent of it",
  "parent-has-non-work-entries":
    "the parent directory holds an entry that is not a git checkout of a work remote",
};

export function formatReport(report: SetupReport, profilesFile: string): string {
  const lines: string[] = [];
  if (report.outcome === "skipped") {
    lines.push(`setup: skipped (${report.reason})`, `  ${SKIP_HINTS[report.reason!]}`);
  } else if (report.outcome === "dry-run") {
    lines.push("setup (dry run): would write", `  ${profilesFile}`);
    if (report.reason) lines.push(`would skip: ${report.reason}`);
  } else {
    lines.push(`setup: wrote ${profilesFile}`);
  }
  if (report.profileSource) lines.push(`profile from: ${report.profileSource}`);
  const c = report.candidate;
  if (c)
    lines.push(
      "scope:",
      `  name: ${c.name}`,
      `  paths: ${c.paths.join(", ")}`,
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
      lines.push(`  ${id}  -> bb model-instructions unpin ${id}`);
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
      stderr: "usage: bb model-instructions setup [--dry-run] [--json]\n",
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
      : formatReport(report, deps.profilesFile),
  };
}
