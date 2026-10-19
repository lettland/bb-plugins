import type { BbPluginApi } from "@get-bb/plugin-sdk";
import pkg from "./package.json" with { type: "json" };
import { createRunner } from "./src/cli.js";
import { wakatimeRpcContract } from "./src/rpc-contract.js";
import { defineWakatimeSettings } from "./src/settings.js";
import { createTracker } from "./src/tracker.js";

/** version() may contact npm; it is read in the background and bounded. */
const VERSION_TIMEOUT_MS = 5000;

export default async function plugin(bb: BbPluginApi) {
  const settings = defineWakatimeSettings(bb);
  const runner = createRunner({ log: bb.log });
  let editor = `bb/unknown bb-wakatime/${pkg.version}`;
  const tracker = createTracker({ sdk: bb.sdk, settings, runner, log: bb.log, plugin: () => editor });

  bb.rpc.register(wakatimeRpcContract, {
    async heartbeat(input) {
      return { sent: await tracker.userHeartbeat(input) };
    },
    status: () => tracker.status(),
  });

  bb.events.on("thread.active", ({ thread }) => tracker.onActive(thread));
  bb.events.on("thread.idle", ({ thread }) => tracker.onStop(thread));
  bb.events.on("thread.failed", ({ thread }) => tracker.onStop(thread));
  bb.events.on("thread.archived", ({ thread }) => tracker.onGone(thread.id));
  bb.events.on("thread.deleted", ({ thread }) => tracker.onGone(thread.id));
  bb.events.on("experimental_thread.events", (payload) => tracker.onEvents(payload));

  settings.onChange((next, prev) => {
    tracker.onSettingsChanged();
    if (next.excludeProjects !== prev.excludeProjects) void tracker.checkExcludes();
  });
  bb.onDispose(() => {
    tracker.dispose();
    runner.dispose();
  });

  // Read once, in the background: heartbeats use `bb/unknown` until it answers
  // (or for good if it fails), and never call it themselves.
  void (async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), VERSION_TIMEOUT_MS);
    try {
      const { currentVersion } = await bb.sdk.system.version({ signal: controller.signal });
      editor = `bb/${currentVersion || "unknown"} bb-wakatime/${pkg.version}`;
    } catch {
      // Keep bb/unknown.
    } finally {
      clearTimeout(timer);
    }
  })();

  void tracker.checkExcludes();
  void tracker.reconcile();
}
