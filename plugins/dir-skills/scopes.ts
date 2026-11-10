import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { z } from "zod";

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

export interface ParseScopesOptions {
  /** Extra rules for the UI setting: no claudeConfigDir, and only absolute or ~/ paths. Blank text parses to no scopes. */
  settingLayer?: boolean;
}

export function parseScopes(file: string, home: string = homedir()): Scope[] {
  return parseScopesText(readFileSync(file, "utf8"), file, home);
}

/** Parses `{ "scopes": [...] }` text; every error message starts with `label`. */
export function parseScopesText(
  text: string,
  label: string,
  home: string = homedir(),
  opts: ParseScopesOptions = {},
): Scope[] {
  if (opts.settingLayer && text.trim() === "") return [];
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
    if (
      !Array.isArray(e.paths) ||
      e.paths.length === 0 ||
      !e.paths.every((p) => typeof p === "string" && p.trim() !== "")
    ) {
      throw new Error(
        `${label}: scope "${name}" needs a non-empty "paths" array of strings`,
      );
    }
    if (
      !Array.isArray(e.skills) ||
      e.skills.length === 0 ||
      !e.skills.every((s) => typeof s === "string" && s.trim() !== "")
    ) {
      throw new Error(
        `${label}: scope "${name}" needs a non-empty "skills" array of name patterns`,
      );
    }
    if (opts.settingLayer) {
      if (e.claudeConfigDir !== undefined) {
        throw new Error(
          `${label}: scope "${name}": "claudeConfigDir" can only be set in ~/.bb/dir-skills/scopes.json`,
        );
      }
      if (
        !(e.paths as string[]).every(
          (p) => p.startsWith("~/") || path.isAbsolute(p),
        )
      ) {
        throw new Error(
          `${label}: scope "${name}": every "paths" entry must be absolute or start with "~/"`,
        );
      }
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
    const patternSources = (e.skills as string[]).map((s) => s.trim());
    scopes.push({
      name,
      paths: (e.paths as string[]).map((p) => normalizeDir(p, home)),
      patterns: patternSources.map(globToRegExp),
      patternSources,
      claudeConfigDir,
    });
  });
  return scopes;
}

/**
 * Shipped neutral scopes.json, then the private per-user file, then the already-parsed UI setting scopes.
 * A later layer replaces a scope of the same name, except that a setting scope never replaces a scope
 * that sets claudeConfigDir: it is skipped and its name is passed to `onSettingSkipped`.
 */
export function loadScopes(
  root: string,
  userFile: string,
  home: string = homedir(),
  settingScopes: Scope[] = [],
  onSettingSkipped?: (name: string) => void,
): Scope[] {
  const merged = new Map<string, Scope>();
  for (const scope of parseScopes(path.join(root, "scopes.json"), home))
    merged.set(scope.name, scope);
  if (existsSync(userFile))
    for (const scope of parseScopes(userFile, home)) merged.set(scope.name, scope);
  for (const scope of settingScopes) {
    if (merged.get(scope.name)?.claudeConfigDir != null) {
      onSettingSkipped?.(scope.name);
      continue;
    }
    merged.set(scope.name, scope);
  }
  return [...merged.values()];
}

/** Validates the Scopes setting on write so a broken value never gets stored. */
export const scopesSettingSchema = z.string().superRefine((text, ctx) => {
  try {
    parseScopesText(text, "Scopes setting", homedir(), { settingLayer: true });
  } catch (error) {
    ctx.addIssue({ code: "custom", message: (error as Error).message });
  }
});

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
