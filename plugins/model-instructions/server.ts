import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { backupRules } from "./src/backup.js";
import { budgetReport, cacheProblem, describeType, type Role } from "./src/budget.js";
import { runCli, type OverBudgetRecord, type OverflowEvent } from "./src/cli.js";
import { modelInstructionsRpcContract, type ConfigState, type LoadError } from "./rpc-contract.js";
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
  isEmptyConfig,
  matchRules,
  parseLegacyText,
  parseRawConfig,
  ruleLabel,
  sameConfig,
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
/** kv key that is `true` once the rules of the previous versions are moved; the setting is then no longer declared. */
const DONE_KEY = "previousSettingDone";
/** kv key that is `true` once an `import` succeeded while the move was not finished: the user's own choice, kept across restarts. */
const IMPORTED_KEY = "previousImported";
/** kv keys written by v0.1.12, removed once at the start of the move. */
const V012_RULES_KEY = "legacyRules";
const V012_DISMISSED_KEY = "legacyDismissed";

const v012RecordSchema = z.looseObject({ text: z.string() });

/** A stored config that failed to load at start: the reason, and the stored value as JSON text ("" if it has none). */
interface StoredError {
  message: string;
  text: string;
}

/** The two banners the move of the previous rules can leave; `migration` without a copy has no backup path. */
type PendingMove = Exclude<LoadError, { kind: "storage" } | { kind: "stored" }>;
/** What can settle a pending move: a form save, an import, or the button. */
type Resolution = "form" | "import" | "keep";

const BACKUP_FAILED = (reason: string) =>
  `could not back up the rules from the previous version: ${reason}; nothing was changed, it is tried again at the next start`;
const MOVE_FAILED = (reason: string) =>
  `the rules from the previous version could not be moved: ${reason}; it is tried again at the next start`;
const NOT_EMPTIED = (reason: string) =>
  `the setting with the rules from the previous version could not be emptied: ${reason}; it is tried again at the next start`;
const NOT_READ = (backupPath: string) =>
  `the rules from the previous version could not be read and rules are already saved here; a copy is in ${backupPath}`;
const NO_COPY_MESSAGE = (reason: string) =>
  `${reason}. No copy could be made; the rules are still in the plugin's settings and the move is tried again at the next start.`;
const COPY_MESSAGE = (reason: string, backupPath: string) =>
  `${reason}. A copy is in ${backupPath}. Fix it there and run bb model-instructions import ${backupPath}.`;
const SAVE_FAILED_MESSAGE = (reason: string, backupPath: string) =>
  `the rules could not be saved: ${reason}. A copy is in ${backupPath}; the move is tried again at the next start, or run bb model-instructions import ${backupPath}.`;
const CONFLICT_MESSAGE = (backupPath: string) =>
  `A copy of the previous rules is in ${backupPath}. To replace the rules saved here with them, run bb model-instructions import ${backupPath}; to keep the rules saved here, press Keep the rules saved here.`;

const STORAGE_READ_ERROR = (reason: string) => `the plugin's storage could not be read: ${reason}`;
/** What every writer says while a start-path read of the plugin's storage has failed. */
const STORAGE_REFUSAL =
  "the plugin's storage could not be read at start; reload the plugin (bb plugin reload model-instructions) before saving";

/** What a start-path read returns when the storage failed; the failure is already recorded. */
const READ_FAILED = Symbol("read failed");

/** Who wrote the config, as the log line names it. */
type WriteSource = "form" | "import" | "import-dir-skills" | "previous setting";
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
  /** True once a config is stored: at start, or by a write. */
  let hasStored = false;
  /** Why the stored config could not be loaded; memory only. Cleared by a full replace (form save or import). */
  let storedError: StoredError | undefined;
  /** The banner for the rules of the previous version; memory only. */
  let pending: PendingMove | undefined;
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
    hasStored = true;
    storedError = undefined;
    adopt(next, parsed);
    recheckBudget();
    bb.log.info(
      `config saved from ${source}: ${next.rules.length} rules, ${next.scopes.length} scopes, ${Object.keys(next.vars).length} vars`,
    );
    return next;
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

  /** The setting of the previous versions. Declared only while its rules are not moved; bb returns a setting only while it is declared. */
  const defineRulesSetting = () =>
    bb.settings.define({
      rules: {
        type: "string",
        label: "Rules (previous versions)",
        description:
          "Moved into the form below automatically, then removed. If the form shows a banner about it, the move is waiting for you. A copy is kept in ~/.bb/model-instructions/backups/. Edits here are not read after the move.",
        experimental_multiline: true,
        default: "",
      },
    });
  type RulesSetting = ReturnType<typeof defineRulesSetting>;

  const backupDir = path.join(home, ".bb", "model-instructions", "backups");

  /**
   * The move of the rules of the previous versions into the saved config: back up, move, empty the setting,
   * set the flag. Everything runs from the background service, never from the factory: bb answers a read of
   * the setting with 404 until the factory has finished. Returns what the service and the form need.
   */
  function previousSettingMigration(setting: RulesSetting) {
    /** True once the flag is set in this process: an `import` after that needs no record. */
    let settled = false;

    /** Step d: empties the setting and reads it back. False, with a warning, when it is not empty. */
    async function emptySetting(): Promise<boolean> {
      let reason: string;
      try {
        await setting.experimental_set({ rules: null });
        if ((await setting.get()).rules.trim() === "") return true;
        reason = "the setting still holds a value";
      } catch (error) {
        reason = (error as Error).message;
      }
      bb.log.warn(NOT_EMPTIED(reason));
      return false;
    }

    /** Sets the flag, then removes the record of an early import. A leftover record does nothing once the flag is set. */
    async function markDone(): Promise<void> {
      await bb.storage.kv.set(DONE_KEY, true);
      settled = true;
      try {
        await bb.storage.kv.delete(IMPORTED_KEY);
      } catch (error) {
        bb.log.warn(`could not remove the record that the rules were imported: ${(error as Error).message}`);
      }
    }

    /** Steps d and e: empties the setting, then sets the flag. */
    async function finishMove(backupPath: string, outcome: "moved" | "already saved" | "imported"): Promise<void> {
      if (!(await emptySetting())) return;
      await markDone();
      bb.log.info(
        {
          moved: `rules from the previous version moved: backup ${backupPath}`,
          "already saved": `rules from the previous version already saved; backup ${backupPath}`,
          imported: `rules from the previous version not moved: rules were imported; backup ${backupPath}`,
        }[outcome],
      );
    }

    /** Backs up and removes what v0.1.12 kept in kv. False when the move must wait for the next start. */
    async function removeV012Keys(): Promise<boolean> {
      const record = await bb.storage.kv.get<unknown>(V012_RULES_KEY);
      const kept = v012RecordSchema.safeParse(record);
      if (kept.success) {
        try {
          backupRules(backupDir, kept.data.text);
        } catch (error) {
          const message = (error as Error).message;
          bb.log.warn(BACKUP_FAILED(message));
          pending = {
            kind: "migration",
            message: NO_COPY_MESSAGE(`the rules text saved by version 0.1.12 could not be backed up: ${message}`),
            backupPath: null,
          };
          return false;
        }
      } else if (record !== undefined) {
        // It holds no usable text, so there is nothing to back up.
        bb.log.warn("stored rules record of an earlier version ignored: wrong shape");
      }
      if (record !== undefined) await bb.storage.kv.delete(V012_RULES_KEY);
      await bb.storage.kv.delete(V012_DISMISSED_KEY);
      return true;
    }

    /** Steps a to e, decided from the current state. Runs inside the write queue. */
    async function migrate(): Promise<void> {
      if (!(await removeV012Keys())) return;
      const text = (await setting.get()).rules;
      const blank = text.trim() === "";
      let old: RawConfig | undefined;
      let reason = "";
      if (!blank) {
        try {
          const parsed = parseLegacyText(text);
          validate(parsed, "structural", checkEnv);
          old = parsed;
        } catch (error) {
          reason = (error as Error).message;
        }
      }
      // a. Nothing to move.
      if (blank || (old !== undefined && isEmptyConfig(old))) {
        if (blank || (await emptySetting())) {
          await markDone();
          bb.log.debug("no rules from the previous version to move");
        }
        return;
      }
      // A stored config that failed to load: change nothing, not even a backup.
      if (storedError !== undefined) return;
      // Read before the backup: a read that keeps failing then writes no backup at each start.
      // Only the path that compares the old text with a saved config uses it.
      const previousImported =
        hasStored && !isEmptyConfig(raw) && old !== undefined
          ? await bb.storage.kv.get<boolean>(IMPORTED_KEY)
          : false;
      // b. Back up.
      let backupPath: string;
      try {
        backupPath = backupRules(backupDir, text);
      } catch (error) {
        const message = (error as Error).message;
        bb.log.warn(BACKUP_FAILED(message));
        pending = { kind: "migration", message: NO_COPY_MESSAGE(message), backupPath: null };
        return;
      }
      // c. Decide. An empty saved config counts as none.
      if (!hasStored || isEmptyConfig(raw)) {
        if (old === undefined) {
          pending = { kind: "migration", message: COPY_MESSAGE(reason, backupPath), backupPath };
          return;
        }
        try {
          await writeStep(old, "previous setting", "structural");
        } catch (error) {
          const message = (error as Error).message;
          bb.log.warn(MOVE_FAILED(message));
          pending = {
            kind: "migration",
            message: SAVE_FAILED_MESSAGE(message, backupPath),
            backupPath,
          };
          return;
        }
        await finishMove(backupPath, "moved");
      } else if (old === undefined) {
        bb.log.warn(NOT_READ(backupPath));
        await finishMove(backupPath, "already saved");
      } else if (previousImported === true) {
        await finishMove(backupPath, "imported");
      } else if (sameConfig(old, raw)) {
        await finishMove(backupPath, "already saved");
      } else {
        pending = { kind: "conflict", message: CONFLICT_MESSAGE(backupPath), backupPath };
      }
    }

    /** Settles a pending move after the saved config was replaced or the user chose: the backup exists, so steps d and e run. */
    async function resolve(by: Resolution): Promise<void> {
      if (by === "import" && !settled) {
        try {
          await bb.storage.kv.set(IMPORTED_KEY, true);
        } catch (error) {
          bb.log.warn(`could not record that the rules were imported: ${(error as Error).message}`);
        }
      }
      const current = pending;
      if (current === undefined || current.backupPath === null) return;
      if (current.kind === "migration" ? by === "keep" : by === "form") return;
      pending = undefined;
      try {
        await finishMove(current.backupPath, "moved");
      } catch (error) {
        bb.log.warn(MOVE_FAILED((error as Error).message));
      }
    }

    bb.background.service("previous-setting", {
      async start(signal) {
        try {
          await enqueue(migrate);
        } catch (error) {
          bb.log.warn(MOVE_FAILED((error as Error).message));
        }
        // Returning early or throwing would make bb restart the service.
        await new Promise<void>((resolveStart) => {
          if (signal.aborted) resolveStart();
          else signal.addEventListener("abort", () => resolveStart(), { once: true });
        });
      },
    });

    return resolve;
  }

  /** Settles a pending move of the previous rules; does nothing once they are moved. */
  let resolvePrevious: (by: Resolution) => Promise<void> = async () => {};

  loadProfiles();
  rebuildScopes();
  const done = await startRead<boolean>(DONE_KEY);
  const stored = done === READ_FAILED ? READ_FAILED : await startRead<unknown>(CONFIG_KEY);
  if (stored === READ_FAILED) {
    // The reads stop at the first failure: no rules run, and nothing is moved.
  } else {
    if (stored !== undefined) {
      hasStored = true;
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
    // Declared after the awaits above, so bb has the setting once the factory has finished.
    if (done !== true) resolvePrevious = previousSettingMigration(defineRulesSetting());
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

  /** The storage error wins over a stored config that failed to load, which wins over the move of the previous rules. */
  function loadError(): ConfigState["loadError"] {
    if (storageError !== undefined)
      return {
        kind: "storage",
        message: `${storageError}. Reload the plugin (bb plugin reload model-instructions) before saving.`,
      };
    if (storedError !== undefined) return { kind: "stored", message: storedError.message, text: storedError.text };
    return pending ?? null;
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
    saveConfig({ config: value }) {
      return enqueue(async () => {
        await writeStep(value, "form", "full");
        await resolvePrevious("form");
        return state();
      });
    },
    keepSavedRules() {
      return enqueue(async () => {
        await resolvePrevious("keep");
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
        summary: "Print the saved config as JSON",
        usage: "bb model-instructions export",
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
          storedText: () => storedError?.text,
          storageFailed: () => storageError !== undefined,
          importConfig: (value) =>
            enqueue(async () => {
              const saved = await writeStep(value, "import", "full");
              await resolvePrevious("import");
              return { saved };
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
