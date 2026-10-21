import type { PluginLogger } from "@get-bb/plugin-sdk";
import { EVENTS_TIMEOUT_MS } from "./file-delivery.js";
import type { ThreadLike } from "./heartbeat.js";

/** `displayStatus` values that mean the thread's machine is not ready; any other value counts as working. */
const WAITING_DISPLAY_STATUS = new Set(["provisioning", "waiting-for-host", "host-reconnecting"]);

export interface InteractionsSdk {
  threads: {
    interactions: {
      list(args: { threadId: string; signal: AbortSignal }): Promise<{ turnId: string | null }[]>;
    };
  };
}

export class WaitCheck {
  private readonly sdk: InteractionsSdk;
  private readonly log: PluginLogger;
  // Set while a failed interactions read has been warned about; the next success clears it.
  private warned = false;

  constructor(deps: { sdk: InteractionsSdk; log: PluginLogger }) {
    this.sdk = deps.sdk;
    this.log = deps.log;
  }

  /**
   * True while the thread cannot make progress: its machine is not ready, or an
   * interaction holds its turn. A read that fails counts as working, with the
   * failure warned about once until a read succeeds again.
   */
  async waiting(thread: ThreadLike): Promise<boolean> {
    if (WAITING_DISPLAY_STATUS.has(thread.runtime?.displayStatus ?? "")) return true;
    try {
      const rows = await this.sdk.threads.interactions.list({
        threadId: thread.id,
        signal: AbortSignal.timeout(EVENTS_TIMEOUT_MS),
      });
      this.warned = false;
      return rows.some((row) => row.turnId !== null);
    } catch (error) {
      if (!this.warned) {
        this.warned = true;
        this.log.warn(`could not read pending interactions: ${error instanceof Error ? error.name : "error"}`);
      }
      return false;
    }
  }
}
