import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  BbPluginApi,
  ExperimentalPluginProviderEnvContext,
  ExperimentalPluginProviderEnvEntry,
} from "@get-bb/plugin-sdk";
import {
  configDirFor,
  loadScopes,
  normalizeDir,
  selectSkills,
  type ConfigDirChoice,
  type Scope,
  type SkillInfo,
} from "./scopes";

interface ProjectSource {
  path: string;
  hostId: string | null;
}

/** What a thread was started with; fixed at its first resolution. */
interface ConfigDirPin {
  dir: string | null;
  scope: string | null;
}

/** What the Claude profile logic needs from the plugin. */
interface ClaudeProfileDeps {
  scopes: Scope[];
  log: BbPluginApi["log"];
  kv: BbPluginApi["storage"]["kv"];
  /** A project's checkout sources; refreshes the cache once (time-capped) when it is unknown. */
  sourcesFor(projectId: string): Promise<ProjectSource[] | undefined>;
}

const PROJECT_REFRESH_MS = 60_000;
const PROJECT_LOOKUP_TIMEOUT_MS = 3_000;
const CONFIG_DIR_ENV = "CLAUDE_CONFIG_DIR";

function pinKey(threadId: string): string {
  return `claude-config-dir:${threadId}`;
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

async function withTimeout(task: Promise<void>, ms: number): Promise<void> {
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

async function resolveClaudeEnv(
  deps: ClaudeProfileDeps,
  ctx: ExperimentalPluginProviderEnvContext,
): Promise<ExperimentalPluginProviderEnvEntry[]> {
  const { log, kv } = deps;
  const key = pinKey(ctx.threadId);
  const pinned = await kv.get<ConfigDirPin>(key);
  if (pinned) {
    log.debug(
      `env thread=${ctx.threadId} project=${ctx.projectId} pinned -> ${pinned.dir ?? "default profile"}`,
    );
    return pinEntries(pinned);
  }
  const sources = await deps.sourcesFor(ctx.projectId);
  if (!sources) {
    log.warn(
      `project ${ctx.projectId} not resolved; thread ${ctx.threadId} starts with default profile`,
    );
    return [];
  }
  const local = sources
    .filter((source) => source.hostId === ctx.hostId)
    .map((source) => source.path);
  const choice = configDirFor(deps.scopes, local);
  if (choice.conflict.length > 0) {
    log.warn(
      `project ${ctx.projectId} matches scopes with different claudeConfigDir: ${[choice.scope, ...choice.conflict].join(", ")}; using "${choice.scope}"`,
    );
  }
  let pin: ConfigDirPin = { dir: choice.dir, scope: choice.scope };
  if (pin.dir && !existsSync(pin.dir)) {
    log.warn(
      `scope "${pin.scope}" claudeConfigDir ${pin.dir} does not exist; thread ${ctx.threadId} starts with default profile`,
    );
    pin = { dir: null, scope: null };
  }
  await kv.set(key, pin);
  log.debug(
    `env thread=${ctx.threadId} project=${ctx.projectId} host=${ctx.hostId} -> ${pin.dir ?? "default profile"}`,
  );
  return pinEntries(pin);
}

/** The profile a project's checkouts select, and the one the current thread was pinned to. */
async function checkClaudeProfile(
  deps: ClaudeProfileDeps,
  projectId: string | null,
  threadId: string | undefined,
): Promise<{ profile: ConfigDirChoice | null; pinned: ConfigDirPin | null }> {
  const sources = projectId ? await deps.sourcesFor(projectId) : undefined;
  const profile = projectId
    ? configDirFor(
        deps.scopes,
        (sources ?? []).map((s) => s.path),
      )
    : null;
  const pinned = threadId
    ? ((await deps.kv.get<ConfigDirPin>(pinKey(threadId))) ?? null)
    : null;
  return { profile, pinned };
}

function claudeProfileLines(
  profile: ConfigDirChoice | null,
  pinned: ConfigDirPin | null,
  threadId: string | undefined,
): string[] {
  const lines: string[] = [];
  if (!profile) lines.push("Claude profile: needs --project");
  else {
    lines.push(
      `Claude profile (by project checkout): ${profile.dir ? `${profile.dir}  (scope ${profile.scope})` : "none"}`,
    );
    if (profile.conflict.length > 0)
      lines.push(`  conflicts with scope(s): ${profile.conflict.join(", ")}`);
  }
  if (threadId)
    lines.push(
      `Claude profile pinned for thread ${threadId}: ${pinned ? (pinned.dir ?? "none (default profile)") : "not pinned yet"}`,
    );
  return lines;
}

function warnMissingConfigDirs(scopes: Scope[], log: BbPluginApi["log"]): void {
  for (const scope of scopes) {
    if (scope.claudeConfigDir && !existsSync(scope.claudeConfigDir)) {
      log.warn(
        `scope "${scope.name}" claudeConfigDir ${scope.claudeConfigDir} does not exist; threads there start with the default profile`,
      );
    }
  }
}

function projectSources(
  sources: ReadonlyArray<{ path?: string | null; hostId?: string | null }> | undefined,
): ProjectSource[] {
  const found: ProjectSource[] = [];
  for (const source of sources ?? []) {
    if (typeof source.path === "string" && source.path !== "")
      found.push({ path: source.path, hostId: source.hostId ?? null });
  }
  return found;
}

/** Recovery: forget a thread's pinned profile so its next turn resolves afresh. */
async function unpinThread(
  kv: BbPluginApi["storage"]["kv"],
  threadId: string | undefined,
): Promise<{ exitCode: number; stdout?: string; stderr?: string }> {
  if (!threadId)
    return { exitCode: 2, stderr: "unpin: give a thread id\n" };
  const pinned = await kv.get<ConfigDirPin>(pinKey(threadId));
  if (!pinned) return { exitCode: 0, stdout: `thread ${threadId}: no pin\n` };
  await kv.delete(pinKey(threadId));
  return {
    exitCode: 0,
    stdout: `thread ${threadId}: removed pin (${pinned.dir ? `${pinned.dir}, scope ${pinned.scope}` : "default profile"})\n`,
  };
}

function pluginRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.basename(here) === "dist" ? path.dirname(here) : here;
}

function userScopesFile(): string {
  return path.join(homedir(), ".bb", "dir-skills", "scopes.json");
}

function frontmatterName(skillFile: string): string | null {
  const text = readFileSync(skillFile, "utf8");
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!match) return null;
  for (const line of match[1].split(/\r?\n/)) {
    const m = /^name:\s*(.+?)\s*$/.exec(line);
    if (m) return m[1].replace(/^["']|["']$/g, "");
  }
  return null;
}

function loadSkills(root: string, scopes: Scope[]): SkillInfo[] {
  const skillsRoot = path.join(root, "skills");
  const skills: SkillInfo[] = [];
  for (const entry of readdirSync(skillsRoot).sort()) {
    const dir = path.join(skillsRoot, entry);
    let isDir = false;
    try {
      isDir = statSync(dir).isDirectory();
    } catch {
      isDir = false;
    }
    if (!isDir) continue;
    const skillFile = path.join(dir, "SKILL.md");
    let name: string | null = null;
    try {
      name = frontmatterName(skillFile) ?? entry;
    } catch {
      continue;
    }
    const owners = scopes
      .filter((scope) => scope.patterns.some((re) => re.test(name as string)))
      .map((s) => s.name);
    skills.push({ name, dir, scopes: owners });
  }
  return skills;
}

export default async function plugin(bb: BbPluginApi) {
  const root = pluginRoot();
  const scopes = loadScopes(root, userScopesFile());
  const skills = loadSkills(root, scopes);
  bb.log.info(
    `loaded ${skills.length} skill(s), ${scopes.length} scope(s): ` +
      scopes.map((s) => `${s.name} -> ${s.paths.join(", ")}`).join("; "),
  );
  for (const scope of scopes) {
    if (!skills.some((skill) => skill.scopes.includes(scope.name))) {
      bb.log.warn(
        `scope "${scope.name}" matches no skill under skills/ (patterns: ${scope.patternSources.join(", ")})`,
      );
    }
  }

  warnMissingConfigDirs(scopes, bb.log);

  const projectPaths = new Map<string, ProjectSource[]>();
  async function refreshProjects(): Promise<void> {
    try {
      const projects = await bb.sdk.projects.list({ includePersonal: true });
      const next = new Map<string, ProjectSource[]>();
      for (const project of projects) {
        next.set(project.id, projectSources(project.sources));
      }
      projectPaths.clear();
      for (const [id, found] of next) projectPaths.set(id, found);
    } catch (error) {
      bb.log.warn(
        `project list refresh failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  await refreshProjects();

  bb.background.service("project-path-cache", {
    async start(signal) {
      while (!signal.aborted) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, PROJECT_REFRESH_MS);
          signal.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              resolve();
            },
            { once: true },
          );
        });
        if (!signal.aborted) await refreshProjects();
      }
    },
  });
  bb.events.on("thread.created", () => {
    void refreshProjects();
  });

  function candidatesFor(
    environmentPath: string | null,
    projectId: string | null,
  ): string[] {
    const out: string[] = [];
    if (environmentPath) out.push(environmentPath);
    if (projectId)
      out.push(...(projectPaths.get(projectId) ?? []).map((s) => s.path));
    return out;
  }

  const profileDeps: ClaudeProfileDeps = {
    scopes,
    log: bb.log,
    kv: bb.storage.kv,
    async sourcesFor(projectId) {
      if (!projectPaths.has(projectId))
        await withTimeout(refreshProjects(), PROJECT_LOOKUP_TIMEOUT_MS);
      return projectPaths.get(projectId);
    },
  };

  if (typeof bb.providers?.experimental_contributeEnv === "function") {
    bb.providers.experimental_contributeEnv("claude-code", (ctx) =>
      resolveClaudeEnv(profileDeps, ctx),
    );
    bb.events.on("thread.deleted", async ({ thread }) => {
      await bb.storage.kv.delete(pinKey(thread.id));
    });
  } else {
    bb.log.warn(
      "bb.providers.experimental_contributeEnv unavailable; claudeConfigDir is not applied",
    );
  }

  bb.agents.configure((context) => {
    const candidates = candidatesFor(
      context.environment.path,
      context.project.id,
    );
    const selected = selectSkills(skills, scopes, candidates);
    bb.log.debug(
      `configure thread=${context.thread.id} provider=${context.provider.id} env=${context.environment.path ?? "null"} ` +
        `project=${context.project.id} -> [${selected.join(", ")}]`,
    );
    return { tools: [], skills: selected };
  });

  bb.cli.register({
    name: "dir-skills",
    summary: "Show directory-scoped skills and which ones apply to a path",
    commands: [
      {
        name: "status",
        summary: "List scopes and skills with their scope",
        usage: "bb dir-skills status [--json]",
      },
      {
        name: "check",
        summary: "Show the skills a thread rooted at a path would receive",
        usage: "bb dir-skills check [<path>] [--project <project-id>] [--json]",
      },
      {
        name: "unpin",
        summary: "Forget a thread's pinned Claude profile",
        usage: "bb dir-skills unpin <thread-id>",
      },
    ],
    async run(argv, ctx) {
      const json = argv.includes("--json");
      const args = argv.filter((a) => a !== "--json");
      const command = args[0] ?? "status";
      if (command === "status") {
        const payload = {
          root,
          userScopesFile: userScopesFile(),
          userScopesLoaded: existsSync(userScopesFile()),
          scopes: scopes.map((s) => ({
            name: s.name,
            paths: s.paths,
            skills: s.patternSources,
            claudeConfigDir: s.claudeConfigDir,
          })),
          skills: skills.map((s) => ({ name: s.name, scopes: s.scopes })),
        };
        if (json)
          return {
            exitCode: 0,
            stdout: JSON.stringify(payload, null, 2) + "\n",
          };
        const lines = [
          `plugin root: ${root}`,
          `user scopes: ${payload.userScopesFile}${payload.userScopesLoaded ? "" : " (absent)"}`,
          "",
          "scopes:",
        ];
        for (const s of scopes)
          lines.push(
            `  ${s.name}: ${s.paths.join(", ")}  ->  ${s.patternSources.join(", ")}` +
              (s.claudeConfigDir
                ? `  [claude profile: ${s.claudeConfigDir}]`
                : ""),
          );
        lines.push("", "skills:");
        for (const s of skills)
          lines.push(
            `  ${s.name}  [${s.scopes.length === 0 ? "global" : s.scopes.join(", ")}]`,
          );
        return { exitCode: 0, stdout: lines.join("\n") + "\n" };
      }
      if (command === "check") {
        let projectFlag: string | null = null;
        const rest: string[] = [];
        for (let i = 1; i < args.length; i += 1) {
          if (args[i] === "--project") {
            projectFlag = args[i + 1] ?? null;
            i += 1;
          } else {
            rest.push(args[i]);
          }
        }
        const target = rest[0] ?? ctx.cwd ?? null;
        if (!target)
          return {
            exitCode: 2,
            stderr: "check: give a path, or run from inside a bb thread\n",
          };
        const projectId =
          projectFlag ?? (rest[0] ? null : (ctx.projectId ?? null));
        const selected = selectSkills(
          skills,
          scopes,
          candidatesFor(target, projectId),
        );
        const { profile, pinned } = await checkClaudeProfile(
          profileDeps,
          projectId,
          ctx.threadId,
        );
        const payload = {
          path: normalizeDir(target),
          projectId,
          skills: selected,
          claudeProfile: profile,
          ...(ctx.threadId ? { threadId: ctx.threadId, pinned } : {}),
        };
        if (json)
          return {
            exitCode: 0,
            stdout: JSON.stringify(payload, null, 2) + "\n",
          };
        const lines = [
          `path: ${payload.path}${projectId ? `  (project ${projectId})` : ""}`,
          selected.length === 0
            ? "skills: none"
            : `skills:\n${selected.map((s) => `  ${s}`).join("\n")}`,
        ];
        lines.push(...claudeProfileLines(profile, pinned, ctx.threadId));
        return { exitCode: 0, stdout: lines.join("\n") + "\n" };
      }
      if (command === "unpin") return unpinThread(profileDeps.kv, args[1]);
      return {
        exitCode: 2,
        stderr: `unknown command "${command}"; try: bb dir-skills status | check [<path>] | unpin <thread-id>\n`,
      };
    },
  });
}
