import { readFileSync } from "node:fs";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { pinKey, type ConfigDirPin } from "./profile.js";
import {
  parseProfiles,
  profileDefProblem,
  readProfiles,
  writeProfilesFile,
  type ProfileDef,
  type ProfileScope,
  type ProfilesState,
} from "./profiles-file.js";
import { globToRegExp, nameSchema, parseConfig, scopeSchema, SELF_SKILL } from "./rules.js";

/** The fixed files `import-dir-skills` reads, as the messages name them. */
export const SCOPES_FILE_LABEL = "~/.bb/dir-skills/scopes.json";
export const EXPORT_FILE_LABEL = "~/.bb/dir-skills/export.json";

export interface ImportDeps {
  home: string;
  /** Absolute path of ~/.bb/dir-skills/scopes.json (may be absent). */
  scopesFile: string;
  /** Absolute path of ~/.bb/dir-skills/export.json (required). */
  exportFile: string;
  /** Absolute path of ~/.bb/model-instructions/profiles.json. */
  profilesFile: string;
  /** Names of the bundled skills. */
  skillNames(): string[];
  /** The stored `rules` setting text. */
  getRules(): Promise<string>;
  /** Writes the `rules` setting through the SDK; the save-time schema check runs and may throw. */
  setRules(json: string): Promise<void>;
  /** The save-time check of a candidate setting, with the profile scopes it would run against. Null when it passes. */
  validate(json: string, profileScopes: ProfileScope[]): string | null;
  /** Re-reads profiles.json into the running plugin. */
  reloadProfiles(): void;
  kv: Pick<BbPluginApi["storage"]["kv"], "get" | "set">;
  log: Pick<BbPluginApi["log"], "info" | "warn">;
}

export interface SkippedItem {
  kind: "scope" | "profile-scope" | "rule" | "skills";
  name: string;
  reason: string;
}

export interface ImportReport {
  dryRun: boolean;
  /** The state of profiles.json before this run. */
  profilesFile: ProfilesState["state"];
  profileScopes: ProfileDef[];
  settingScopes: Array<{ name: string; paths: string[] }>;
  rules: Array<{ name: string; scope: string; skills: string[] }>;
  /** Whether the `rules` setting is (or would be) written. */
  settingChanged: boolean;
  pins: {
    imported: Array<{ threadId: string; pin: ConfigDirPin }>;
    kept: string[];
    rejected: Array<{ threadId: string; reason: string }>;
  };
  skipped: SkippedItem[];
}

/** A failure that stops the import before anything more is written. */
class ImportError extends Error {
  constructor(readonly lines: string[]) {
    super(lines.join("\n"));
  }
}

interface SourceScope {
  name: string;
  paths: string[];
  skills: string[];
  claudeConfigDir?: string;
}

const nonEmptyStrings = z.array(z.string().trim().min(1)).min(1);

const fileScopeSchema = z.object({
  // Where learned: zod 4 treats a missing key of z.unknown() as an error unless it is .optional();
  // dir-skills read a scope with no name as `scope-N`, and the import keeps that (see the scope-N test).
  name: z.unknown().optional(),
  paths: nonEmptyStrings,
  skills: nonEmptyStrings,
  claudeConfigDir: z.string().trim().min(1).optional(),
});

const uiScopeSchema = z.strictObject({
  name: z.string(),
  paths: z.array(z.string()),
  skills: z.array(z.string()),
});

const pinSchema = z.strictObject({
  threadId: z.string().min(1),
  pin: z.strictObject({
    dir: z.string().min(1).nullable(),
    scope: z.string().min(1).nullable(),
    reason: z.enum(["unknown-project", "missing-dir"]).optional(),
  }),
});

const exportSchema = z.object({
  uiScopes: z.array(uiScopeSchema),
  pins: z.array(z.unknown()),
});

function parseJson(text: string, label: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new ImportError([`${label}: not valid JSON`]);
  }
}

/** The scopes of ~/.bb/dir-skills/scopes.json, read like dir-skills read them (a missing name becomes `scope-N`). */
function parseFileScopes(text: string): SourceScope[] {
  const raw = parseJson(text, SCOPES_FILE_LABEL);
  if (typeof raw !== "object" || raw === null || !Array.isArray((raw as { scopes?: unknown }).scopes))
    throw new ImportError([`${SCOPES_FILE_LABEL}: expected { "scopes": [...] }`]);
  return (raw as { scopes: unknown[] }).scopes.map((entry, index) => {
    const parsed = fileScopeSchema.safeParse(entry);
    if (!parsed.success)
      throw new ImportError([`${SCOPES_FILE_LABEL}: scope ${index + 1}: ${z.prettifyError(parsed.error)}`]);
    const { name, paths, skills, claudeConfigDir } = parsed.data;
    return {
      name: typeof name === "string" && name.trim() !== "" ? name.trim() : `scope-${index + 1}`,
      paths: paths.map((p) => p.trim()),
      skills: skills.map((s) => s.trim()),
      ...(claudeConfigDir === undefined ? {} : { claudeConfigDir }),
    };
  });
}

function readText(file: string, label: string, required: boolean): string | null {
  try {
    return readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      if (required)
        throw new ImportError([`import-dir-skills: ${label} not found; run bb dir-skills export first`]);
      return null;
    }
    throw new ImportError([`import-dir-skills: could not read ${label}: ${(error as Error).message}`]);
  }
}

const sameList = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((value, index) => value === b[index]);

/** The example scope dir-skills shipped in its scopes.json; it is never imported. */
function isShippedExample(scope: SourceScope): boolean {
  return (
    scope.claudeConfigDir === undefined &&
    scope.name === "work" &&
    sameList(scope.paths, ["~/workspace/work"]) &&
    sameList(scope.skills, ["work-*"])
  );
}

const ruleNameOf = (scope: string) => `dir-skills:${scope}`;

interface Plan {
  report: Omit<ImportReport, "dryRun">;
  /** The profile scopes in force after the run, for the validation and the pin check. */
  finalProfileScopes: ProfileScope[];
  /** The new `rules` setting text, or null when nothing is added. */
  settingJson: string | null;
}

async function buildPlan(deps: ImportDeps): Promise<Plan> {
  const exportText = readText(deps.exportFile, EXPORT_FILE_LABEL, true)!;
  const parsedExport = exportSchema.safeParse(parseJson(exportText, EXPORT_FILE_LABEL));
  if (!parsedExport.success)
    throw new ImportError([`${EXPORT_FILE_LABEL}: ${z.prettifyError(parsedExport.error)}`]);
  const scopesText = readText(deps.scopesFile, SCOPES_FILE_LABEL, false);
  const fileScopes = scopesText === null ? [] : parseFileScopes(scopesText);

  const skipped: SkippedItem[] = [];
  // dir-skills precedence: the file's scopes, then the UI scopes; a UI scope never replaces a profile scope.
  const merged = new Map<string, SourceScope>();
  for (const scope of fileScopes) {
    if (isShippedExample(scope)) {
      skipped.push({ kind: "scope", name: scope.name, reason: "the shipped dir-skills example scope is never imported" });
      continue;
    }
    merged.set(scope.name, scope);
  }
  for (const ui of parsedExport.data.uiScopes) {
    const scope: SourceScope = { name: ui.name.trim(), paths: ui.paths.map((p) => p.trim()), skills: ui.skills.map((s) => s.trim()) };
    if (isShippedExample(scope)) {
      skipped.push({ kind: "scope", name: scope.name, reason: "the shipped dir-skills example scope is never imported" });
      continue;
    }
    if (merged.get(scope.name)?.claudeConfigDir !== undefined) {
      skipped.push({
        kind: "scope",
        name: scope.name,
        reason: `a UI scope never replaces the profile scope of the same name in ${SCOPES_FILE_LABEL}`,
      });
      continue;
    }
    merged.set(scope.name, scope);
  }

  // Names and paths are checked before anything is written; a bad one is listed for the user to rename.
  const problems: string[] = [];
  for (const scope of merged.values()) {
    const found =
      scope.claudeConfigDir === undefined
        ? (() => {
            const parsed = scopeSchema.safeParse({ name: scope.name, paths: scope.paths });
            return parsed.success ? null : z.prettifyError(parsed.error);
          })()
        : profileDefProblem(
            { name: scope.name, paths: scope.paths, claudeConfigDir: scope.claudeConfigDir },
            deps.home,
          );
    if (found !== null) problems.push(`scope ${JSON.stringify(scope.name)}: ${found}`);
    else if (!nameSchema.safeParse(ruleNameOf(scope.name)).success)
      problems.push(`scope ${JSON.stringify(scope.name)}: the rule name ${JSON.stringify(ruleNameOf(scope.name))} is too long`);
  }
  if (problems.length > 0)
    throw new ImportError([
      "import-dir-skills: these scopes break the rules for names, paths or profile directories; fix them in the source files and run again (nothing was written):",
      ...problems.map((line) => `  ${line}`),
    ]);

  // The current setting must parse; it is rewritten from its raw JSON so no key or rule changes.
  const settingText = await deps.getRules();
  let current;
  try {
    current = parseConfig(settingText);
  } catch (error) {
    throw new ImportError([
      `import-dir-skills: the rules setting does not parse (${(error as Error).message}); fix it first (nothing was written)`,
    ]);
  }
  const raw = JSON.parse(settingText) as unknown;
  const takenScopes = new Set(current.scopes.map((scope) => scope.name));
  const takenRules = new Set(current.rules.flatMap((rule) => (rule.name === undefined ? [] : [rule.name])));

  // Profile scopes: only into a profiles.json that does not exist yet.
  const profilesState = readProfiles(deps.profilesFile, deps.home);
  const profileDefs: ProfileDef[] = [];
  const usable = new Set<string>();
  for (const scope of merged.values()) {
    if (scope.claudeConfigDir === undefined) continue;
    const def: ProfileDef = { name: scope.name, paths: scope.paths, claudeConfigDir: scope.claudeConfigDir };
    if (profilesState.state === "absent") {
      profileDefs.push(def);
      usable.add(scope.name);
      continue;
    }
    if (profilesState.state === "malformed") {
      skipped.push({
        kind: "profile-scope",
        name: scope.name,
        reason: "profiles.json exists but is malformed; fix or remove it, then run again",
      });
      continue;
    }
    const [wanted] = parseProfiles(JSON.stringify({ scopes: [def] }), deps.home);
    const there = profilesState.scopes.find((existing) => existing.name === scope.name);
    if (
      there !== undefined &&
      there.claudeConfigDir === wanted.claudeConfigDir &&
      sameList(there.paths, wanted.paths)
    ) {
      skipped.push({ kind: "profile-scope", name: scope.name, reason: "profiles.json already has this scope" });
      usable.add(scope.name);
    } else
      skipped.push({
        kind: "profile-scope",
        name: scope.name,
        reason: "profiles.json already exists and is never overwritten",
      });
  }
  const finalProfileScopes =
    profilesState.state === "valid"
      ? profilesState.scopes
      : profileDefs.length === 0
        ? []
        : parseProfiles(JSON.stringify({ scopes: profileDefs }), deps.home);
  const profileNames = new Set(finalProfileScopes.map((scope) => scope.name));

  const settingScopes: ImportReport["settingScopes"] = [];
  for (const scope of merged.values()) {
    if (scope.claudeConfigDir !== undefined) continue;
    if (profileNames.has(scope.name))
      skipped.push({
        kind: "scope",
        name: scope.name,
        reason: "a profile scope with that name comes from profiles.json, so a setting scope of that name would be ignored",
      });
    else if (takenScopes.has(scope.name))
      skipped.push({ kind: "scope", name: scope.name, reason: "the rules setting already has a scope with that name" });
    else {
      settingScopes.push({ name: scope.name, paths: scope.paths });
      usable.add(scope.name);
    }
  }

  const bundled = deps.skillNames().filter((name) => name !== SELF_SKILL);
  const rules: ImportReport["rules"] = [];
  for (const scope of merged.values()) {
    if (!usable.has(scope.name)) continue;
    const name = ruleNameOf(scope.name);
    if (takenRules.has(name)) {
      skipped.push({ kind: "rule", name, reason: "the rules setting already has a rule with that name" });
      continue;
    }
    const skills: string[] = [];
    for (const pattern of scope.skills) {
      if (bundled.some((skill) => globToRegExp(pattern).test(skill))) skills.push(pattern);
      else skipped.push({ kind: "skills", name, reason: `no bundled skill matches ${JSON.stringify(pattern)}` });
    }
    if (skills.length > 0) rules.push({ name, scope: scope.name, skills });
  }

  let settingJson: string | null = null;
  if (settingScopes.length > 0 || rules.length > 0) {
    const base = Array.isArray(raw)
      ? { vars: {}, scopes: [], rules: raw }
      : (raw as { scopes?: unknown[]; rules: unknown[] });
    settingJson = JSON.stringify(
      {
        ...base,
        scopes: [...(base.scopes ?? []), ...settingScopes],
        rules: [...base.rules, ...rules],
      },
      null,
      2,
    );
    const problem = deps.validate(settingJson, finalProfileScopes);
    if (problem !== null)
      throw new ImportError([
        `import-dir-skills: the rules setting would be rejected (nothing was written):`,
        ...problem.split("\n").map((line) => `  ${line}`),
      ]);
  }

  // Pins: a null pin, or one whose dir is a claudeConfigDir of the profiles in force after this run.
  const dirs = new Set(finalProfileScopes.map((scope) => scope.claudeConfigDir));
  const pins: ImportReport["pins"] = { imported: [], kept: [], rejected: [] };
  const seen = new Set<string>();
  for (const entry of parsedExport.data.pins) {
    const parsed = pinSchema.safeParse(entry);
    if (!parsed.success) {
      const id = (entry as { threadId?: unknown } | null)?.threadId;
      pins.rejected.push({
        threadId: typeof id === "string" ? id : "(unknown)",
        reason: `invalid pin: ${z.prettifyError(parsed.error).replace(/\n/g, "; ")}`,
      });
      continue;
    }
    const { threadId, pin } = parsed.data;
    if (seen.has(threadId)) {
      pins.rejected.push({ threadId, reason: `listed twice in ${EXPORT_FILE_LABEL}` });
      continue;
    }
    seen.add(threadId);
    if (pin.dir !== null && !dirs.has(pin.dir)) {
      pins.rejected.push({ threadId, reason: `dir ${pin.dir} is not a claudeConfigDir in profiles.json` });
      continue;
    }
    if ((await deps.kv.get<ConfigDirPin>(pinKey(threadId))) !== undefined) pins.kept.push(threadId);
    else pins.imported.push({ threadId, pin });
  }

  return {
    report: {
      profilesFile: profilesState.state,
      profileScopes: profileDefs,
      settingScopes,
      rules,
      settingChanged: settingJson !== null,
      pins,
      skipped,
    },
    finalProfileScopes,
    settingJson,
  };
}

/** Order: profiles.json, then the setting, then the pins. */
async function apply(deps: ImportDeps, plan: Plan): Promise<void> {
  const { report } = plan;
  if (report.profileScopes.length > 0) {
    let outcome: "wrote" | "exists";
    try {
      outcome = writeProfilesFile(deps.profilesFile, report.profileScopes, deps.home);
    } catch {
      throw new ImportError(["import-dir-skills: could not write profiles.json (nothing else was written)"]);
    }
    if (outcome === "exists")
      throw new ImportError(["import-dir-skills: profiles.json appeared while importing; nothing was written, run again"]);
    deps.reloadProfiles();
  }
  if (plan.settingJson !== null) {
    try {
      await deps.setRules(plan.settingJson);
    } catch (error) {
      throw new ImportError([
        `import-dir-skills: the rules setting was rejected: ${error instanceof Error ? error.message : String(error)}`,
        report.profileScopes.length > 0
          ? "profiles.json was written; run again to finish (a profile scope already in profiles.json is recognised)"
          : "nothing was written",
      ]);
    }
  }
  for (const { threadId, pin } of report.pins.imported) await deps.kv.set(pinKey(threadId), pin);
}

export function formatImport(report: ImportReport): string {
  const lines = [report.dryRun ? "import-dir-skills (dry run): nothing is written" : "import-dir-skills: done"];
  const verb = report.dryRun ? "would write" : "wrote";
  lines.push(
    `profiles.json (${report.profilesFile} before): ${
      report.profileScopes.length === 0
        ? "no scope to write"
        : `${verb} ${report.profileScopes.length} scope(s): ${report.profileScopes.map((s) => s.name).join(", ")}`
    }`,
  );
  lines.push(`rules setting: ${report.settingChanged ? `${verb} ${report.settingScopes.length} scope(s), ${report.rules.length} rule(s)` : "unchanged"}`);
  for (const scope of report.settingScopes) lines.push(`  scope ${scope.name}: ${scope.paths.join(", ")}`);
  for (const rule of report.rules) lines.push(`  rule ${rule.name}: scope ${rule.scope}, skills ${rule.skills.join(", ")}`);
  const { imported, kept, rejected } = report.pins;
  lines.push(`pins: ${imported.length} ${report.dryRun ? "to import" : "imported"}, ${kept.length} kept, ${rejected.length} rejected`);
  for (const { threadId, pin } of imported)
    lines.push(`  ${threadId}: ${pin.dir ?? "default profile"}`);
  for (const threadId of kept) lines.push(`  ${threadId}: kept, a pin already exists`);
  for (const { threadId, reason } of rejected) lines.push(`  ${threadId}: rejected, ${reason}`);
  if (report.skipped.length > 0) {
    lines.push("skipped:");
    for (const item of report.skipped) lines.push(`  skipped: ${item.reason} (${item.kind} ${JSON.stringify(item.name)})`);
  }
  if (!report.dryRun && report.profileScopes.length > 0)
    lines.push("profiles.json is in force now; a thread with an older default-profile pin needs `bb model-instructions unpin <thread-id>`");
  return lines.join("\n") + "\n";
}

export async function importCommand(
  deps: ImportDeps,
  flags: string[],
  json: boolean,
): Promise<{ exitCode: number; stdout?: string; stderr?: string }> {
  if (flags.some((flag) => flag !== "--dry-run"))
    return { exitCode: 2, stderr: "usage: bb model-instructions import-dir-skills [--dry-run] [--json]\n" };
  const dryRun = flags.includes("--dry-run");
  try {
    const plan = await buildPlan(deps);
    if (!dryRun) await apply(deps, plan);
    const report: ImportReport = { dryRun, ...plan.report };
    if (!dryRun) deps.log.info(`import-dir-skills: ${report.settingScopes.length} scope(s), ${report.rules.length} rule(s), ${report.pins.imported.length} pin(s), ${report.profileScopes.length} profile scope(s)`);
    return { exitCode: 0, stdout: json ? JSON.stringify({ ok: true, ...report }, null, 2) + "\n" : formatImport(report) };
  } catch (error) {
    if (!(error instanceof ImportError)) throw error;
    return json
      ? { exitCode: 1, stdout: JSON.stringify({ ok: false, errors: error.lines }, null, 2) + "\n" }
      : { exitCode: 1, stderr: error.lines.join("\n") + "\n" };
  }
}
