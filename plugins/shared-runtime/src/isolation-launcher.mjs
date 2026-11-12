import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  open,
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
} from "./runtime-common.mjs";
import { runInvocation } from "./invocation-runner.mjs";

export function runtimeDirectoryPath(policy) {
  return path.join(normalizeAbsolute(policy.primaryRoot), isolationRuntimeDirectory);
}

// Reads one file without following a link or blocking on a special file. readdir said it was
// regular, but a repository or container process can swap or remove it before it is opened; null
// means it no longer is a readable regular file.
async function readRegularFile(file) {
  let handle;
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if (error?.code === "ELOOP" || error?.code === "ENOENT") {
      return null;
    }
    throw error;
  }
  try {
    return (await handle.stat()).isFile() ? await handle.readFile() : null;
  } finally {
    await handle.close();
  }
}

// Each file is framed as: name byte length, name, content byte length, content, with the lengths
// as 8-byte big-endian integers, so no pair of file sets can produce the same hash input.
function frameLength(length) {
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(BigInt(length));
  return buffer;
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
    // A swapped-in link or special file, or a file removed after the listing, contributes a marker
    // no bundled file hashes to, so the digest differs and the set is reinstalled.
    const content = (await readRegularFile(path.join(directory, name))) ?? "\0swapped-after-listing";
    hash.update(frameLength(Buffer.byteLength(name)));
    hash.update(name);
    hash.update(frameLength(Buffer.byteLength(content)));
    hash.update(content);
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
    deny(`${runtimeDirectory} must be a directory owned by you, not a symlink; if the repository commits .bb-runtime, do not run operations in it, otherwise remove it and run the operation again`);
  }
}

// True only for a real directory (not a symlink) owned by the current user whose regular files
// hash to `digest`. Only the bundled file names are verified: extra entries under other names are
// ignored because manifests reach assets by name. directoryDigest skips non-regular entries, so a
// symlinked file inside makes the digests differ.
async function installedAssetsMatch(target, digest) {
  let info;
  try {
    info = await lstat(target);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return false;
    }
    throw error;
  }
  if (!info.isDirectory() || info.uid !== process.getuid()) {
    return false;
  }
  return (await directoryDigest(target)).digest === digest;
}

// Calls in one process (two worktrees of one project share the plugin process) must not interleave
// the remove and rename below, so they run one after another per runtime directory. The map holds
// the tail of each directory's chain and drops it once the chain is idle.
const assetInstalls = new Map();

export async function ensureRuntimeAssets(policy) {
  const key = runtimeDirectoryPath(policy);
  const previous = assetInstalls.get(key) ?? Promise.resolve();
  const result = previous.then(() => installRuntimeAssets(policy));
  // A failed call settles the tail as fulfilled, so it never blocks or fails the next call.
  const tail = result.then(
    () => undefined,
    () => undefined,
  );
  assetInstalls.set(key, tail);
  tail.then(() => {
    if (assetInstalls.get(key) === tail) {
      assetInstalls.delete(key);
    }
  });
  return result;
}

async function installRuntimeAssets(policy) {
  const runtimeDirectory = runtimeDirectoryPath(policy);
  await assertRuntimeDirectory(runtimeDirectory);
  const target = path.join(runtimeDirectory, runtimeAssetsDirectoryName);
  const { digest, files } = await directoryDigest(assetsSourceDirectory);
  // An older release wrote assets.sha256 here. It is never read or written now (a repository can
  // commit it as a symlink); rm unlinks a symlink without following it.
  const staleMarker = path.join(runtimeDirectory, `${runtimeAssetsDirectoryName}.sha256`);
  try {
    await rm(staleMarker, { force: true });
  } catch (error) {
    if (error?.code === "ERR_FS_EISDIR") {
      deny(`${staleMarker} is a directory; remove it and run the operation again`);
    }
    throw error;
  }
  if (await installedAssetsMatch(target, digest)) {
    return target;
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
      // Another process published a directory between our rm and rename; renaming a directory
      // onto a non-empty one fails. Accept it only if it matches the bundled assets.
      if (error?.code !== "ENOTEMPTY" && error?.code !== "EEXIST") {
        throw error;
      }
      if (!(await installedAssetsMatch(target, digest))) {
        deny(`${target} was published by another process and does not match the bundled assets; remove it and run the operation again`);
      }
    }
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
  // ensureRuntimeAssets checks the runtime directory before anything is written or removed.
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
