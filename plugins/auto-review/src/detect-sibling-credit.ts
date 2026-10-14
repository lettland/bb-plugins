import type { BbPluginApi } from "@get-bb/plugin-sdk";

import { rowTexts } from "./detect-rows.js";
import { siblingWrittenPaths } from "./detect-sibling-writes.js";
import { FAMILY_LOOKBACK_MS, kinEvidence, rowsSince } from "./detect-timeline.js";
import type { KinEvidence, SiblingEvidence } from "./detect-timeline.js";
import type { ThreadListEntry } from "./detect-workspace.js";

/** Lines logged for credited paths before the rest are only counted. */
const LOGGED_CREDITS = 20;

interface CreditInput {
  bb: BbPluginApi;
  threadId: string;
  environmentId: string;
  threadEntries: readonly ThreadListEntry[];
  startedAt: number;
  now: number;
  ownRowsTruncated: boolean;
  sibling: SiblingEvidence;
  /** The kin evidence already read, when there was one. */
  kin: KinEvidence | undefined;
  /** Changed paths that no tool edit, kept commit or harness state accounts for. */
  candidates: readonly string[];
}

async function checkoutPath(bb: BbPluginApi, environmentId: string): Promise<string | null> {
  try {
    const { path } = await bb.sdk.environments.get({ environmentId });
    return path === null || path === "" ? null : path;
  } catch {
    return null;
  }
}

/**
 * The candidate paths a complete sibling's shell commands wrote during the
 * turn, with that sibling, when nothing of this thread's family names them
 * (see `siblingWrittenPaths`). Nothing moves when this thread's timeline is
 * truncated, a related thread could not be read in full or the checkout path is
 * unknown. Only the paths are logged, never the commands.
 */
export async function pathsLeftToSiblings(credit: CreditInput): Promise<Map<string, string>> {
  const { bb, sibling, startedAt, now } = credit;
  const none = new Map<string, string>();
  const texts = sibling.texts.filter(({ threadId }) => sibling.complete.get(threadId) === true);
  if (credit.ownRowsTruncated || texts.length === 0 || credit.candidates.length === 0) {
    return none;
  }
  const root = await checkoutPath(bb, credit.environmentId);
  if (root === null) {
    return none;
  }
  const kin =
    credit.kin ??
    (await kinEvidence(bb, credit.threadEntries, credit.threadId, startedAt, now));
  const own = await rowsSince(bb, credit.threadId, startedAt - FAMILY_LOOKBACK_MS);
  if (!kin.complete || typeof own === "string") {
    bb.log.info("auto-review: not checking whether a sibling's shell edits are this turn's: the family could not be read in full");
    return none;
  }
  const open = { pending: now, unended: now };
  const family = [
    ...rowTexts(own, startedAt, open, { includeUnapproved: true }),
    ...kin.texts,
  ].map(({ text }) => text);
  const credited = siblingWrittenPaths(
    credit.candidates.filter((path) => !kin.paths.has(path)),
    texts,
    family,
    root,
  );
  for (const [path, threadId] of [...credited].slice(0, LOGGED_CREDITS)) {
    bb.log.info(`auto-review: ${path} left to thread ${threadId}: named in its write during the turn`);
  }
  if (credited.size > LOGGED_CREDITS) {
    bb.log.info(
      `auto-review: ${credited.size - LOGGED_CREDITS} more paths left to sibling threads: named in their writes during the turn`,
    );
  }
  return credited;
}
