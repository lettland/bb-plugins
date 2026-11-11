import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

/** A named set of directories. `paths` are normalized: absolute, ~ expanded, symlinks resolved. */
export interface Scope {
  name: string;
  paths: string[];
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
  return (
    rel === "" ||
    (rel !== ".." && !rel.startsWith(".." + path.sep) && !path.isAbsolute(rel))
  );
}

/** Normalizes the paths of a scope as written in the setting or a file. */
export function buildScope(
  def: Scope,
  home: string = homedir(),
): Scope {
  return {
    name: def.name,
    paths: def.paths.map((p) => normalizeDir(p, home)),
  };
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
