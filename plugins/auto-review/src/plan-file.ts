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
 * agent named. `outside`: it resolves outside the allowed roots. `remote`: the
 * thread's workspace is not on this server, so the plan file lives on another
 * host and cannot be read here. `missing`: the plan file is local (or the
 * thread has no workspace to say otherwise) but cannot be resolved or read.
 */
export type PlanFileRead =
  | { kind: "read"; path: string; bytes: Buffer }
  | { kind: "outside" }
  | { kind: "remote" }
  | { kind: "missing" };

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

interface PlanRoots {
  /** The thread's checkout path as the environment reports it, or null when the thread has none. */
  workspace: string | null;
  /** The plan directory in bb's data dir, as named (it may not exist yet). */
  planDir: string;
  /** The resolved allowed roots that exist on this server. */
  roots: string[];
}

/** The thread's workspace, then its plan directory in bb's data dir: the only places a plan file may be read from. */
async function allowedRoots(bb: BbPluginApi, threadId: string): Promise<PlanRoots> {
  let workspace: string | null = null;
  try {
    const { environmentId } = await bb.sdk.threads.get({ threadId });
    workspace = environmentId === null ? null : await checkoutPath(bb, environmentId);
  } catch {
    workspace = null;
  }
  const planDir = join(bb.server.experimental_dataDir, "plans", threadId);
  const roots: string[] = [];
  for (const candidate of [workspace, planDir]) {
    const real = candidate === null ? null : await realpathOrNull(candidate);
    if (real !== null) {
      roots.push(real);
    }
  }
  return { workspace, planDir, roots };
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
 * A file that resolves outside the roots is `outside`. A plan file that cannot
 * be resolved or read fails closed as `missing` (a typo, a deleted file, no
 * permission), with one exception: when the thread has a workspace path and
 * that path does not resolve on this server, the thread runs on another host
 * and its plan file cannot be read here, so the result is `remote` and the
 * form shows the path only. A path inside the plan directory is never remote:
 * that directory is this server's.
 */
export async function readPlanFileForForm(bb: BbPluginApi, threadId: string, planFilePath: string): Promise<PlanFileRead> {
  const { workspace, planDir, roots } = await allowedRoots(bb, threadId);
  const named = isAbsolute(planFilePath) || workspace === null ? planFilePath : resolve(workspace, planFilePath);
  const resolved = await realpathOrNull(named);
  if (resolved === null) {
    const workspaceIsRemote = workspace !== null && (await realpathOrNull(workspace)) === null;
    return workspaceIsRemote && !within(planDir, resolve(named)) ? { kind: "remote" } : { kind: "missing" };
  }
  if (!roots.some((root) => within(root, resolved))) {
    return { kind: "outside" };
  }
  try {
    return { kind: "read", path: resolved, bytes: await readFile(resolved) };
  } catch {
    return { kind: "missing" };
  }
}

/**
 * Whether the file at `path` (the resolved path `readPlanFileForForm` returned)
 * still has `sha256`, checked now. The path is resolved again and must still be
 * itself and inside the allowed roots before anything is read, so a file
 * replaced by a symlink after the form opened cannot make the check read
 * outside them. A changed, deleted, moved or unreadable file, or a check slower
 * than `PLAN_REREAD_TIMEOUT_MS` (roots and read together), is not unchanged: the
 * answer fails closed.
 */
export async function planFileUnchanged(bb: BbPluginApi, threadId: string, path: string, sha256: string): Promise<boolean> {
  const abort = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<false>((done) => {
    timer = setTimeout(() => {
      abort.abort();
      done(false);
    }, PLAN_REREAD_TIMEOUT_MS);
  });
  const check = async (): Promise<boolean> => {
    const { roots } = await allowedRoots(bb, threadId);
    const resolved = await realpathOrNull(path);
    if (resolved !== path || !roots.some((root) => within(root, resolved))) {
      return false;
    }
    return planSha256Of(await readFile(resolved, { signal: abort.signal })) === sha256;
  };
  try {
    return await Promise.race([check().catch(() => false), deadline]);
  } finally {
    clearTimeout(timer);
  }
}
