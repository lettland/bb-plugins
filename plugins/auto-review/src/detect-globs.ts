/**
 * Glob matching for the paths shell text names. Nothing here uses a regex that
 * can backtrack badly: a glob is matched by a segment matcher instead.
 */

/** Longest glob taken at face value; a longer one is not matched. */
export const MAX_GLOB_LENGTH = 256;

export function isGlob(token: string): boolean {
  return /[*?[]/u.test(token);
}

/**
 * Whether a glob names files with enough certainty for the sibling side: it
 * contains `/`, starts with a literal directory, and its last segment has a
 * literal character other than `*`, `?` and `.`. A bare `*` or `**` never does.
 */
export function globQualifies(glob: string): boolean {
  const segments = glob.split("/");
  const first = segments[0] ?? "";
  return (
    glob.length <= MAX_GLOB_LENGTH &&
    segments.length >= 2 &&
    first !== "" &&
    !isGlob(first) &&
    /[^*?.]/u.test(segments[segments.length - 1] ?? "")
  );
}

function classMatches(body: string, char: string): boolean {
  const negated = body.startsWith("!") || body.startsWith("^");
  const set = negated ? body.slice(1) : body;
  let hit = false;
  for (let at = 0; at < set.length; at += 1) {
    if (set[at + 1] === "-" && at + 2 < set.length) {
      hit ||= char >= (set[at] ?? "") && char <= (set[at + 2] ?? "");
      at += 2;
    } else {
      hit ||= set[at] === char;
    }
  }
  return hit !== negated;
}

/**
 * Matches items against a pattern, where a star token spans any number of
 * items. One backtrack point keeps it polynomial, whatever the pattern.
 */
function wildcardMatch<P, T>(
  pattern: readonly P[],
  items: readonly T[],
  isStar: (token: P) => boolean,
  matches: (token: P, item: T) => boolean,
): boolean {
  let at = 0;
  let pos = 0;
  let star = -1;
  let starPos = 0;
  while (pos < items.length) {
    const token = pattern[at];
    if (token !== undefined && isStar(token)) {
      star = at;
      at += 1;
      starPos = pos;
    } else if (token !== undefined && matches(token, items[pos] as T)) {
      at += 1;
      pos += 1;
    } else if (star >= 0) {
      at = star + 1;
      starPos += 1;
      pos = starPos;
    } else {
      return false;
    }
  }
  while (at < pattern.length && isStar(pattern[at] as P)) {
    at += 1;
  }
  return at === pattern.length;
}

/** A segment pattern as tokens: `*`, `?`, a `[…]` class or a literal character. */
function patternTokens(pattern: string): string[] {
  const tokens: string[] = [];
  for (let at = 0; at < pattern.length; at += 1) {
    const end = pattern[at] === "[" ? pattern.indexOf("]", at + 2) : -1;
    tokens.push(pattern.slice(at, end > 0 ? end + 1 : at + 1));
    at = end > 0 ? end : at;
  }
  return tokens;
}

function charMatches(token: string, char: string): boolean {
  if (token.length > 2 && token.startsWith("[")) {
    return classMatches(token.slice(1, -1), char);
  }
  return token === "?" || token === char;
}

/** One path segment against one pattern segment. */
function segmentMatches(pattern: string, text: string): boolean {
  return wildcardMatch(patternTokens(pattern), text.split(""), (token) => token === "*", charMatches);
}

/** A matcher for a glob against a whole path. */
export function globMatcher(glob: string): (path: string) => boolean {
  const segments = glob.split("/");
  // A `**` segment spans any number of path segments, none included.
  return (path) => wildcardMatch(segments, path.split("/"), (segment) => segment === "**", segmentMatches);
}
