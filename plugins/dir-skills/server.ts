import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import {
  checkClaudeProfile,
  claudeProfileLines,
  isDirectory,
  PROJECT_LOOKUP_TIMEOUT_MS,
  resolveClaudeEnv,
  unpinThread,
  warnMissingConfigDirs,
  withTimeout,
  type ClaudeProfileDeps,
  type ProjectSource,
} from "./profile";
import {
  loadScopes,
  normalizeDir,
  selectSkills,
  type Scope,
  type SkillInfo,
} from "./scopes";
import {
  autoSetup,
  autoSetupLine,
  SETUP_RECORD_KEY,
  setupCommand,
  type SetupDeps,
  type SetupRecord,
} from "./setup";

const PROJECT_REFRESH_MS = 60_000;

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
  const state: { scopes: Scope[]; skills: SkillInfo[] } = {
    scopes: [],
    skills: [],
  };
  function loadState(): void {
    state.scopes = loadScopes(root, userScopesFile());
    state.skills = loadSkills(root, state.scopes);
    bb.log.info(
      `loaded ${state.skills.length} skill(s), ${state.scopes.length} scope(s): ` +
        state.scopes.map((s) => `${s.name} -> ${s.paths.join(", ")}`).join("; "),
    );
    for (const scope of state.scopes) {
      if (!state.skills.some((skill) => skill.scopes.includes(scope.name))) {
        bb.log.warn(
          `scope "${scope.name}" matches no skill under skills/ (patterns: ${scope.patternSources.join(", ")})`,
        );
      }
    }
    warnMissingConfigDirs(state.scopes, bb.log);
  }
  loadState();

  const setupDeps: SetupDeps = {
    home: homedir(),
    userFile: userScopesFile(),
    sdk: bb.sdk,
    kv: bb.storage.kv,
    log: bb.log,
    reload: loadState,
  };
  if (typeof bb.onInstall === "function") {
    bb.onInstall(() => autoSetup(setupDeps));
  }

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
    get scopes() {
      return state.scopes;
    },
    log: bb.log,
    kv: bb.storage.kv,
    isDir: isDirectory,
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
    const selected = selectSkills(state.skills, state.scopes, candidates);
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
        name: "setup",
        summary: "Create scopes.json from detected work settings when it is missing",
        usage: "bb dir-skills setup [--dry-run] [--json]",
      },
      {
        name: "unpin",
        summary: "Forget a thread's pinned Claude profile",
        usage: "bb dir-skills unpin [<thread-id>]",
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
          autoSetup: (await bb.storage.kv.get<SetupRecord>(SETUP_RECORD_KEY)) ?? null,
          scopes: state.scopes.map((s) => ({
            name: s.name,
            paths: s.paths,
            skills: s.patternSources,
            claudeConfigDir: s.claudeConfigDir,
          })),
          skills: state.skills.map((s) => ({ name: s.name, scopes: s.scopes })),
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
        for (const s of state.scopes)
          lines.push(
            `  ${s.name}: ${s.paths.join(", ")}  ->  ${s.patternSources.join(", ")}` +
              (s.claudeConfigDir
                ? `  [claude profile: ${s.claudeConfigDir}]`
                : ""),
          );
        lines.push("", "skills:");
        for (const s of state.skills)
          lines.push(
            `  ${s.name}  [${s.scopes.length === 0 ? "global" : s.scopes.join(", ")}]`,
          );
        const auto = autoSetupLine(payload.autoSetup ?? undefined);
        if (auto) lines.push("", auto);
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
          state.skills,
          state.scopes,
          candidatesFor(target, projectId),
        );
        const { decision, pinned } = await checkClaudeProfile(
          profileDeps,
          projectId,
          ctx.threadId,
        );
        const payload = {
          path: normalizeDir(target),
          projectId,
          skills: selected,
          claudeProfile: decision && {
            status: decision.status,
            dir: decision.pin.dir,
            scope: decision.pin.scope,
            conflict: decision.conflict,
          },
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
        lines.push(...claudeProfileLines(decision, pinned, ctx.threadId));
        return { exitCode: 0, stdout: lines.join("\n") + "\n" };
      }
      if (command === "setup") return setupCommand(setupDeps, args.slice(1), json);
      if (command === "unpin") return unpinThread(profileDeps.kv, args[1], ctx.threadId);
      return {
        exitCode: 2,
        stderr: `unknown command "${command}"; try: bb dir-skills status | check [<path>] | setup [--dry-run] | unpin [<thread-id>]\n`,
      };
    },
  });
}
