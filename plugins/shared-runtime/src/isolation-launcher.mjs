import path from "node:path";
import { createHash } from "node:crypto";
import {
  chmod,
  copyFile,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";

import {
  isolationSourcePath,
  assetsSourceDirectory,
  isolationRuntimeDirectory,
  isolationLauncherName,
  runtimeAssetsDirectoryName,
  deny,
  normalizeAbsolute,
  requireManifest,
  pathExists,
} from "./runtime-common.mjs";
import { dockerExec, hostPathInContainer } from "./workspace.mjs";
import { runInvocation } from "./invocation-runner.mjs";

export function runtimeDirectoryPath(policy) {
  return path.join(normalizeAbsolute(policy.primaryRoot), isolationRuntimeDirectory);
}

export function launcherBuildInvocation(policy, sourcePath, outputPath) {
  const manifest = requireManifest(policy);
  if (manifest.isolation === null) {
    deny("isolation builder is not declared");
  }
  const builder = manifest.isolation.builder;
  return dockerExec(
    policy,
    builder,
    hostPathInContainer(policy, policy.primaryRoot, builder),
    "go",
    [
      "build",
      "-trimpath",
      "-o",
      hostPathInContainer(policy, outputPath, builder),
      hostPathInContainer(policy, sourcePath, builder),
    ],
  );
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

export async function ensureRuntimeAssets(policy) {
  const runtimeDirectory = runtimeDirectoryPath(policy);
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
  const temporary = path.join(runtimeDirectory, `.${runtimeAssetsDirectoryName}.${process.pid}.tmp`);
  await rm(temporary, { recursive: true, force: true });
  try {
    await mkdir(temporary, { recursive: true, mode: 0o755 });
    for (const name of files) {
      await copyFile(path.join(assetsSourceDirectory, name), path.join(temporary, name));
      await chmod(path.join(temporary, name), 0o644);
    }
    await rm(target, { recursive: true, force: true });
    await rename(temporary, target);
    await writeFile(marker, `${digest}\n`, { mode: 0o600 });
    return target;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

export async function ensureIsolationLauncher(policy, options = {}) {
  const source = await readFile(isolationSourcePath);
  const digest = createHash("sha256").update(source).digest("hex");
  const runtimeDirectory = runtimeDirectoryPath(policy);
  const launcher = path.join(runtimeDirectory, isolationLauncherName);
  const marker = path.join(runtimeDirectory, `${isolationLauncherName}.sha256`);
  await ensureRuntimeAssets(policy);
  try {
    const [recordedDigest, launcherStat] = await Promise.all([
      readFile(marker, "utf8"),
      stat(launcher),
    ]);
    if (
      recordedDigest.trim() === digest &&
      launcherStat.isFile() &&
      (launcherStat.mode & 0o111) !== 0
    ) {
      return launcher;
    }
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }

  await mkdir(runtimeDirectory, { recursive: true, mode: 0o700 });
  const sourceCopy = path.join(runtimeDirectory, `${isolationLauncherName}.go`);
  const temporaryLauncher = path.join(
    runtimeDirectory,
    `.${isolationLauncherName}.${process.pid}.tmp`,
  );
  const temporaryMarker = `${marker}.${process.pid}.tmp`;
  await rm(temporaryLauncher, { force: true });
  await rm(temporaryMarker, { force: true });
  try {
    await writeFile(sourceCopy, source, { mode: 0o644 });
    const run = options.run ?? runInvocation;
    await run(launcherBuildInvocation(policy, sourceCopy, temporaryLauncher), {
      signal: options.signal,
    });
    await chmod(temporaryLauncher, 0o555);
    await rename(temporaryLauncher, launcher);
    await writeFile(temporaryMarker, `${digest}\n`, { mode: 0o600 });
    await rename(temporaryMarker, marker);
    return launcher;
  } finally {
    await rm(temporaryLauncher, { force: true });
    await rm(temporaryMarker, { force: true });
  }
}
