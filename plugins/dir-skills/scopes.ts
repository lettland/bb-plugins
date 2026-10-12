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

export function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return path.join(homedir(), p.slice(2));
  return p;
}

export function normalizeDir(p: string): string {
  const absolute = path.resolve(expandHome(p));
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

export function parseScopes(file: string): Scope[] {
  const raw = JSON.parse(readFileSync(file, "utf8")) as unknown;
  if (
    !raw ||
    typeof raw !== "object" ||
    !Array.isArray((raw as { scopes?: unknown }).scopes)
  ) {
    throw new Error(`${file}: expected { "scopes": [...] }`);
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
    if (
      !Array.isArray(e.paths) ||
      e.paths.length === 0 ||
      !e.paths.every((p) => typeof p === "string" && p.trim() !== "")
    ) {
      throw new Error(
        `${file}: scope "${name}" needs a non-empty "paths" array of strings`,
      );
    }
    if (
      !Array.isArray(e.skills) ||
      e.skills.length === 0 ||
      !e.skills.every((s) => typeof s === "string" && s.trim() !== "")
    ) {
      throw new Error(
        `${file}: scope "${name}" needs a non-empty "skills" array of name patterns`,
      );
    }
    let claudeConfigDir: string | null = null;
    if (e.claudeConfigDir !== undefined) {
      const dir =
        typeof e.claudeConfigDir === "string" ? e.claudeConfigDir.trim() : "";
      if (dir === "" || !(dir.startsWith("~/") || path.isAbsolute(dir))) {
        throw new Error(
          `${file}: scope "${name}" "claudeConfigDir" must be an absolute path or start with "~/"`,
        );
      }
      claudeConfigDir = path.resolve(expandHome(dir));
    }
    const patternSources = (e.skills as string[]).map((s) => s.trim());
    scopes.push({
      name,
      paths: (e.paths as string[]).map(normalizeDir),
      patterns: patternSources.map(globToRegExp),
      patternSources,
      claudeConfigDir,
    });
  });
  return scopes;
}

/** Shipped neutral scopes.json plus the private per-user file; a user scope replaces a shipped one of the same name. */
export function loadScopes(root: string, userFile: string): Scope[] {
  const merged = new Map<string, Scope>();
  for (const scope of parseScopes(path.join(root, "scopes.json")))
    merged.set(scope.name, scope);
  if (existsSync(userFile))
    for (const scope of parseScopes(userFile)) merged.set(scope.name, scope);
  return [...merged.values()];
}

/** Scopes with a path that contains any of the candidate paths. */
export function activeScopes(
  scopes: Scope[],
  candidatePaths: string[],
): Scope[] {
  const dirs = candidatePaths.map(normalizeDir);
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
