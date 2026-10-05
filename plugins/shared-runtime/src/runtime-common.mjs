import path from "node:path";
import { lstat } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { MANIFEST_FILE_NAME } from "./manifest.mjs";

export const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const isolationSourcePath = path.join(pluginRoot, "native/landlock-run.go");

export const assetsSourceDirectory = path.join(pluginRoot, "assets");

export const isolationRuntimeDirectory = ".bb-runtime";

export const isolationLauncherName = "landlock-run";

export const runtimeAssetsDirectoryName = "assets";

export const ISOLATION_SELF_TEST_OPERATION = "isolation_self_test";

const ENVIRONMENT_ID_PATTERN = /^env_[a-z0-9]+$/i;

export function deny(message) {
  throw new Error(`Shared runtime denied: ${message}`);
}

export function assertNonEmptyString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    deny(`${label} is missing or invalid`);
  }
  return value;
}

export function normalizeAbsolute(value) {
  return path.resolve(assertNonEmptyString(value, "absolute path"));
}

export function samePath(left, right) {
  return normalizeAbsolute(left) === normalizeAbsolute(right);
}

export function assertEnvironmentId(environmentId, label) {
  if (typeof environmentId !== "string" || !ENVIRONMENT_ID_PATTERN.test(environmentId)) {
    deny(`${label} is invalid`);
  }
  return environmentId;
}

export function requireManifest(policy) {
  if (!policy?.manifest) {
    deny(
      `project manifest ${MANIFEST_FILE_NAME} is unavailable${policy?.manifestError ? `: ${policy.manifestError}` : ""}`,
    );
  }
  return policy.manifest;
}

export function assertManifestCurrent(policy) {
  const manifest = requireManifest(policy);
  if (policy.manifestStale) {
    deny(
      `project manifest ${MANIFEST_FILE_NAME} changed since installation; run the shared runtime "sync" operation from the primary checkout`,
    );
  }
  return manifest;
}

export async function pathExists(target) {
  try {
    await lstat(target);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}
