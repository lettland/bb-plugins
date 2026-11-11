import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { budgetReport, cacheProblem, describeType, type Role } from "./src/budget.js";
import { runCli, type OverBudgetRecord, type OverflowEvent } from "./src/cli.js";
import { buildScope, type Scope } from "./src/paths.js";
import {
  isDirectory,
  PROJECT_LOOKUP_TIMEOUT_MS,
  resolveClaudeEnv,
  warnMissingConfigDirs,
  withTimeout,
  type ClaudeProfileDeps,
} from "./src/profile.js";
import {
  ignoredScopeText,
  mergeScopes,
  profilesFile,
  readProfiles,
  type ProfilesState,
} from "./src/profiles-file.js";
import { createCaches } from "./src/projects.js";
import {
  activeScopeNamesIn,
  compose,
  matchRules,
  parseConfig,
  ruleLabel,
  unresolvedRefs,
  type Config,
} from "./src/rules.js";
import { createRulesSettingSchema, settingProblem, type SettingsEnv } from "./src/settings.js";
import { loadSkills, type SkillEntry } from "./src/skills.js";
import type { ImportDeps } from "./src/import.js";
import type { SetupDeps } from "./src/setup.js";

const OVERFLOW_EVENTS_KEPT = 20;
const OVERFLOW_SEEN_KEPT = 1000;

function pluginRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.basename(here) === "dist" ? path.dirname(here) : here;
}

export default async function plugin(bb: BbPluginApi) {
  let skills: SkillEntry[] = [];
  try {
    skills = loadSkills(path.join(pluginRoot(), "skills"));
  } catch (error) {
    bb.log.warn(
      `bundled skills not loaded: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const skillNames = () => skills.map((skill) => skill.name);

  const home = homedir();
  const profilesPath = profilesFile(home);

  let config: Config = { rules: [], scopes: [] };
  let scopes: Scope[] = [];
  /** Setting scopes left out of `scopes` because a profile scope has their name. */
  let ignoredScopes: string[] = [];
  let profiles: ProfilesState = { state: "absent" };
  const overBudget = new Map<string, OverBudgetRecord>();
  const overflowSeen = new Set<string>();
  const overflowEvents: OverflowEvent[] = [];

  /** Names the thread types that are over the limit now; logs the ones that were not before. */
  function recheckBudget(): void {
    const snapshot = caches.snapshot();
    if (cacheProblem(snapshot) !== null) return;
    const { overflowing } = budgetReport(config.rules, scopes, snapshot);
    const current = new Map(
      overflowing.map((type) => [
        JSON.stringify([type.provider, type.model, type.role, type.project]),
        type,
      ]),
    );
    for (const key of [...overBudget.keys()])
      if (!current.has(key)) overBudget.delete(key);
    for (const [key, type] of current) {
      const known = overBudget.get(key);
      if (known !== undefined) {
        overBudget.set(key, { ...type, since: known.since });
        continue;
      }
      overBudget.set(key, { ...type, since: new Date().toISOString() });
      bb.log.warn(
        `over budget: ${describeType(type)}; the rules would be cut at runtime`,
      );
    }
  }

  const caches = createCaches(bb, recheckBudget);

  /** Profile scopes come only from profiles.json; the `rules` setting never feeds a Claude profile. */
  const profileScopes = () => (profiles.state === "valid" ? profiles.scopes : []);

  /** The scope list rules see: profile scopes first, then the setting's scopes that do not collide with them. */
  function rebuildScopes(): void {
    const merged = mergeScopes(
      config.scopes.map((scope) => buildScope(scope)),
      profileScopes(),
    );
    scopes = merged.scopes;
    ignoredScopes = merged.ignored;
    for (const name of ignoredScopes) bb.log.warn(ignoredScopeText(name));
  }

  /** Reads profiles.json: at startup, and again after `setup` or `import-dir-skills` writes it. A reload of the plugin re-runs this too. */
  function loadProfiles(): void {
    profiles = readProfiles(profilesPath, home);
    if (profiles.state === "malformed")
      bb.log.warn(
        `profiles.json is malformed and ignored: ${profiles.message}; no new Claude profile is pinned until it is fixed (existing pins still apply; rules and skills are unaffected)`,
      );
    else if (profiles.state === "absent")
      bb.log.info(
        "profiles.json is absent: a thread without a pin gets no CLAUDE_CONFIG_DIR, and no pin is written",
      );
    else {
      bb.log.info(`loaded ${profiles.scopes.length} profile scope(s) from profiles.json`);
      warnMissingConfigDirs(profiles.scopes, bb.log);
    }
  }

  function reloadProfiles(): void {
    loadProfiles();
    rebuildScopes();
    recheckBudget();
  }

  const settingsEnv: SettingsEnv = {
    skillNames,
    scopesFor: (own) => mergeScopes(own, profileScopes()).scopes,
    caches: () => caches.snapshot(),
  };

  const settings = bb.settings.define({
    rules: {
      type: "string",
      label: "Rules",
      description:
        'JSON array of rules, or an object { "vars"?, "scopes"?, "rules" }. See the plugin README; run `bb model-instructions status` to inspect and `bb model-instructions check` to try a thread.',
      experimental_multiline: true,
      experimental_schema: createRulesSettingSchema(settingsEnv),
      default: "[]",
    },
  });

  function load(json: string): void {
    try {
      config = parseConfig(json);
    } catch (error) {
      config = { rules: [], scopes: [] };
      rebuildScopes();
      bb.log.warn(
        // v8 ignore next -- @preserve parseConfig only throws Error, so the non-Error arm is unreachable.
        `rules setting ignored: ${error instanceof Error ? error.message : String(error)}`,
      );
      return;
    }
    rebuildScopes();
    bb.log.info(
      `loaded ${config.rules.length} rule(s), ${scopes.length} scope(s)`,
    );
    const unresolved = new Map<number, string[]>();
    for (const ref of unresolvedRefs(
      config.rules,
      scopes.map((scope) => scope.name),
      skillNames(),
    )) {
      const list = unresolved.get(ref.index) ?? [];
      list.push(`${ref.kind} "${ref.glob}"`);
      unresolved.set(ref.index, list);
    }
    for (const [index, refs] of unresolved)
      bb.log.warn(
        `${ruleLabel(config.rules[index], index)}: ${refs.join(", ")} match nothing`,
      );
  }

  loadProfiles();
  load((await settings.get()).rules);
  settings.onChange((next) => {
    load(next.rules);
    recheckBudget();
  });

  bb.agents.configure((context) => {
    const role: Role = context.thread.parentThreadId === null ? "top-level" : "child";
    // The paths come back normalized: the checkouts were at the last refresh, the environment path just now.
    const candidatePaths = caches.candidatesFor(
      context.environment.path,
      context.project.id,
    );
    const matched = matchRules(config.rules, activeScopeNamesIn(scopes, candidatePaths), {
      provider: context.provider.id,
      model: context.provider.model,
      project: context.project.name,
      parentThreadId: context.thread.parentThreadId,
      title: context.thread.title,
      candidatePaths,
    });
    const resolved = compose(config.rules, matched, skillNames());
    if (resolved.dropped.length > 0) {
      const key = JSON.stringify([context.thread.id, resolved.dropped]);
      if (!overflowSeen.has(key)) {
        if (overflowSeen.size >= OVERFLOW_SEEN_KEPT)
          overflowSeen.delete(overflowSeen.values().next().value!);
        overflowSeen.add(key);
        bb.log.warn(
          `thread ${context.thread.id} (${context.provider.id} ${context.provider.model}, ${role}) lost rules over the limit: ${resolved.dropped.join(", ")}`,
        );
        overflowEvents.push({
          time: new Date().toISOString(),
          threadId: context.thread.id,
          provider: context.provider.id,
          model: context.provider.model,
          role,
          project: context.project.name,
          dropped: resolved.dropped,
          lengths: resolved.droppedLengths,
        });
        if (overflowEvents.length > OVERFLOW_EVENTS_KEPT)
          overflowEvents.shift();
      }
    }
    return {
      tools: [],
      skills: resolved.skills,
      ...(resolved.text === null ? {} : { instructions: resolved.text }),
    };
  });

  const profileDeps: ClaudeProfileDeps = {
    get profiles() {
      return profiles;
    },
    log: bb.log,
    kv: bb.storage.kv,
    isDir: isDirectory,
    async sourcesFor(projectId) {
      if (caches.sourcesOf(projectId) === undefined)
        await withTimeout(caches.refresh(), PROJECT_LOOKUP_TIMEOUT_MS);
      return caches.sourcesOf(projectId);
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

  const setupDeps: SetupDeps = {
    home,
    profilesFile: profilesPath,
    sdk: bb.sdk,
    kv: bb.storage.kv,
    log: bb.log,
    reload: reloadProfiles,
  };

  const importDeps: ImportDeps = {
    home,
    scopesFile: path.join(home, ".bb", "dir-skills", "scopes.json"),
    exportFile: path.join(home, ".bb", "dir-skills", "export.json"),
    profilesFile: profilesPath,
    skillNames,
    getRules: async () => (await settings.get()).rules,
    setRules: async (json) => {
      await settings.experimental_set({ rules: json });
    },
    validate: (json, profileScopes) =>
      settingProblem(json, {
        ...settingsEnv,
        scopesFor: (own) => mergeScopes(own, profileScopes).scopes,
      }),
    reloadProfiles,
    kv: bb.storage.kv,
    log: bb.log,
  };

  bb.cli.register({
    name: "model-instructions",
    summary: "Show the instruction rules, Claude profiles and pins, and check what a thread would receive",
    commands: [
      {
        name: "status",
        summary: "List scopes, rules, skills, the cache state and overflows",
        usage: "bb model-instructions status [--json]",
      },
      {
        name: "check",
        summary: "Show the rules, length and skills a thread would get",
        usage:
          "bb model-instructions check [--provider P] [--model M] [--child | --top-level] [--project <id>] [--path <dir>] [--title T] [--json] | check --all [--json]",
      },
      {
        name: "setup",
        summary: "Create profiles.json from detected work settings when it is missing",
        usage: "bb model-instructions setup [--dry-run] [--json]",
      },
      {
        name: "unpin",
        summary: "Forget a thread's pinned Claude profile",
        usage: "bb model-instructions unpin [<thread-id>]",
      },
      {
        name: "import-dir-skills",
        summary: "Import dir-skills scopes, skill claims and pins from ~/.bb/dir-skills",
        usage: "bb model-instructions import-dir-skills [--dry-run] [--json]",
      },
    ],
    run: (argv, ctx) =>
      runCli(argv, ctx, {
        rules: () => config.rules,
        scopes: () => scopes,
        skills: () => skills,
        caches,
        overBudget: () => [...overBudget.values()],
        events: () => overflowEvents,
        threads: bb.sdk.threads,
        profiles: () => profiles,
        profilesFile: profilesPath,
        ignoredSettingScopes: () => ignoredScopes,
        profile: profileDeps,
        setup: setupDeps,
        importDirSkills: importDeps,
      }),
  });
  // Registered first, so the rules apply at once; the first refresh must not hold them up.
  // Scope matching through project checkouts starts working when the project list loads.
  caches.refresh().catch((error) => {
    bb.log.warn(
      `cache refresh failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  });
}
