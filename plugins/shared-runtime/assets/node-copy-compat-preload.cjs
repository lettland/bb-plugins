"use strict";

// The isolation launcher's seccomp filter fails chmod, utimes, and xattr
// syscalls with EPERM, which breaks Node's copyFile/cp (they chmod the
// destination). Inside the writable copy roots this preload copies by
// read + write-with-mode instead and skips chmod. It is inert unless
// BB_NODE_COPY_COMPAT=1 (every Node process) or BB_NODE_COPY_COMPAT_COMMANDS
// (comma-separated command basenames, e.g. "ttsc,ttsc.js") enables it.

const fs = require("node:fs");
const path = require("node:path");

const originalChmodSync = fs.chmodSync;
const originalCopyFileSync = fs.copyFileSync;
const originalCpSync = fs.cpSync;
const originalPromisesCopyFile = fs.promises.copyFile.bind(fs.promises);
const writableCopyRoots = resolveWritableCopyRoots();
const compatCommands = (process.env.BB_NODE_COPY_COMPAT_COMMANDS ?? "")
  .split(",")
  .map((name) => name.trim())
  .filter((name) => name.length > 0);
const isCompatCommand = process.argv
  .slice(1)
  .some((value) => compatCommands.includes(path.basename(value)));

function resolveWritableCopyRoots() {
  const roots = [];
  const candidates = [process.env.TMPDIR, process.env.TMP, process.env.TEMP];
  if (typeof process.env.BB_NODE_COPY_ROOTS === "string") {
    candidates.push(...process.env.BB_NODE_COPY_ROOTS.split(path.delimiter));
  }
  for (const candidate of candidates) {
    if (typeof candidate !== "string" || candidate.length === 0) continue;
    const absolute = path.resolve(candidate);
    try {
      if (fs.lstatSync(absolute).isDirectory() && !roots.includes(absolute)) {
        roots.push(absolute);
      }
    } catch {
      // Missing or unreadable candidate: skip it.
    }
  }
  return roots;
}

function isInWritableCopyRoot(target) {
  const absolute = path.resolve(String(target));
  return writableCopyRoots.some(
    (root) => absolute === root || absolute.startsWith(`${root}${path.sep}`),
  );
}

function copyFileIntoScratch(source, destination, mode = 0) {
  if (!isInWritableCopyRoot(destination)) {
    return originalCopyFileSync(source, destination, mode);
  }
  const flags = mode & fs.constants.COPYFILE_EXCL ? "wx" : "w";
  const sourceMode = fs.statSync(source).mode;
  fs.writeFileSync(destination, fs.readFileSync(source), {
    flag: flags,
    mode: sourceMode,
  });
}

async function copyFileIntoScratchAsync(source, destination, mode = 0) {
  if (!isInWritableCopyRoot(destination)) {
    return originalPromisesCopyFile(source, destination, mode);
  }
  const flags = mode & fs.constants.COPYFILE_EXCL ? "wx" : "w";
  const sourceMode = (await fs.promises.stat(source)).mode;
  await fs.promises.writeFile(destination, await fs.promises.readFile(source), {
    flag: flags,
    mode: sourceMode,
  });
}

function copyTreeIntoScratch(source, destination, options = {}) {
  if (!isInWritableCopyRoot(destination)) {
    return originalCpSync(source, destination, options);
  }
  if (options.filter && options.filter(source, destination) === false) return;

  const sourceStats = options.dereference
    ? fs.statSync(source)
    : fs.lstatSync(source);
  if (sourceStats.isDirectory()) {
    fs.mkdirSync(destination, { recursive: true, mode: sourceStats.mode });
    for (const entry of fs.readdirSync(source)) {
      copyTreeIntoScratch(
        path.join(source, entry),
        path.join(destination, entry),
        options,
      );
    }
    return;
  }
  if (sourceStats.isSymbolicLink() && options.dereference !== true) {
    fs.symlinkSync(fs.readlinkSync(source), destination);
    return;
  }
  copyFileIntoScratch(source, destination, options.mode ?? 0);
}

if (isCompatCommand || process.env.BB_NODE_COPY_COMPAT === "1") {
  fs.copyFileSync = copyFileIntoScratch;
  fs.cpSync = copyTreeIntoScratch;
  fs.promises.copyFile = copyFileIntoScratchAsync;
  fs.chmodSync = function chmodWithinIsolation(target, mode) {
    if (isInWritableCopyRoot(target)) return;
    return originalChmodSync(target, mode);
  };
}
