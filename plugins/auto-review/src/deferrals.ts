import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

/**
 * The index of turns currently parked behind another review on the same
 * provider.
 *
 * Per-thread state already records that a turn is deferred, but nothing
 * enumerates threads, so a sweep with no thread in hand could not find them.
 * This index is that enumeration: small (only currently-parked turns), and
 * self-healing — an entry whose thread no longer defers, or no longer exists,
 * is dropped by the sweep that reads it.
 *
 * One key per thread, deliberately: the KV API offers no compare-and-swap, so
 * a single shared array would be a read-modify-write that loses an entry when
 * two threads park at once — and a lost entry is invisible to the sweep, which
 * is the exact stranding the sweep exists to prevent.
 */
export const deferralSchema = z.object({
  threadId: z.string(),
  projectId: z.string(),
  environmentId: z.string(),
  /** Absent only on entries parked before deferral was keyed on provider. */
  providerId: z.string().optional(),
});
export type Deferral = z.infer<typeof deferralSchema>;

export const DEFERRAL_KEY_PREFIX = "deferral:";

function key(threadId: string): string {
  return `${DEFERRAL_KEY_PREFIX}${threadId}`;
}

export async function readDeferrals(bb: BbPluginApi): Promise<Deferral[]> {
  const keys = await bb.storage.kv.list(DEFERRAL_KEY_PREFIX);
  const rows: Deferral[] = [];
  for (const entryKey of keys) {
    const parsed = deferralSchema.safeParse(
      await bb.storage.kv.get<unknown>(entryKey),
    );
    if (parsed.success) {
      rows.push(parsed.data);
    } else {
      await bb.storage.kv.delete(entryKey);
    }
  }
  return rows;
}

export async function addDeferral(
  bb: BbPluginApi,
  entry: Deferral,
): Promise<void> {
  await bb.storage.kv.set(key(entry.threadId), entry);
}

export async function removeDeferral(
  bb: BbPluginApi,
  threadId: string,
): Promise<void> {
  await bb.storage.kv.delete(key(threadId));
}
