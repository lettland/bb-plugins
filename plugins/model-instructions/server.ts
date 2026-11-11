import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { budgetReport, cacheProblem, describeType, type Role } from "./src/budget.js";
import { runCli, type OverBudgetRecord, type OverflowEvent } from "./src/cli.js";
import { modelInstructionsRpcContract, type ConfigState } from "./rpc-contract.js";
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
  type ProfileScope,
  type ProfilesState,
} from "./src/profiles-file.js";
import { createCaches } from "./src/projects.js";
import {
  activeScopeNamesIn,
  compose,
  expandConfig,
  matchRules,
  parseLegacyText,
  parseRawConfig,
  ruleLabel,
  SELF_SKILL,
  unresolvedRefs,
  type Config,
  type RawConfig,
} from "./src/rules.js";
import { checkConfig, type SettingsEnv } from "./src/settings.js";
import { loadSkills, type SkillEntry } from "./src/skills.js";
import type { ImportDeps } from "./src/import.js";
import type { SetupDeps } from "./src/setup.js";

/** kv key of the saved config, in the raw form. */
const CONFIG_KEY = "config";
/** kv key of the old `rules` setting text that could not be imported, with the reason. */
const LEGACY_KEY = "legacyRules";
/** kv key that is `true` once the user dismissed the kept old text: the old setting is not imported again. */
const LEGACY_DISMISSED_KEY = "legacyDismissed";

const legacyRecordSchema = z.strictObject({ text: z.string(), error: z.string() });
type LegacyRecord = z.infer<typeof legacyRecordSchema>;

/** A stored config that failed to load at start: the reason, and the stored value as JSON text ("" if it has none). */
interface StoredError {
  message: string;
  text: string;
}

const LEGACY_READ_ERROR = (reason: string) =>
  `the old rules setting could not be read: ${reason}. Restart bb or reload the plugin before you save here: once this form saves, the old setting is no longer imported.`;

const LEGACY_SAVE_ERROR = (reason: string) =>
  `the old rules setting could not be saved: ${reason}. Restart bb or reload the plugin before you save here: once this form saves, the old setting is no longer imported.`;

const STORAGE_READ_ERROR = (reason: string) => `the plugin's storage could not be read: ${reason}`;
/** What every writer says while a start-path read of the plugin's storage has failed. */
const STORAGE_REFUSAL =
  "the plugin's storage could not be read at start; reload the plugin (bb plugin reload model-instructions) before saving";

/** What a start-path read returns when the storage failed; the failure is already recorded. */
const READ_FAILED = Symbol("read failed");

/** Who wrote the config, as the log line names it. */
type WriteSource = "form" | "import" | "import-dir-skills" | "legacy setting";
/** `full` is every save check. `structural` is the parse only, for carrying the old setting over. */
type WriteMode = "full" | "structural";

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

  /** The saved config as stored (unexpanded), and the expanded one the rules run on. */
  let raw: RawConfig = { vars: {}, scopes: [], rules: [] };
  let config: Config = { rules: [], scopes: [] };
  let legacy: LegacyRecord | undefined;
  /** Why the stored config could not be loaded; memory only. Cleared by a full replace (form save or import). */
  let storedError: StoredError | undefined;
  /** Why the old setting could not be read or saved; memory only. Cleared by a full replace (form save or import). */
  let legacyMemoryError: string | undefined;
  /** Why a read of the plugin's storage failed at start; memory only. While set, no writer writes. */
  let storageError: string | undefined;
  let scopes: Scope[] = [];
  /** Saved scopes left out of `scopes` because a profile scope has their name. */
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

  /** Profile scopes come only from profiles.json; the saved config never feeds a Claude profile. */
  const profileScopes = () => (profiles.state === "valid" ? profiles.scopes : []);

  /** The scope list rules see: profile scopes first, then the saved scopes that do not collide with them. */
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

  const checkEnv: SettingsEnv = {
    skillNames,
    scopesFor: (own) => mergeScopes(own, profileScopes()).scopes,
    caches: () => caches.snapshot(),
  };

  /** Takes a config that passed its checks into use; warns for each reference that matches nothing. */
  function adopt(next: RawConfig, parsed: Config): void {
    raw = next;
    config = parsed;
    rebuildScopes();
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

  /** The one validation of a config value, whoever wrote it. Throws the field-specific message. */
  function validate(value: unknown, mode: WriteMode, env: SettingsEnv): { next: RawConfig; parsed: Config } {
    const next = parseRawConfig(value);
    const parsed = expandConfig(next);
    if (mode === "full") {
      const problem = checkConfig(parsed, env);
      if (problem !== null) throw new Error(problem);
    }
    return { next, parsed };
  }

  // Writes run one at a time; a rejected write does not stop the next one.
  let writes: Promise<unknown> = Promise.resolve();
  function enqueue<T>(run: () => Promise<T>): Promise<T> {
    const next = writes.then(run, run);
    writes = next;
    return next;
  }

  /** The write itself: validate, store, apply, re-check the budget, log. Runs inside the queue. */
  async function writeStep(value: unknown, source: WriteSource, mode: WriteMode): Promise<RawConfig> {
    if (storageError !== undefined) throw new Error(STORAGE_REFUSAL);
    const { next, parsed } = validate(value, mode, checkEnv);
    await bb.storage.kv.set(CONFIG_KEY, next);
    legacyMemoryError = undefined;
    storedError = undefined;
    adopt(next, parsed);
    recheckBudget();
    bb.log.info(
      `config saved from ${source}: ${next.rules.length} rules, ${next.scopes.length} scopes, ${Object.keys(next.vars).length} vars`,
    );
    return next;
  }

  /** The only way a config is written. Resolves to what was stored; rejects with the field-specific error. */
  const writeConfig = (value: unknown, source: WriteSource, mode: WriteMode): Promise<RawConfig> =>
    enqueue(() => writeStep(value, source, mode));

  /** Forgets the kept old setting text; runs inside the queue. */
  async function dropLegacy(): Promise<void> {
    await bb.storage.kv.delete(LEGACY_KEY);
    legacy = undefined;
  }

  /** One-time, best effort: moves the old `rules` setting into kv. Structural checks only. Never rejects on a kv failure. */
  async function importLegacySetting(): Promise<void> {
    const dismissed = await startRead<boolean>(LEGACY_DISMISSED_KEY);
    if (dismissed === READ_FAILED) return;
    if (dismissed === true) {
      bb.log.debug("the old rules setting was dismissed; not importing it");
      return;
    }
    let text: unknown;
    try {
      text = (await bb.sdk.plugins.getSettings({ pluginId: bb.pluginId })).values.rules;
    } catch (error) {
      legacyMemoryError = LEGACY_READ_ERROR((error as Error).message);
      bb.log.warn(legacyMemoryError);
      return;
    }
    if (typeof text !== "string" || text.trim() === "") {
      bb.log.debug("no old rules setting to import");
      return;
    }
    let value: RawConfig;
    try {
      value = parseLegacyText(text);
      validate(value, "structural", checkEnv);
    } catch (error) {
      const message = (error as Error).message;
      legacy = { text, error: message };
      bb.log.warn(
        `the old rules setting was not imported: ${message}; its text is kept (bb model-instructions export --legacy)`,
      );
      try {
        await bb.storage.kv.set(LEGACY_KEY, legacy);
      } catch (keepError) {
        bb.log.warn(`the old rules setting could not be kept: ${(keepError as Error).message}`);
      }
      return;
    }
    try {
      await writeConfig(value, "legacy setting", "structural");
    } catch (error) {
      legacyMemoryError = LEGACY_SAVE_ERROR((error as Error).message);
      bb.log.warn(
        `the old rules setting could not be saved: ${(error as Error).message}; it is imported again at the next start`,
      );
    }
  }

  /** A start-path read. A failure is logged and kept as the storage error, and the caller stops loading. */
  async function startRead<T>(key: string): Promise<T | undefined | typeof READ_FAILED> {
    try {
      return await bb.storage.kv.get<T>(key);
    } catch (error) {
      storageError = STORAGE_READ_ERROR((error as Error).message);
      bb.log.warn(storageError);
      return READ_FAILED;
    }
  }

  /** The kept old text from kv; a value of the wrong shape is ignored and deleted. False when the read failed. */
  async function loadKeptLegacy(): Promise<boolean> {
    const kept = await startRead<unknown>(LEGACY_KEY);
    if (kept === READ_FAILED) return false;
    if (kept === undefined) return true;
    const parsed = legacyRecordSchema.safeParse(kept);
    if (parsed.success) {
      legacy = parsed.data;
      return true;
    }
    bb.log.warn("stored old setting text ignored: wrong shape");
    try {
      await bb.storage.kv.delete(LEGACY_KEY);
    } catch (error) {
      bb.log.warn(`stored old setting text could not be removed: ${(error as Error).message}`);
    }
    return true;
  }

  loadProfiles();
  rebuildScopes();
  const stored = (await loadKeptLegacy()) ? await startRead<unknown>(CONFIG_KEY) : READ_FAILED;
  if (stored === READ_FAILED) {
    // The reads stop at the first failure: no rules run, and the legacy import does not.
  } else if (stored === undefined) await importLegacySetting();
  else {
    try {
      const next = parseRawConfig(stored);
      adopt(next, expandConfig(next));
      bb.log.info(`loaded ${config.rules.length} rule(s), ${scopes.length} scope(s)`);
    } catch (error) {
      bb.log.warn(`saved config ignored: ${(error as Error).message}`);
      let text = "";
      try {
        text = JSON.stringify(stored, null, 2);
      } catch {
        // A value that has no JSON text leaves the text block empty.
      }
      storedError = { message: `the saved config could not be loaded: ${(error as Error).message}`, text };
    }
  }

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

  /** A stored config that failed to load wins over the kept old text, which wins over a read error. */
  function loadError(): ConfigState["loadError"] {
    if (storageError !== undefined)
      return {
        kind: "storage",
        message: `${storageError}. Reload the plugin (bb plugin reload model-instructions) before saving.`,
        legacyText: "",
      };
    if (storedError !== undefined)
      return { kind: "stored", message: storedError.message, legacyText: storedError.text };
    if (legacy !== undefined) return { kind: "legacy", message: legacy.error, legacyText: legacy.text };
    if (legacyMemoryError !== undefined) return { kind: "legacy", message: legacyMemoryError, legacyText: "" };
    return null;
  }

  /** What the settings form shows. Never carries a Claude config dir. */
  function state(): ConfigState {
    const snapshot = caches.snapshot();
    return {
      config: raw,
      providers: snapshot.providers.list.map(({ id, models }) => ({ id, models })),
      projects: snapshot.projects.list.map(({ id, name }) => ({ id, name })),
      skills: skills
        .filter((skill) => skill.name !== SELF_SKILL)
        .map(({ name, description }) => ({ name, description })),
      profileScopes: profileScopes().map(({ name, paths }) => ({ name, paths })),
      ignoredScopes,
      cache: {
        providers: { loaded: snapshot.providers.loaded, failed: snapshot.providers.failed },
        projects: { loaded: snapshot.projects.loaded, failed: snapshot.projects.failed },
      },
      overBudget: [...overBudget.values()],
      loadError: loadError(),
    };
  }

  /** Not discoverable: these methods exist for the settings page, not for agents. */
  bb.rpc.register(modelInstructionsRpcContract, {
    async getState() {
      return state();
    },
    async saveConfig({ config: value }) {
      await writeConfig(value, "form", "full");
      return state();
    },
    dismissLegacy() {
      return enqueue(async () => {
        if (storageError !== undefined) throw new Error(STORAGE_REFUSAL);
        // Nothing kept: nothing to dismiss, and the permanent flag stays unset.
        if (legacy === undefined) return state();
        await bb.storage.kv.set(LEGACY_DISMISSED_KEY, true);
        await dropLegacy();
        return state();
      });
    },
  });

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
    exclusive: enqueue,
    current: () => raw,
    storageRefusal: () => (storageError === undefined ? undefined : STORAGE_REFUSAL),
    storedConfigFailed: () => storedError !== undefined,
    validate(candidate, profileScopes: ProfileScope[]) {
      try {
        validate(candidate, "full", {
          ...checkEnv,
          scopesFor: (own) => mergeScopes(own, profileScopes).scopes,
        });
        return null;
      } catch (error) {
        return (error as Error).message;
      }
    },
    // Called from inside the import's own queue step, so it must not queue again.
    async save(candidate) {
      await writeStep(candidate, "import-dir-skills", "full");
    },
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
      {
        name: "export",
        summary: "Print the saved config as JSON, or the kept old setting text",
        usage: "bb model-instructions export [--legacy]",
      },
      {
        name: "import",
        summary: "Replace the saved config with the config in a JSON file",
        usage: "bb model-instructions import <file>",
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
        config: {
          saved: () => raw,
          legacyText: () => legacy?.text,
          storedText: () => storedError?.text,
          storageFailed: () => storageError !== undefined,
          importConfig: (value) =>
            enqueue(async () => {
              const stored = await writeStep(value, "import", "full");
              try {
                await dropLegacy();
              } catch (error) {
                const message = (error as Error).message;
                bb.log.warn(`the kept old setting text could not be removed: ${message}`);
                // The import succeeded: the form must not keep a banner for text that no longer matters.
                legacy = undefined;
                return { saved: stored, keptTextError: message };
              }
              return { saved: stored };
            }),
        },
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
