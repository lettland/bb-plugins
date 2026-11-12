import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";

import {
  isolationPrebuiltDirectory,
  assetsSourceDirectory,
  isolationRuntimeDirectory,
  isolationLauncherName,
  runtimeAssetsDirectoryName,
  deny,
  normalizeAbsolute,
  pathExists,
} from "./runtime-common.mjs";
import { runInvocation } from "./invocation-runner.mjs";

export function runtimeDirectoryPath(policy) {
  return path.join(normalizeAbsolute(policy.primaryRoot), isolationRuntimeDirectory);
}

async function directoryDigest(directory) {
  const hash = createHash("sha256");
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { digest: hash.digest("hex"), files: [] };
    }
    throw error;
  }
  const files = entries
    .filter((entry) => entry.isFile() && !entry.name.startsWith("."))
    .map((entry) => entry.name)
    .sort();
  for (const name of files) {
    hash.update(name);
    hash.update("\0");
    hash.update(await readFile(path.join(directory, name)));
    hash.update("\0");
  }
  return { digest: hash.digest("hex"), files };
}

// The runtime directory sits inside the repository checkout, so a repository that commits it
// as a symlink would redirect every write and removal below. It must be absent or a real
// directory owned by the current user.
async function assertRuntimeDirectory(runtimeDirectory) {
  let info;
  try {
    info = await lstat(runtimeDirectory);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return;
    }
    throw error;
  }
  if (!info.isDirectory() || info.uid !== process.getuid()) {
    deny(`${runtimeDirectory} must be a directory owned by you, not a symlink; remove it and run the operation again`);
  }
}

export async function ensureRuntimeAssets(policy) {
  const runtimeDirectory = runtimeDirectoryPath(policy);
  await assertRuntimeDirectory(runtimeDirectory);
  const target = path.join(runtimeDirectory, runtimeAssetsDirectoryName);
  const marker = path.join(runtimeDirectory, `${runtimeAssetsDirectoryName}.sha256`);
  const { digest, files } = await directoryDigest(assetsSourceDirectory);
  try {
    if ((await readFile(marker, "utf8")).trim() === digest && (await pathExists(target))) {
      return target;
    }
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }
  await mkdir(runtimeDirectory, { recursive: true, mode: 0o700 });
  // Unique per call: two operations in one process (a shared project lock, two worktrees)
  // must not share, remove or overwrite each other's temporary directory.
  const temporary = path.join(
    runtimeDirectory,
    `.${runtimeAssetsDirectoryName}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    await mkdir(temporary, { recursive: true, mode: 0o755 });
    for (const name of files) {
      await copyFile(path.join(assetsSourceDirectory, name), path.join(temporary, name));
      await chmod(path.join(temporary, name), 0o644);
    }
    await rm(target, { recursive: true, force: true });
    try {
      await rename(temporary, target);
    } catch (error) {
      // A concurrent call published the same asset set between our rm and rename; renaming a
      // directory onto a non-empty one fails, and what is there is complete and identical.
      if (error?.code !== "ENOTEMPTY" && error?.code !== "EEXIST") {
        throw error;
      }
    }
    await writeFile(marker, `${digest}\n`, { mode: 0o600 });
    return target;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

const PREBUILT_ARCHITECTURES = Object.freeze(["amd64", "arm64"]);
const INSTALLED_LAUNCHER_MODE = 0o555;
const SUMS_LINE_PATTERN = /^([0-9a-f]{64})  linux-(amd64|arm64)\/landlock-run$/;

function sha256Of(content) {
  return createHash("sha256").update(content).digest("hex");
}

// Maps each supported architecture to the digest that native/prebuilt/SHA256SUMS records for it.
async function readPrebuiltDigests() {
  let sums;
  try {
    sums = await readFile(path.join(isolationPrebuiltDirectory, "SHA256SUMS"), "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      deny("native/prebuilt/SHA256SUMS is missing");
    }
    throw error;
  }
  const digests = new Map();
  for (const line of sums.split("\n")) {
    const match = SUMS_LINE_PATTERN.exec(line);
    if (match !== null) {
      digests.set(match[2], match[1]);
    }
  }
  return digests;
}

async function dockerHostArchitecture(policy, run, signal) {
  let result;
  try {
    result = await run(
      { command: policy.dockerPath, args: ["version", "-f", "{{.Server.Arch}}"] },
      { signal },
    );
  } catch (error) {
    deny(`cannot read the Docker host architecture: ${error.message}`);
  }
  const architecture = result.stdout.trim();
  if (!PREBUILT_ARCHITECTURES.includes(architecture)) {
    deny(`unsupported Docker host architecture ${JSON.stringify(architecture)}`);
  }
  return architecture;
}

async function readBundledLauncher(architecture, digests) {
  const expected = digests.get(architecture);
  if (expected === undefined) {
    deny(`native/prebuilt/SHA256SUMS has no entry for linux-${architecture}`);
  }
  let binary;
  try {
    binary = await readFile(path.join(isolationPrebuiltDirectory, `linux-${architecture}`, isolationLauncherName));
  } catch (error) {
    if (error?.code === "ENOENT") {
      deny(`the bundled launcher for linux-${architecture} is missing`);
    }
    throw error;
  }
  if (sha256Of(binary) !== expected) {
    deny(`the bundled launcher for linux-${architecture} does not match native/prebuilt/SHA256SUMS`);
  }
  return { binary, expected };
}

// True only for a regular file with the installed mode whose SHA-256 is one of `accepted`.
async function launcherMatches(launcher, accepted) {
  let info;
  try {
    info = await lstat(launcher);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return false;
    }
    throw error;
  }
  if (!info.isFile() || (info.mode & 0o777) !== INSTALLED_LAUNCHER_MODE) {
    return false;
  }
  try {
    return accepted.includes(sha256Of(await readFile(launcher)));
  } catch (error) {
    if (error?.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

// Doctor check: the installed launcher is the bundled one for some supported architecture.
export async function installedLauncherVerified(primaryRoot) {
  const digests = await readPrebuiltDigests();
  return launcherMatches(
    path.join(normalizeAbsolute(primaryRoot), isolationRuntimeDirectory, isolationLauncherName),
    [...digests.values()],
  );
}

export async function ensureIsolationLauncher(policy, options = {}) {
  const run = options.run ?? runInvocation;
  const runtimeDirectory = runtimeDirectoryPath(policy);
  const launcher = path.join(runtimeDirectory, isolationLauncherName);
  await assertRuntimeDirectory(runtimeDirectory);
  await ensureRuntimeAssets(policy);
  const architecture = await dockerHostArchitecture(policy, run, options.signal);
  const { binary, expected } = await readBundledLauncher(architecture, await readPrebuiltDigests());
  // A source build left these behind; the prebuilt install writes neither.
  await rm(path.join(runtimeDirectory, `${isolationLauncherName}.go`), { force: true });
  await rm(path.join(runtimeDirectory, `${isolationLauncherName}.sha256`), { force: true });
  if (await launcherMatches(launcher, [expected])) {
    return launcher;
  }

  await mkdir(runtimeDirectory, { recursive: true, mode: 0o700 });
  const temporaryLauncher = path.join(
    runtimeDirectory,
    `.${isolationLauncherName}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    await writeFile(temporaryLauncher, binary, { mode: 0o700 });
    await chmod(temporaryLauncher, INSTALLED_LAUNCHER_MODE);
    await rename(temporaryLauncher, launcher);
    return launcher;
  } finally {
    await rm(temporaryLauncher, { force: true });
  }
}
