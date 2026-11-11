import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { checkoutPath } from "./detect-sibling-credit.js";
import { planSha256Of } from "./plan-approval-payload.js";

/**
 * How long the answer-time re-read of the plan file may take. It stays under
 * core's 2 s `describeSubmission` budget (`DESCRIBE_SUBMISSION_TIMEOUT_MS`), so
 * the plugin's own answer wins the race and a slow disk fails closed.
 */
export const PLAN_REREAD_TIMEOUT_MS = 1000;

/**
 * A plan file read for the approval form. `path` is the resolved path the bytes
 * came from: the answer-time check reads that path again, never the one the
 * agent named, so a symlink swapped after the check cannot redirect it.
 */
export type PlanFileRead =
  | { kind: "read"; path: string; bytes: Buffer }
  | { kind: "outside" }
  | { kind: "unavailable" };

/** Whether `path` is `root` itself or inside it; separator-aware, so `/ws-evil` is not inside `/ws`. */
function within(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

async function realpathOrNull(path: string): Promise<string | null> {
  try {
    return await realpath(path);
  } catch {
    return null;
  }
}

/** The thread's workspace, then its plan directory in bb's data dir: the only places a plan file may be read from. */
async function allowedRoots(bb: BbPluginApi, threadId: string): Promise<{ workspace: string | null; roots: string[] }> {
  let workspace: string | null = null;
  try {
    const { environmentId } = await bb.sdk.threads.get({ threadId });
    workspace = environmentId === null ? null : await checkoutPath(bb, environmentId);
  } catch {
    workspace = null;
  }
  const candidates = [workspace, join(bb.server.experimental_dataDir, "plans", threadId)];
  const roots: string[] = [];
  for (const candidate of candidates) {
    const real = candidate === null ? null : await realpathOrNull(candidate);
    if (real !== null) {
      roots.push(real);
    }
  }
  return { workspace, roots };
}

/**
 * Reads the plan file for the approval form, once, from its resolved path.
 *
 * The path counts only inside the thread's workspace or
 * `<bb data dir>/plans/<threadId>/` (the data dir comes from
 * `bb.server.experimental_dataDir`, never a hard-coded `~/.bb`): the form
 * copies the file into the stored payload, so an unconfined path would copy any
 * file the server can read. The path and both roots go through `realpath`
 * (macOS `/var` is `/private/var`) and are compared by `path.relative`.
 *
 * A relative path is the agent's, so it is taken relative to the workspace.
 * A file this host cannot resolve or read (a plan on a remote host) is
 * `unavailable`: the form then shows the path only. A file that resolves
 * outside the roots is `outside`.
 */
export async function readPlanFileForForm(bb: BbPluginApi, threadId: string, planFilePath: string): Promise<PlanFileRead> {
  const { workspace, roots } = await allowedRoots(bb, threadId);
  const named = isAbsolute(planFilePath) || workspace === null ? planFilePath : resolve(workspace, planFilePath);
  const resolved = await realpathOrNull(named);
  if (resolved === null) {
    return { kind: "unavailable" };
  }
  if (!roots.some((root) => within(root, resolved))) {
    return { kind: "outside" };
  }
  try {
    return { kind: "read", path: resolved, bytes: await readFile(resolved) };
  } catch {
    return { kind: "unavailable" };
  }
}

/**
 * Whether the file at `path` still has `sha256`, read again now. A changed,
 * deleted or unreadable file, or a read slower than `PLAN_REREAD_TIMEOUT_MS`, is
 * not unchanged: the answer fails closed.
 */
export async function planFileUnchanged(path: string, sha256: string): Promise<boolean> {
  const abort = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<false>((done) => {
    timer = setTimeout(() => {
      abort.abort();
      done(false);
    }, PLAN_REREAD_TIMEOUT_MS);
  });
  const read = readFile(path, { signal: abort.signal }).then(
    (bytes) => planSha256Of(bytes) === sha256,
    () => false,
  );
  try {
    return await Promise.race([read, deadline]);
  } finally {
    clearTimeout(timer);
  }
}
