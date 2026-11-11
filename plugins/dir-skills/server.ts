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
  dirSkillsRpcContract,
  uiScopesSchema,
  type FileScope,
  type ScopesSnapshot,
  type UiScope,
} from "./rpc-contract";
import {
  loadScopes,
  normalizeDir,
  selectSkills,
  validateUiScopes,
  type Scope,
  type SkillInfo,
} from "./scopes";
import {
  autoSetup,
  autoSetupLine,
  exportCommand,
  SETUP_RECORD_KEY,
  setupCommand,
  type SetupDeps,
  type SetupRecord,
} from "./setup";

const PROJECT_REFRESH_MS = 60_000;
/** kv key of the scopes saved by the settings form. */
const UI_SCOPES_KEY = "uiScopes";

interface SkillEntry extends SkillInfo {
  description: string;
}

/** What one load of the scope layers produces. Built without side effects, so a failed load can be dropped. */
interface Computed {
  scopes: Scope[];
  skills: SkillEntry[];
  fileScopes: FileScope[];
  skipped: string[];
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

function pluginRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.basename(here) === "dist" ? path.dirname(here) : here;
}

function userScopesFile(): string {
  return path.join(homedir(), ".bb", "dir-skills", "scopes.json");
}

function exportFile(): string {
  return path.join(homedir(), ".bb", "dir-skills", "export.json");
}

function unquote(value: string): string {
  return value.replace(/^["']|["']$/g, "");
}

/** The single-line `name` and `description` of a SKILL.md frontmatter. YAML block values are not read. */
function frontmatter(skillFile: string): { name: string | null; description: string } {
  const text = readFileSync(skillFile, "utf8");
  const found = { name: null as string | null, description: "" };
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!match) return found;
  for (const line of match[1].split(/\r?\n/)) {
    const name = /^name:\s*(.+?)\s*$/.exec(line);
    if (name) found.name = unquote(name[1]);
    const description = /^description:\s*(.+?)\s*$/.exec(line);
    if (description) found.description = unquote(description[1]);
  }
  return found;
}

function loadSkills(root: string, scopes: Scope[]): SkillEntry[] {
  const skillsRoot = path.join(root, "skills");
  const skills: SkillEntry[] = [];
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
    let name: string;
    let description: string;
    try {
      const meta = frontmatter(skillFile);
      name = meta.name ?? entry;
      description = meta.description;
    } catch {
      continue;
    }
    const owners = scopes
      .filter((scope) => scope.patterns.some((re) => re.test(name)))
      .map((s) => s.name);
    skills.push({ name, description, dir, scopes: owners });
  }
  return skills;
}

/**
 * The text of the removed v0.2.5 "Scopes" setting: `{ "scopes": [...] }`.
 * Returns the scopes to import, or throws why the text cannot be imported.
 */
function legacyScopes(text: string, home: string): UiScope[] {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error("not valid JSON");
  }
  const parsed = uiScopesSchema.safeParse((raw as { scopes?: unknown } | null)?.scopes);
  if (!parsed.success) throw new Error('expected { "scopes": [...] } with name, paths and skills only');
  validateUiScopes(parsed.data, home);
  return parsed.data;
}

export default async function plugin(bb: BbPluginApi) {
  const root = pluginRoot();
  const state: { scopes: Scope[]; skills: SkillEntry[] } = {
    scopes: [],
    skills: [],
  };

  // The UI scopes as saved (not normalized), what `getScopes` returns.
  let uiScopes: UiScope[] = [];
  let settingError: string | null = null;

  /** Why a stored value cannot be used, or null when it can. */
  function storedProblem(stored: unknown): string | null {
    const parsed = uiScopesSchema.safeParse(stored);
    if (!parsed.success) return "the stored value has the wrong shape";
    try {
      validateUiScopes(parsed.data, homedir());
      return null;
    } catch (error) {
      return (error as Error).message;
    }
  }

  /** One-time, best effort: moves a value of the removed v0.2.5 "Scopes" setting into kv. */
  async function importLegacySetting(): Promise<UiScope[] | undefined> {
    let text: unknown;
    try {
      const { values } = await bb.sdk.plugins.getSettings({ pluginId: bb.pluginId });
      text = values.scopes;
    } catch {
      return undefined;
    }
    if (typeof text !== "string" || text.trim() === "") return undefined;
    try {
      const imported = legacyScopes(text, homedir());
      await bb.storage.kv.set(UI_SCOPES_KEY, imported);
      bb.log.info(`imported ${imported.length} scope(s) from the removed Scopes setting`);
      return imported;
    } catch (error) {
      bb.log.warn(`the removed Scopes setting was not imported: ${(error as Error).message}`);
      return undefined;
    }
  }

  let stored: unknown = await bb.storage.kv.get<unknown>(UI_SCOPES_KEY);
  if (stored === undefined) stored = await importLegacySetting();
  if (stored !== undefined) {
    settingError = storedProblem(stored);
    if (settingError === null) {
      uiScopes = stored as UiScope[];
    } else {
      bb.log.warn(`Stored UI scopes ignored: ${settingError}`);
    }
  }

  let fileScopes: FileScope[] = [];
  let settingSkipped: string[] = [];

  /** Reads both scope files and the skills with the given UI scopes applied. Throws on a broken file; assigns nothing. */
  function compute(ui: UiScope[]): Computed {
    const skipped: string[] = [];
    const files: FileScope[] = [];
    const uiValidated = validateUiScopes(ui, homedir());
    const scopes = loadScopes(
      root,
      userScopesFile(),
      homedir(),
      uiValidated,
      (name) => skipped.push(name),
      (scope, source) =>
        files.push({
          name: scope.name,
          paths: scope.paths,
          skills: scope.patternSources,
          source,
          hasProfile: scope.claudeConfigDir !== null,
          replacedByUi: false,
        }),
    );
    for (const file of files) {
      file.replacedByUi =
        !file.hasProfile && uiValidated.some((scope) => scope.name === file.name);
    }
    return { scopes, skills: loadSkills(root, scopes), fileScopes: files, skipped };
  }

  function apply(next: Computed): void {
    state.scopes = next.scopes;
    state.skills = next.skills;
    fileScopes = next.fileScopes;
    settingSkipped = next.skipped;
    for (const name of next.skipped) {
      bb.log.warn(
        `UI scopes: scope "${name}" ignored: a scope with a Claude profile can only be changed in ~/.bb/dir-skills/scopes.json`,
      );
    }
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
  function loadState(): void {
    apply(compute(uiScopes));
  }
  loadState();

  function snapshot(): ScopesSnapshot {
    return {
      fileScopes,
      uiScopes,
      skills: state.skills.map((skill) => ({
        name: skill.name,
        description: skill.description,
      })),
      skipped: settingSkipped,
      settingError,
    };
  }

  // Saves run one at a time; a rejected save does not stop the next one.
  let saves: Promise<unknown> = Promise.resolve();
  function enqueue<T>(run: () => Promise<T>): Promise<T> {
    const next = saves.then(run, run);
    saves = next;
    return next;
  }

  /** Not discoverable: these methods exist for the settings page, not for agents. */
  bb.rpc.register(dirSkillsRpcContract, {
    async getScopes() {
      return snapshot();
    },
    saveScopes({ scopes }) {
      return enqueue(async () => {
        const next = compute(scopes);
        await bb.storage.kv.set(UI_SCOPES_KEY, scopes);
        uiScopes = scopes;
        settingError = null;
        apply(next);
        return snapshot();
      });
    },
  });

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
      {
        name: "export",
        summary: "Write UI scopes and Claude profile pins to ~/.bb/dir-skills/export.json",
        usage: "bb dir-skills export [--json]",
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
          settingScopes: uiScopes.length,
          settingError,
          settingSkipped,
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
          settingError === null
            ? `ui scopes: ${uiScopes.length} (settings form)`
            : `ui scopes: ignored — ${settingError}`,
        ];
        if (settingSkipped.length > 0)
          lines.push(
            `ui scopes skipped (profile scopes are file-only): ${settingSkipped.join(", ")}`,
          );
        lines.push("", "scopes:");
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
      if (command === "export")
        return exportCommand(
          { kv: bb.storage.kv, uiScopes, settingError, target: exportFile() },
          json,
        );
      return {
        exitCode: 2,
        stderr: `unknown command "${command}"; try: bb dir-skills status | check [<path>] | setup [--dry-run] | unpin [<thread-id>] | export\n`,
      };
    },
  });
}
