// Pure helpers for conventional-commit subjects, shared by the release
// selector and the commit-subject check. Node built-ins only.

const SUBJECT_RE =
  /^(feat|fix|perf|refactor|revert|docs|test|chore|ci|build|style)(\(([^()\s][^()]*)\))?(!)?: \S/;
const GIT_REVERT_RE = /^(Revert|Reapply) ".+"$/;
const BREAKING_FOOTER_RE = /^BREAKING[ -]CHANGE: /m;
const RANK = { patch: 1, minor: 2, major: 3 };

export function parseSubject(subject) {
  const m = SUBJECT_RE.exec(subject);
  if (m) return { type: m[1], scope: m[3] ?? null, breaking: m[4] === "!" };
  if (GIT_REVERT_RE.test(subject)) return { type: "revert", scope: null, breaking: false };
  return null;
}

export function bumpFor(subject, body) {
  const parsed = parseSubject(subject);
  if (parsed?.breaking || BREAKING_FOOTER_RE.test(body ?? "")) return "major";
  if (parsed?.type === "feat") return "minor";
  return "patch";
}

export function highestBump(list) {
  let best = "patch";
  for (const b of list) if (RANK[b] > RANK[best]) best = b;
  return best;
}

export function effectiveBump(bump, currentVersion) {
  if (bump === "major" && currentVersion.split(".")[0] === "0") return "minor";
  return bump;
}
