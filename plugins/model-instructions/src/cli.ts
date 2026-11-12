import { constants } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";
import type { BbPluginApi, PluginCliContext, PluginCliResult } from "@get-bb/plugin-sdk";
import {
  budgetReport,
  cacheProblem,
  describeType,
  formatGroups,
  groupOverflows,
  notCheckable,
  type Role,
  type ThreadType,
} from "./budget.js";
import type { Scope } from "./paths.js";
import { importCommand, type ImportDeps } from "./import.js";
import {
  checkClaudeProfile,
  claudeProfileLines,
  pinKey,
  unpinThread,
  type ClaudeProfileDeps,
} from "./profile.js";
import { ignoredScopeText, type ProfilesState } from "./profiles-file.js";
import type { Caches } from "./projects.js";
import {
  activeScopeNamesIn,
  claimants,
  compose,
  fullLength,
  INSTRUCTIONS_LIMIT,
  matchRules,
  previousForm,
  ruleLabel,
  SELF_SKILL,
  unresolvedRefs,
  type RawConfig,
  type Rule,
} from "./rules.js";
import { setupCommand, type SetupDeps } from "./setup.js";
import type { SkillEntry } from "./skills.js";

/** A thread type that is over the limit, as `status` lists it. */
export interface OverBudgetRecord extends ThreadType {
  /** ISO time of the refresh that first saw it overflow; later refreshes update the length, not this. */
  since: string;
}

/** A thread that lost rules at runtime. Holds names and lengths only, never instruction text. */
export interface OverflowEvent {
  time: string;
  threadId: string;
  provider: string;
  model: string;
  role: Role;
  project: string;
  dropped: string[];
  /** Instruction length of each dropped rule, in the same order. */
  lengths: number[];
}

/** The slice of `bb.sdk.threads` the check command reads, typed by the SDK itself. */
export type ThreadLookup = Pick<BbPluginApi["sdk"]["threads"], "get" | "defaultExecutionOptions">;

/** The saved config, as `export` and `import` see it. */
export interface ConfigCli {
  /** The saved config as stored. */
  saved(): RawConfig;
  /** The stored config as JSON text when it failed to load at start and is still unreplaced, else undefined. */
  storedText(): string | undefined;
  /** True when the plugin's storage could not be read at start, so the saved config is unknown. */
  storageFailed(): boolean;
  /** Validates and saves a config value (full checks) and returns what was stored. Throws the field-specific error. */
  importConfig(value: unknown): Promise<{ saved: RawConfig }>;
}

export interface CliDeps {
  rules(): Rule[];
  scopes(): Scope[];
  skills(): SkillEntry[];
  caches: Caches;
  overBudget(): OverBudgetRecord[];
  events(): OverflowEvent[];
  threads: ThreadLookup;
  profiles(): ProfilesState;
  /** Where profiles.json is read from. */
  profilesFile: string;
  /** Names of saved scopes left out because a profile scope has the same name. */
  ignoredSettingScopes(): string[];
  profile: ClaudeProfileDeps;
  setup: SetupDeps;
  importDirSkills: ImportDeps;
  config: ConfigCli;
}

export const USAGE =
  "bb model-instructions status [--json] | check [--provider P] [--model M] [--child | --top-level] [--project <id>] [--path <dir>] [--title T] [--json] | check --all [--json] | setup [--dry-run] [--json] | unpin [<thread-id>] | import-dir-skills [--dry-run] [--json] | export | import <file>";

const out = (value: unknown): PluginCliResult => ({
  exitCode: 0,
  stdout: JSON.stringify(value, null, 2) + "\n",
});

const usageError = (message: string): PluginCliResult => ({
  exitCode: 2,
  stderr: `${message}\nusage: ${USAGE}\n`,
});

function matchersOf(rule: Rule): Record<string, string | string[]> {
  const found: Record<string, string | string[]> = {};
  for (const key of ["provider", "model", "project", "skipProjects", "skipTitles", "scope"] as const) {
    const value = rule[key];
    if (value !== undefined) found[key] = value;
  }
  if (rule.threads !== "any") found.threads = rule.threads;
  return found;
}

function listState(list: { loaded: boolean; failed: boolean }): string {
  if (!list.loaded) return list.failed ? "not loaded, last refresh failed" : "not loaded";
  return list.failed ? "loaded, last refresh failed" : "loaded";
}

function uncheckedText(unchecked: ReadonlyArray<{ id: string; reason: string }>): string {
  return unchecked.map((provider) => `${provider.id} (${provider.reason})`).join(", ");
}

async function status(deps: CliDeps, json: boolean): Promise<PluginCliResult> {
  const rules = deps.rules();
  const skills = deps.skills();
  const snapshot = deps.caches.snapshot();
  const scopes = deps.scopes();
  const unresolved = unresolvedRefs(
    rules,
    scopes.map((scope) => scope.name),
    skills.map((skill) => skill.name),
  );
  const profiles = deps.profiles();
  const payload = {
    profiles: {
      file: deps.profilesFile,
      state: profiles.state,
      ...(profiles.state === "malformed" ? { message: profiles.message } : {}),
      scopes:
        profiles.state === "valid"
          ? profiles.scopes.map((scope) => ({
              name: scope.name,
              paths: scope.paths,
              claudeConfigDir: scope.claudeConfigDir,
              dirExists: deps.profile.isDir(scope.claudeConfigDir),
            }))
          : [],
      pins: (await deps.profile.kv.list(pinKey(""))).length,
    },
    ignoredSettingScopes: deps.ignoredSettingScopes(),
    scopes: scopes.map((scope) => ({ name: scope.name, paths: scope.paths })),
    rules: rules.map((rule, index) => ({
      name: ruleLabel(rule, index),
      matchers: matchersOf(rule),
      instructionsLength: rule.instructions?.length ?? null,
      skills: rule.skills ?? [],
      plugins: rule.plugins ?? [],
      unresolved: unresolved
        .filter((ref) => ref.index === index)
        .map(({ kind, glob }) => ({ kind, glob })),
    })),
    skills: skills.map((skill) => ({
      name: skill.name,
      claimedBy:
        skill.name === SELF_SKILL
          ? null
          : claimants(rules, skill.name).map((index) => ruleLabel(rules[index], index)),
    })),
    unclaimedSkills: skills
      .filter((skill) => skill.name !== SELF_SKILL && claimants(rules, skill.name).length === 0)
      .map((skill) => skill.name),
    cache: {
      providers: {
        loaded: snapshot.providers.loaded,
        failed: snapshot.providers.failed,
        unchecked: snapshot.providers.unchecked,
      },
      projects: { loaded: snapshot.projects.loaded, failed: snapshot.projects.failed },
    },
    overBudget: deps.overBudget(),
    overflowEvents: deps.events(),
  };
  if (json) return out(payload);
  const lines = [
    `profiles file: ${payload.profiles.file}`,
    payload.profiles.state === "malformed"
      ? `profiles.json: malformed — ${payload.profiles.message}`
      : `profiles.json: ${payload.profiles.state}`,
  ];
  for (const scope of payload.profiles.scopes)
    lines.push(
      `  profile scope ${scope.name}: ${scope.paths.join(", ")} -> ${scope.claudeConfigDir} (${scope.dirExists ? "directory exists" : "not a directory"})`,
    );
  for (const name of payload.ignoredSettingScopes) lines.push(ignoredScopeText(name));
  lines.push(`pins: ${payload.profiles.pins}`, "", "scopes:");
  if (payload.scopes.length === 0) lines.push("  (none)");
  for (const scope of payload.scopes) lines.push(`  ${scope.name}: ${scope.paths.join(", ")}`);
  lines.push("", "rules:");
  if (payload.rules.length === 0) lines.push("  (none)");
  for (const rule of payload.rules) {
    const matchers = Object.entries(rule.matchers)
      .map(([key, value]) => `${key}=${Array.isArray(value) ? value.join("|") : value}`)
      .join(" ");
    lines.push(
      `  ${rule.name}  ${matchers === "" ? "(matches every thread)" : matchers}  ` +
        (rule.instructionsLength === null
          ? "no instructions"
          : `instructions=${rule.instructionsLength} chars`) +
        (rule.skills.length > 0 ? `  skills=${rule.skills.join("|")}` : "") +
        (rule.plugins.length > 0 ? `  plugins=${rule.plugins.join("|")}` : ""),
    );
    for (const ref of rule.unresolved) lines.push(`  ! ${ref.kind} "${ref.glob}" matches nothing`);
  }
  lines.push("", "skills:");
  for (const skill of payload.skills)
    lines.push(
      `  ${skill.name}  ${
        skill.claimedBy === null
          ? "always injected"
          : skill.claimedBy.length === 0
            ? "claimed by no rule"
            : `claimed by ${skill.claimedBy.join(", ")}`
      }`,
    );
  lines.push(
    payload.unclaimedSkills.length === 0
      ? "unclaimed skills: none"
      : `unclaimed skills (injected nowhere): ${payload.unclaimedSkills.join(", ")}`,
  );
  lines.push(
    "",
    `cache: provider list ${listState(snapshot.providers)}; project list ${listState(snapshot.projects)}`,
    snapshot.providers.unchecked.length === 0
      ? "unchecked providers: none"
      : `unchecked providers: ${uncheckedText(snapshot.providers.unchecked)}`,
  );
  lines.push("", "over budget:");
  if (payload.overBudget.length === 0) lines.push("  (none)");
  for (const record of payload.overBudget)
    lines.push(`  ${describeType(record)} (over budget since ${record.since})`);
  lines.push("", "recent overflow events:");
  if (payload.overflowEvents.length === 0) lines.push("  (none)");
  for (const event of payload.overflowEvents)
    lines.push(
      `  ${event.time} ${event.threadId} ${event.provider} ${event.model} ${event.role} project ${event.project === "" ? "(none)" : JSON.stringify(event.project)}: ` +
        event.dropped.map((name, i) => `${name} (${event.lengths[i]} chars)`).join(", "),
    );
  return { exitCode: 0, stdout: lines.join("\n") + "\n" };
}

interface CheckFlags {
  provider?: string;
  model?: string;
  project?: string;
  path?: string;
  title?: string;
  child: boolean;
  topLevel: boolean;
  all: boolean;
  json: boolean;
}

const VALUE_FLAGS = ["provider", "model", "project", "path", "title"] as const;

function parseCheckFlags(args: string[]): CheckFlags | string {
  const flags: CheckFlags = { child: false, topLevel: false, all: false, json: false };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--top-level") {
      flags.topLevel = true;
      continue;
    }
    if (arg === "--child" || arg === "--all" || arg === "--json") {
      flags[arg.slice(2) as "child" | "all" | "json"] = true;
      continue;
    }
    const name = VALUE_FLAGS.find((flag) => arg === `--${flag}`);
    if (name === undefined) return `check: unknown argument "${arg}"`;
    const value = args[i + 1];
    if (value === undefined) return `check: ${arg} needs a value`;
    flags[name] = value;
    i += 1;
  }
  if (flags.child && flags.topLevel) return "check: --top-level and --child cannot be used together";
  return flags;
}

function checkAll(deps: CliDeps, json: boolean): PluginCliResult {
  const snapshot = deps.caches.snapshot();
  const problem = cacheProblem(snapshot);
  if (problem !== null) {
    const message = notCheckable(problem);
    return json
      ? { exitCode: 1, stdout: JSON.stringify({ ok: false, error: message }, null, 2) + "\n" }
      : { exitCode: 1, stderr: message + "\n" };
  }
  const rules = deps.rules();
  const report = budgetReport(rules, deps.scopes(), snapshot);
  const groups = groupOverflows(report.overflowing, rules);
  const exitCode = report.overflowing.length === 0 ? 0 : 1;
  if (json)
    return {
      exitCode,
      stdout:
        JSON.stringify(
          {
            ok: exitCode === 0,
            limit: INSTRUCTIONS_LIMIT,
            checked: report.checked,
            overflowing: report.overflowing.length,
            groups,
            uncheckedProviders: snapshot.providers.unchecked,
          },
          null,
          2,
        ) + "\n",
    };
  const lines =
    exitCode === 0
      ? [`no thread type exceeds ${INSTRUCTIONS_LIMIT} characters (${report.checked} checked)`]
      : [
          ...formatGroups(groups),
          `${report.overflowing.length} of ${report.checked} thread types are over the limit`,
        ];
  if (snapshot.providers.unchecked.length > 0)
    lines.push(`unchecked providers: ${uncheckedText(snapshot.providers.unchecked)}`);
  return { exitCode, stdout: lines.join("\n") + "\n" };
}

type Source = "flag" | "thread" | "context" | "assumed";

async function check(
  args: string[],
  ctx: PluginCliContext,
  deps: CliDeps,
): Promise<PluginCliResult> {
  const flags = parseCheckFlags(args);
  if (typeof flags === "string") return usageError(flags);
  if (flags.all) {
    if (args.some((arg) => arg !== "--all" && arg !== "--json"))
      return usageError("check: --all takes no other flag except --json");
    return checkAll(deps, flags.json);
  }

  let thread: Awaited<ReturnType<ThreadLookup["get"]>> | null = null;
  let threadModel: string | null = null;
  if (ctx.threadId !== undefined) {
    try {
      thread = await deps.threads.get({
        threadId: ctx.threadId,
        include: "environment",
      });
      threadModel = (await deps.threads.defaultExecutionOptions({ threadId: ctx.threadId }))?.model ?? null;
    } catch {
      // The thread lookup is a convenience; flags still work without it.
    }
  }

  const provider = flags.provider ?? thread?.providerId;
  const model = flags.model ?? threadModel ?? undefined;
  if (provider === undefined || model === undefined)
    return usageError(
      `check: ${provider === undefined ? "--provider" : "--model"} is needed; no thread to default it from`,
    );
  const sources: Record<string, Source> = {
    provider: flags.provider === undefined ? "thread" : "flag",
    model: flags.model === undefined ? "thread" : "flag",
  };
  const role: Role = flags.child
    ? "child"
    : flags.topLevel
      ? "top-level"
      : thread !== null && thread.parentThreadId !== null
        ? "child"
        : "top-level";
  sources.role = flags.child || flags.topLevel ? "flag" : thread === null ? "assumed" : "thread";
  const title = flags.title ?? thread?.title ?? null;
  sources.title = flags.title !== undefined ? "flag" : thread === null ? "assumed" : "thread";
  const projectId = flags.project ?? ctx.projectId ?? thread?.projectId ?? null;
  sources.project =
    flags.project !== undefined ? "flag" : projectId === null ? "assumed" : ctx.projectId !== undefined ? "context" : "thread";
  let projectName = "";
  if (projectId !== null) {
    const found = deps.caches.projectName(projectId);
    if (found === undefined)
      return {
        exitCode: 2,
        stderr: `check: project ${projectId} is not in the project cache; check the id or retry\n`,
      };
    projectName = found;
  }
  // Only the response with includes carries the environment.
  const threadPath = thread !== null && "environment" in thread ? (thread.environment?.path ?? null) : null;
  const environmentPath =
    flags.path ?? (flags.project === undefined ? (threadPath ?? ctx.cwd ?? null) : null);
  sources.path =
    flags.path !== undefined
      ? "flag"
      : environmentPath === null
        ? "assumed"
        : threadPath ? "thread" : "context";

  const rules = deps.rules();
  const candidatePaths = deps.caches.candidatesFor(environmentPath, projectId);
  const matched = matchRules(rules, activeScopeNamesIn(deps.scopes(), candidatePaths), {
    provider,
    model,
    project: projectName,
    parentThreadId: role === "child" ? "child" : null,
    title,
    candidatePaths,
  });
  const result = compose(
    rules,
    matched,
    deps.skills().map((skill) => skill.name),
  );
  const { decision, pinned } = await checkClaudeProfile(deps.profile, projectId, ctx.threadId);
  const ignored = deps.ignoredSettingScopes();
  const profiles = deps.profiles();
  const payload = {
    target: { provider, model, role, project: projectName, projectId, path: environmentPath, title },
    sources,
    matched: matched.map((index) => ruleLabel(rules[index], index)),
    fullLength: fullLength(rules, matched),
    length: result.text?.length ?? 0,
    limit: INSTRUCTIONS_LIMIT,
    dropped: result.dropped,
    skills: result.skills,
    pluginClaims: matched.flatMap((index) => rules[index].plugins ?? []),
    ignoredSettingScopes: ignored,
    claudeProfile: {
      profilesFile: profiles.state,
      decision:
        decision === null
          ? null
          : {
              status: decision.status,
              dir: decision.pin.dir,
              scope: decision.pin.scope,
              conflict: decision.conflict,
            },
      ...(ctx.threadId === undefined ? {} : { threadId: ctx.threadId, pinned }),
    },
  };
  if (flags.json) return out(payload);
  const target = payload.target;
  const lines = [
    `provider: ${provider} (${sources.provider})`,
    `model: ${model} (${sources.model})`,
    `role: ${role} (${sources.role})`,
    `project: ${projectId === null ? "(none)" : `${projectName} [${projectId}]`} (${sources.project})`,
    `path: ${target.path ?? "(none)"} (${sources.path})`,
    `title: ${title === null ? "(none)" : JSON.stringify(title)} (${sources.title})`,
    "",
    payload.matched.length === 0 ? "matched rules: none" : `matched rules: ${payload.matched.join(", ")}`,
    `length: ${payload.length}/${INSTRUCTIONS_LIMIT}`,
    payload.dropped.length === 0 ? "dropped: none" : `dropped: ${payload.dropped.join(", ")}`,
    `skills: ${payload.skills.join(", ")}`,
    payload.pluginClaims.length === 0
      ? "plugin claims: none"
      : `plugin claims: ${payload.pluginClaims.join(", ")}`,
  ];
  for (const name of ignored) lines.push(ignoredScopeText(name));
  lines.push(...claudeProfileLines(profiles, decision, pinned, ctx.threadId));
  return { exitCode: 0, stdout: lines.join("\n") + "\n" };
}

/** `import` reads at most this many bytes, so a huge file cannot grow the server. */
const IMPORT_LIMIT_BYTES = 1024 * 1024;

type FileText = { text: string } | { error: string };

/** The text of a regular file of at most 1 MiB. Never waits on a FIFO or reads a special file. */
async function readImportFile(file: string): Promise<FileText> {
  try {
    // O_NONBLOCK: opening a FIFO must not wait for a writer. The type is checked on the open handle, so it cannot change after the check.
    const handle = await open(file, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      if (!(await handle.stat()).isFile()) return { error: `import: ${file} is not a regular file` };
      const chunks: Buffer[] = [];
      // `end` is inclusive: one byte past the limit is enough to know the file is too large.
      for await (const chunk of handle.createReadStream({ start: 0, end: IMPORT_LIMIT_BYTES, autoClose: false }))
        chunks.push(chunk as Buffer);
      const bytes = Buffer.concat(chunks);
      if (bytes.length > IMPORT_LIMIT_BYTES) return { error: `import: ${file} is larger than 1 MiB` };
      return { text: bytes.toString("utf8") };
    } finally {
      await handle.close();
    }
  } catch (error) {
    return { error: `import: could not read ${file}: ${(error as Error).message}` };
  }
}

function exportConfig(config: ConfigCli, args: string[]): PluginCliResult {
  if (args.length > 0) return usageError(`export: unknown argument "${args[0]}"`);
  // The saved config is unknown, so an export would look like a valid but empty answer.
  if (config.storageFailed())
    return {
      exitCode: 1,
      stderr: "export: the plugin's storage could not be read at start; reload the plugin (bb plugin reload model-instructions) first\n",
    };
  // A stored config that failed to load is printed as stored, so it can be fixed and imported again.
  const stored = config.storedText();
  return stored === undefined
    ? out(config.saved())
    : {
        exitCode: 0,
        stdout: stored + "\n",
        stderr: "export: the saved config could not be loaded; this is the stored value, not the active config\n",
      };
}

async function importConfigFile(args: string[], ctx: PluginCliContext, config: ConfigCli): Promise<PluginCliResult> {
  if (args.length !== 1) return usageError("import: give one file path");
  let [file] = args;
  if (!path.isAbsolute(file)) {
    if (ctx.cwd === undefined)
      return usageError(`import: ${file} is a relative path and no working directory is known; give an absolute path`);
    file = path.resolve(ctx.cwd, file);
  }
  const read = await readImportFile(file);
  if ("error" in read) return { exitCode: 1, stderr: read.error + "\n" };
  let value: unknown;
  try {
    value = JSON.parse(read.text);
  } catch {
    // The parse error would quote the file's text, so it is not repeated.
    return { exitCode: 1, stderr: `import: ${file}: not valid JSON\n` };
  }
  try {
    const { saved } = await config.importConfig(previousForm(value));
    return {
      exitCode: 0,
      stdout: `imported ${file}: ${saved.rules.length} rules, ${saved.scopes.length} scopes, ${Object.keys(saved.vars).length} vars\n`,
    };
  } catch (error) {
    return { exitCode: 1, stderr: `import: ${(error as Error).message}\n` };
  }
}

export async function runCli(
  argv: string[],
  ctx: PluginCliContext,
  deps: CliDeps,
): Promise<PluginCliResult> {
  const [command = "status", ...rest] = argv;
  if (command === "setup") {
    return setupCommand(deps.setup, rest.filter((arg) => arg !== "--json"), rest.includes("--json"));
  }
  if (command === "unpin") return unpinThread(deps.profile.kv, rest[0], ctx.threadId);
  if (command === "import-dir-skills") {
    return importCommand(
      deps.importDirSkills,
      rest.filter((arg) => arg !== "--json"),
      rest.includes("--json"),
    );
  }
  if (command === "export") return exportConfig(deps.config, rest);
  if (command === "import") return importConfigFile(rest, ctx, deps.config);
  if (command === "status") {
    const json = rest.includes("--json");
    const extra = rest.filter((arg) => arg !== "--json");
    return extra.length > 0
      ? usageError(`status: unknown argument "${extra[0]}"`)
      : await status(deps, json);
  }
  if (command === "check") return check(rest, ctx, deps);
  return usageError(`unknown command "${command}"`);
}
