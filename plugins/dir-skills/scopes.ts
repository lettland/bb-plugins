import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export interface Scope {
  name: string;
  paths: string[];
  patterns: RegExp[];
  patternSources: string[];
  claudeConfigDir: string | null;
}

export interface SkillInfo {
  name: string;
  dir: string;
  scopes: string[];
}

export interface ConfigDirChoice {
  dir: string | null;
  scope: string | null;
  /** Names of other active scopes whose claudeConfigDir differs from the chosen one. */
  conflict: string[];
}

export function expandHome(p: string, home: string = homedir()): string {
  if (p === "~") return home;
  if (p.startsWith("~/")) return path.join(home, p.slice(2));
  return p;
}

export function normalizeDir(p: string, home: string = homedir()): string {
  const absolute = path.resolve(expandHome(p, home));
  try {
    return realpathSync(absolute);
  } catch {
    return absolute;
  }
}

export function isWithin(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

export function globToRegExp(glob: string): RegExp {
  const escaped = glob
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`);
}

/** Where a scope loaded from files comes from: the shipped scopes.json or ~/.bb/dir-skills/scopes.json. */
export type ScopeSource = "shipped" | "file";

/** A scope as the settings form stores it. It never carries claudeConfigDir. */
export interface UiScopeInput {
  name: string;
  paths: string[];
  skills: string[];
}

function nonEmptyStrings(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((v) => typeof v === "string" && v.trim() !== "")
  );
}

export function parseScopes(file: string, home: string = homedir()): Scope[] {
  return parseScopesText(readFileSync(file, "utf8"), file, home);
}

/** Parses `{ "scopes": [...] }` text; every error message starts with `label`. */
export function parseScopesText(
  text: string,
  label: string,
  home: string = homedir(),
): Scope[] {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error(`${label}: not valid JSON`);
  }
  if (
    !raw ||
    typeof raw !== "object" ||
    !Array.isArray((raw as { scopes?: unknown }).scopes)
  ) {
    throw new Error(`${label}: expected { "scopes": [...] }`);
  }
  const scopes: Scope[] = [];
  const entries = (raw as { scopes: unknown[] }).scopes;
  entries.forEach((entry, index) => {
    const e = entry as {
      name?: unknown;
      paths?: unknown;
      skills?: unknown;
      claudeConfigDir?: unknown;
    };
    const name =
      typeof e.name === "string" && e.name.trim() !== ""
        ? e.name.trim()
        : `scope-${index + 1}`;
    if (!nonEmptyStrings(e.paths)) {
      throw new Error(
        `${label}: scope "${name}" needs a non-empty "paths" array of strings`,
      );
    }
    if (!nonEmptyStrings(e.skills)) {
      throw new Error(
        `${label}: scope "${name}" needs a non-empty "skills" array of name patterns`,
      );
    }
    let claudeConfigDir: string | null = null;
    if (e.claudeConfigDir !== undefined) {
      const dir =
        typeof e.claudeConfigDir === "string" ? e.claudeConfigDir.trim() : "";
      if (dir === "" || !(dir.startsWith("~/") || path.isAbsolute(dir))) {
        throw new Error(
          `${label}: scope "${name}" "claudeConfigDir" must be an absolute path or start with "~/"`,
        );
      }
      claudeConfigDir = path.resolve(expandHome(dir, home));
      if (isWithin(claudeConfigDir, home)) {
        throw new Error(
          `${label}: scope "${name}" "claudeConfigDir" must not be your home directory or one of its parents`,
        );
      }
    }
    scopes.push(buildScope(name, e.paths, e.skills, claudeConfigDir, home));
  });
  return scopes;
}

function buildScope(
  name: string,
  paths: string[],
  skills: string[],
  claudeConfigDir: string | null,
  home: string,
): Scope {
  const patternSources = skills.map((s) => s.trim());
  return {
    name,
    paths: paths.map((p) => normalizeDir(p, home)),
    patterns: patternSources.map(globToRegExp),
    patternSources,
    claudeConfigDir,
  };
}

// C0/C1 controls and the Unicode line separators: a name with one would add fake lines to logs and status.
const NAME_CONTROL = /[\p{Cc}\u2028\u2029]/u;

/**
 * Validates the scopes the settings form saves and turns them into Scopes
 * without a Claude profile. Names, paths and skills are trimmed; unlike the
 * file parser there is no `scope-N` default name. Every error message names
 * the offending scope.
 */
export function validateUiScopes(
  items: ReadonlyArray<UiScopeInput>,
  home: string = homedir(),
): Scope[] {
  const seen = new Set<string>();
  return items.map((item, index) => {
    const name = item.name.trim();
    const where = name === "" ? `scope ${index + 1}` : `scope "${name}"`;
    if (name === "") throw new Error(`${where} needs a name`);
    if (NAME_CONTROL.test(name)) {
      throw new Error(`${where}: the name must not contain control characters`);
    }
    if (seen.has(name)) throw new Error(`${where}: the name is used twice`);
    seen.add(name);
    if (!nonEmptyStrings(item.paths)) {
      throw new Error(`${where} needs at least one directory, none of them empty`);
    }
    const paths = item.paths.map((p) => p.trim());
    if (!paths.every((p) => p.startsWith("~/") || path.isAbsolute(p))) {
      throw new Error(`${where}: every directory must be absolute or start with "~/"`);
    }
    if (!nonEmptyStrings(item.skills)) {
      throw new Error(`${where} needs at least one skill or pattern, none of them empty`);
    }
    return buildScope(name, paths, item.skills, null, home);
  });
}

/**
 * Shipped neutral scopes.json, then the private per-user file, then the already-validated UI scopes.
 * A later layer replaces a scope of the same name, except that a UI scope never replaces a scope
 * that sets claudeConfigDir: it is skipped and its name is passed to `onUiSkipped`.
 * `onFileScope` is called once per name that the two file layers define, before the UI layer,
 * with the scope that won and the file it came from.
 */
export function loadScopes(
  root: string,
  userFile: string,
  home: string = homedir(),
  uiScopes: Scope[] = [],
  onUiSkipped?: (name: string) => void,
  onFileScope?: (scope: Scope, source: ScopeSource) => void,
): Scope[] {
  const merged = new Map<string, { scope: Scope; source: ScopeSource }>();
  for (const scope of parseScopes(path.join(root, "scopes.json"), home))
    merged.set(scope.name, { scope, source: "shipped" });
  if (existsSync(userFile))
    for (const scope of parseScopes(userFile, home))
      merged.set(scope.name, { scope, source: "file" });
  for (const { scope, source } of merged.values()) onFileScope?.(scope, source);
  const scopes = new Map<string, Scope>();
  for (const [name, { scope }] of merged) scopes.set(name, scope);
  for (const scope of uiScopes) {
    if (scopes.get(scope.name)?.claudeConfigDir != null) {
      onUiSkipped?.(scope.name);
      continue;
    }
    scopes.set(scope.name, scope);
  }
  return [...scopes.values()];
}

/** Scopes with a path that contains any of the candidate paths. */
export function activeScopes(
  scopes: Scope[],
  candidatePaths: string[],
): Scope[] {
  const dirs = candidatePaths.map((p) => normalizeDir(p));
  return scopes.filter((scope) =>
    scope.paths.some((root) => dirs.some((dir) => isWithin(root, dir))),
  );
}

export function selectSkills(
  skills: SkillInfo[],
  scopes: Scope[],
  candidatePaths: string[],
): string[] {
  const active = new Set(activeScopes(scopes, candidatePaths).map((s) => s.name));
  return skills
    .filter(
      (skill) =>
        skill.scopes.length === 0 ||
        skill.scopes.some((name) => active.has(name)),
    )
    .map((skill) => skill.name);
}

/** The Claude config dir of the first active scope that sets one, by scope name. */
export function configDirFor(
  scopes: Scope[],
  candidatePaths: string[],
): ConfigDirChoice {
  const withDir = activeScopes(scopes, candidatePaths)
    .filter((scope) => scope.claudeConfigDir !== null)
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  if (withDir.length === 0) return { dir: null, scope: null, conflict: [] };
  const [chosen, ...others] = withDir;
  return {
    dir: chosen.claudeConfigDir,
    scope: chosen.name,
    conflict: others
      .filter((s) => s.claudeConfigDir !== chosen.claudeConfigDir)
      .map((s) => s.name),
  };
}
