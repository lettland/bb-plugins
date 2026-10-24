import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, lstat, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const preload = path.join(pluginRoot, "assets", "node-copy-compat-preload.cjs");

// The preload runs in child processes only, so these scenarios drive it
// through a driver script and assert the on-disk outcomes in the parent.
const driver = [
  "const fs = require('node:fs');",
  "const path = require('node:path');",
  "(async () => {",
  "  const scratch = process.env.DRIVER_SCRATCH;",
  "  const outside = process.env.DRIVER_OUTSIDE;",
  "  const source = process.env.DRIVER_SOURCE;",
  "  fs.copyFileSync(source, path.join(scratch, 'copied.txt'));",
  "  fs.copyFileSync(source, path.join(outside, 'fallback.txt'));",
  "  fs.copyFileSync(source, path.join(scratch, 'excl.txt'), fs.constants.COPYFILE_EXCL);",
  "  try {",
  "    fs.copyFileSync(source, path.join(scratch, 'excl.txt'), fs.constants.COPYFILE_EXCL);",
  "    console.error('exclusive copy unexpectedly succeeded');",
  "    process.exit(1);",
  "  } catch (error) {",
  "    if (error.code !== 'EEXIST') { throw error; }",
  "  }",
  "  fs.cpSync(source, path.join(outside, 'fallback-tree.txt'));",
  "  fs.cpSync(path.join(scratch, 'tree'), path.join(scratch, 'tree-copy'), { recursive: true });",
  "  fs.cpSync(path.join(scratch, 'tree'), path.join(scratch, 'tree-deref'), { recursive: true, dereference: true });",
  "  fs.chmodSync(path.join(outside, 'fallback.txt'), 0o741);",
  "  await fs.promises.copyFile(source, path.join(outside, 'fallback-async.txt'));",
  "  await fs.promises.copyFile(source, path.join(scratch, 'excl-async.txt'), fs.constants.COPYFILE_EXCL);",
  "  process.stdout.write('done');",
 "})().catch((error) => {",
  "  console.error(error);",
  "  process.exit(1);",
  "});",
].join("\n");

test("the preload rewires copies inside its roots and defers to the originals outside", async (t) => {
  const scratch = await mkdtemp(path.join(tmpdir(), "preload-compat-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const outside = path.join(path.dirname(scratch), `${path.basename(scratch)}-outside`);
  await rm(outside, { recursive: true, force: true });
  await import("node:fs/promises").then(({ mkdir }) => mkdir(outside, { recursive: true }));
  t.after(() => rm(outside, { recursive: true, force: true }));

  const source = path.join(scratch, "source.txt");
  await writeFile(source, "payload\n");
  // A tree with a regular file and an unfiltered symlink, copied inside the
  // writable root.
  const tree = path.join(scratch, "tree");
  await import("node:fs/promises").then(({ mkdir }) => mkdir(tree, { recursive: true }));
  await writeFile(path.join(tree, "entry.txt"), "tree entry\n");
  await symlink(source, path.join(tree, "link.txt"));
  const missingRoot = path.join(scratch, "does-not-exist");

  const { stdout } = await execFileAsync(
    process.execPath,
    ["--require", preload, "-e", driver],
    {
      env: {
        ...process.env,
        BB_NODE_COPY_COMPAT: "1",
        // A missing root exercises the skip branch, the scratch root the
        // in-root copy path.
        BB_NODE_COPY_ROOTS: `${missingRoot}${path.delimiter}${scratch}`,
        TMP: scratch,
        TMPDIR: scratch,
        TEMP: scratch,
        DRIVER_SCRATCH: scratch,
        DRIVER_OUTSIDE: outside,
        DRIVER_SOURCE: source,
      },
    },
  );
  assert.equal(stdout, "done");

  assert.equal(await readFile(path.join(scratch, "copied.txt"), "utf8"), "payload\n");
  assert.equal(await readFile(path.join(outside, "fallback.txt"), "utf8"), "payload\n");
  assert.equal(await readFile(path.join(outside, "fallback-async.txt"), "utf8"), "payload\n");
  assert.equal(await readFile(path.join(outside, "fallback-tree.txt"), "utf8"), "payload\n");
  assert.equal(await readFile(path.join(scratch, "tree-copy", "entry.txt"), "utf8"), "tree entry\n");
  const copiedLink = await lstat(path.join(scratch, "tree-copy", "link.txt"));
  assert.equal(copiedLink.isSymbolicLink(), true, "symlinks stay symlinks inside the root");
  const dereferenced = await lstat(path.join(scratch, "tree-deref", "link.txt"));
  assert.equal(
    dereferenced.isSymbolicLink(),
    false,
    "dereference copies resolve symlinks into regular files",
  );
  const chmodded = await lstat(path.join(outside, "fallback.txt"));
  assert.equal(chmodded.mode & 0o777, 0o741, "chmod still applies outside the writable roots");
});
