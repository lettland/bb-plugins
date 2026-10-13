import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { expandHome, isWithin } from "./scopes";

const PUBLIC_FORGES = new Set([
  "github.com",
  "gitlab.com",
  "bitbucket.org",
  "codeberg.org",
]);

export type SkipReason =
  | "exists"
  | "no-profile"
  | "ambiguous-profiles"
  | "no-self-hosted-marketplace"
  | "no-project-match"
  | "no-common-parent"
  | "parent-has-non-work-entries";

export interface Candidate {
  name: string;
  paths: string[];
  skills: string[];
  claudeConfigDir: string;
}

export interface Match {
  projectId: string;
  path: string;
  key: string;
}

export interface SetupProject {
  id: string;
  gitRemoteUrl: string | null;
  sources?: ReadonlyArray<{ path?: string | null }>;
}

export interface DetectInputs {
  home: string;
  customAgents: ReadonlyArray<{ source: string; value: string | null }>;
  projects: ReadonlyArray<SetupProject>;
}

export type Detection =
  | {
      ok: true;
      candidate: Candidate;
      matches: Match[];
      profileSource: string;
    }
  | {
      ok: false;
      reason: SkipReason;
      matches: Match[];
      profileSource?: string;
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function realDirectory(p: string): string | null {
  try {
    const real = realpathSync(p);
    return statSync(real).isDirectory() ? real : null;
  } catch {
    return null;
  }
}

export function normalizeRemote(remote: string): string | null {
  const url = remote.trim().replace(/\/+$/, "").replace(/\.git$/i, "");
  let host: string;
  let rest: string;
  const scheme = /^[a-z][a-z0-9+.-]*:\/\/([^/]*)\/+(.*)$/i.exec(url);
  if (scheme) {
    host = scheme[1].slice(scheme[1].lastIndexOf("@") + 1).replace(/:\d*$/, "");
    rest = scheme[2];
  } else {
    const scp = /^(?:[^@/\s]+@)?([^:/\s]+):\/?([^\s]+)$/.exec(url);
    if (!scp) return null;
    host = scp[1];
    rest = scp[2];
  }
  const group = rest.split("/")[0];
  if (host === "" || group === "" || /[\s[\]]/.test(host)) return null;
  return `${host}/${group}`.toLowerCase();
}

function marketplaceKeys(settingsFile: string): Set<string> {
  const keys = new Set<string>();
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(settingsFile, "utf8"));
  } catch {
    return keys;
  }
  const markets = isRecord(parsed) ? parsed.extraKnownMarketplaces : undefined;
  if (!isRecord(markets)) return keys;
  for (const market of Object.values(markets)) {
    const source = isRecord(market) ? market.source : undefined;
    if (
      isRecord(source) &&
      source.source === "git" &&
      typeof source.url === "string"
    ) {
      const key = normalizeRemote(source.url);
      if (key) keys.add(key);
    }
  }
  return keys;
}

function configDirsOf(customAgents: string | null): string[] {
  if (!customAgents) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(customAgents);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const dirs: string[] = [];
  for (const entry of parsed) {
    const env = isRecord(entry) ? entry.env : undefined;
    const dir = isRecord(env) ? env.CLAUDE_CONFIG_DIR : undefined;
    if (typeof dir !== "string") continue;
    const trimmed = dir.trim();
    if (trimmed.startsWith("~/") || path.isAbsolute(trimmed)) dirs.push(trimmed);
  }
  return dirs;
}

function profilesOf(
  inputs: DetectInputs,
  realHome: string,
): Array<{ dir: string; source: string }> {
  const defaultProfile =
    realDirectory(path.join(realHome, ".claude")) ??
    path.join(realHome, ".claude");
  const found = new Map<string, string>();
  for (const { source, value } of inputs.customAgents) {
    for (const raw of configDirsOf(value)) {
      const dir = realDirectory(expandHome(raw, inputs.home));
      if (!dir || dir === defaultProfile || isWithin(dir, realHome)) continue;
      if (!found.has(dir)) found.set(dir, source);
    }
  }
  return [...found].map(([dir, source]) => ({ dir, source }));
}

function originKey(repo: string): string | null {
  let config: string;
  try {
    config = readFileSync(path.join(repo, ".git", "config"), "utf8");
  } catch {
    return null;
  }
  let inOrigin = false;
  for (const line of config.split(/\r?\n/)) {
    const section = /^\s*\[(.*)\]\s*$/.exec(line);
    if (section) {
      inOrigin = /^remote\s+"origin"$/i.test(section[1].trim());
      continue;
    }
    const url = inOrigin ? /^\s*url\s*=\s*(.*?)\s*$/i.exec(line) : null;
    if (url) return normalizeRemote(url[1]);
  }
  return null;
}

function tildeForm(p: string, realHome: string): string {
  return p !== realHome && isWithin(realHome, p)
    ? `~/${path.relative(realHome, p)}`
    : p;
}

export function detectScope(inputs: DetectInputs): Detection {
  const realHome = realDirectory(inputs.home) ?? path.resolve(inputs.home);
  const skip = (
    reason: SkipReason,
    matches: Match[] = [],
    profileSource?: string,
  ): Detection => ({ ok: false, reason, matches, profileSource });

  const profiles = profilesOf(inputs, realHome);
  if (profiles.length === 0) return skip("no-profile");
  if (profiles.length > 1) return skip("ambiguous-profiles");
  const [profile] = profiles;

  const personal = marketplaceKeys(path.join(realHome, ".claude", "settings.json"));
  const workKeys = new Set(
    [...marketplaceKeys(path.join(profile.dir, "settings.json"))].filter(
      (key) => !PUBLIC_FORGES.has(key.split("/")[0]) && !personal.has(key),
    ),
  );
  if (workKeys.size === 0)
    return skip("no-self-hosted-marketplace", [], profile.source);

  const matches: Match[] = [];
  for (const project of inputs.projects) {
    const key = project.gitRemoteUrl
      ? normalizeRemote(project.gitRemoteUrl)
      : null;
    if (!key || !workKeys.has(key)) continue;
    for (const source of project.sources ?? []) {
      const checkout = source.path ? realDirectory(source.path) : null;
      if (checkout) matches.push({ projectId: project.id, path: checkout, key });
    }
  }
  matches.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  if (matches.length === 0) return skip("no-project-match", [], profile.source);

  const parents = new Set(matches.map((match) => path.dirname(match.path)));
  const [parent] = parents;
  if (parents.size !== 1 || isWithin(parent, realHome))
    return skip("no-common-parent", matches, profile.source);

  let entries: string[];
  try {
    entries = readdirSync(parent).filter((entry) => !entry.startsWith("."));
  } catch {
    return skip("parent-has-non-work-entries", matches, profile.source);
  }
  for (const entry of entries) {
    const repo = path.join(parent, entry);
    const key = realDirectory(repo) ? originKey(repo) : null;
    if (!key || !workKeys.has(key))
      return skip("parent-has-non-work-entries", matches, profile.source);
  }

  return {
    ok: true,
    candidate: {
      name: "work",
      paths: [tildeForm(parent, realHome)],
      skills: ["work-*"],
      claudeConfigDir: tildeForm(profile.dir, realHome),
    },
    matches,
    profileSource: profile.source,
  };
}
