import type { BbPluginApi } from "@get-bb/plugin-sdk";
import pkg from "./package.json" with { type: "json" };
import { createRunner } from "./src/cli.js";
import { wakatimeRpcContract } from "./src/rpc-contract.js";
import { defineWakatimeSettings } from "./src/settings.js";
import { createTracker } from "./src/tracker.js";

// The plugin SDK does not expose the host's version, so the editor string
// carries the plugin's own version only.
const PLUGIN_STRING = `bb/unknown bb-wakatime/${pkg.version}`;

export default async function plugin(bb: BbPluginApi) {
  const settings = defineWakatimeSettings(bb);
  const runner = createRunner({ log: bb.log });
  const tracker = createTracker({ sdk: bb.sdk, settings, runner, log: bb.log, plugin: PLUGIN_STRING });

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
    if (next.excludeProjects !== prev.excludeProjects) void tracker.checkExcludes();
  });
  bb.onDispose(() => tracker.dispose());

  void tracker.checkExcludes();
  void tracker.reconcile();
}
