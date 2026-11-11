// Pure on purpose: no node imports, so the server and the settings form match globs the same way.

const globCache = new Map<string, RegExp>();

export function globToRegExp(glob: string): RegExp {
  let regexp = globCache.get(glob);
  if (regexp === undefined) {
    const escaped = glob
      .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
      .replace(/\*/g, ".*");
    regexp = new RegExp(`^${escaped}$`);
    globCache.set(glob, regexp);
  }
  return regexp;
}

export function anyGlobMatches(patterns: readonly string[], value: string): boolean {
  return patterns.some((glob) => globToRegExp(glob).test(value));
}
