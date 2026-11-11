import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { z } from "zod";
import { writeNewFile } from "./files.js";
import { buildScope, expandHome, isWithin, type Scope } from "./paths.js";
import { MAX_SCOPE_PATHS, MAX_SCOPES, nameSchema, scopePathSchema } from "./rules.js";

/** A scope that sets a Claude config dir. `paths` are normalized; `claudeConfigDir` is absolute. */
export interface ProfileScope extends Scope {
  claudeConfigDir: string;
}

/** What the profile file defines, as written (paths and dir not yet resolved). */
export interface ProfileDef {
  name: string;
  paths: string[];
  claudeConfigDir: string;
}

/** The state of `~/.bb/model-instructions/profiles.json`. A malformed file is never treated as absent. */
export type ProfilesState =
  | { state: "absent" }
  | { state: "malformed"; message: string }
  | { state: "valid"; scopes: ProfileScope[] };

export function profilesFile(home: string = homedir()): string {
  return path.join(home, ".bb", "model-instructions", "profiles.json");
}

const configDirSchema = (home: string) =>
  z
    .string()
    .trim()
    .refine((value) => value.startsWith("~/") || path.isAbsolute(value), {
      error: 'expected an absolute path or a path starting with "~/"',
    })
    .transform((value) => path.resolve(expandHome(value, home)))
    .refine((dir) => !isWithin(dir, home), {
      error: "must not be your home directory or one of its parents",
    });

const profileScopeSchema = (home: string) =>
  z
    .object({
      name: nameSchema,
      paths: z.array(scopePathSchema).min(1).max(MAX_SCOPE_PATHS),
      claudeConfigDir: configDirSchema(home),
    })
    .strict();

const profilesSchema = (home: string) =>
  z
    .object({
      scopes: z
        .array(profileScopeSchema(home))
        .max(MAX_SCOPES)
        .superRefine((scopes, ctx) => {
          const seen = new Set<string>();
          scopes.forEach((scope, index) => {
            if (seen.has(scope.name))
              ctx.addIssue({
                code: "custom",
                path: [index, "name"],
                message: `the scope name "${scope.name}" is used twice`,
              });
            seen.add(scope.name);
          });
        }),
    })
    .strict();

function toProfileScope(def: { name: string; paths: string[]; claudeConfigDir: string }, home: string): ProfileScope {
  return { ...buildScope({ name: def.name, paths: def.paths }, home), claudeConfigDir: def.claudeConfigDir };
}

/** Parses `{ "scopes": [...] }` text. Throws an Error whose message names the field at fault. */
export function parseProfiles(text: string, home: string = homedir()): ProfileScope[] {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new Error(`not valid JSON: ${(error as Error).message}`);
  }
  const parsed = profilesSchema(home).safeParse(raw);
  if (!parsed.success) throw new Error(z.prettifyError(parsed.error));
  return parsed.data.scopes.map((scope) => toProfileScope(scope, home));
}

/** Why one scope definition cannot go into profiles.json, or null. */
export function profileDefProblem(def: ProfileDef, home: string = homedir()): string | null {
  const parsed = profileScopeSchema(home).safeParse(def);
  return parsed.success ? null : z.prettifyError(parsed.error);
}

/** One line, so a validation error cannot add lines to status or the log. */
const oneLine = (message: string) => message.replace(/\s*\n\s*/g, "; ");

/** Reads the file once. ENOENT is absent; every other read, parse or validation error is malformed. */
export function readProfiles(file: string, home: string = homedir()): ProfilesState {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { state: "absent" };
    return { state: "malformed", message: oneLine((error as Error).message) };
  }
  try {
    return { state: "valid", scopes: parseProfiles(text, home) };
  } catch (error) {
    return { state: "malformed", message: oneLine((error as Error).message) };
  }
}

/** Writes a new profiles.json without replacing an existing file. Throws on any failure other than the file existing. */
export function writeProfilesFile(
  target: string,
  defs: ProfileDef[],
  home: string = homedir(),
): "wrote" | "exists" {
  return writeNewFile(target, ".profiles", JSON.stringify({ scopes: defs }, null, 2) + "\n", (temp) => {
    parseProfiles(readFileSync(temp, "utf8"), home);
  });
}

export interface MergedScopes {
  scopes: Scope[];
  /** Names of setting scopes left out because a profile scope has the same name. */
  ignored: string[];
}

/**
 * The scope list rules see: every profile scope, then the setting's scopes. A setting scope with a
 * profile scope's name is ignored, so nothing that can edit the setting can move a Claude profile.
 */
export function mergeScopes(setting: Scope[], profiles: ProfileScope[]): MergedScopes {
  const taken = new Set(profiles.map((scope) => scope.name));
  const ignored = setting.filter((scope) => taken.has(scope.name)).map((scope) => scope.name);
  return {
    scopes: [
      ...profiles.map(({ name, paths }) => ({ name, paths })),
      ...setting.filter((scope) => !taken.has(scope.name)),
    ],
    ignored,
  };
}

export function ignoredScopeText(name: string): string {
  return `ignored setting scope "${name}": a profile scope with that name comes from profiles.json`;
}
