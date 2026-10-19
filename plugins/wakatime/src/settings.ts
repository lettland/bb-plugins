import type { BbPluginApi } from "@get-bb/plugin-sdk";

export const ENTITY_MODES = ["title", "threadId"] as const;
export type EntityMode = (typeof ENTITY_MODES)[number];

export function defineWakatimeSettings(bb: BbPluginApi) {
  return bb.settings.define({
    cliPath: {
      type: "string",
      label: "wakatime-cli path",
      description:
        "Absolute path (a leading ~ is expanded) to the wakatime-cli executable on the bb server host. It reads the API key from ~/.wakatime.cfg. Anyone who can edit plugin settings can make the plugin run this binary on the server host.",
      default: "~/.wakatime/wakatime-cli",
    },
    trackUserActivity: {
      type: "boolean",
      label: "Track my activity in bb",
      description: "Send heartbeats while you interact with a focused bb window.",
      default: true,
    },
    userCategory: {
      type: "string",
      label: "Category for my activity",
      default: "coding",
    },
    trackAgentActivity: {
      type: "boolean",
      label: "Track agent run time",
      description:
        "Send heartbeats while a thread is active, whether or not you are watching. Overlapping time is shared with your other editors, so this can relabel their time.",
      default: true,
    },
    agentCategory: {
      type: "string",
      label: "Category for agent run time",
      default: "ai coding",
    },
    syncAiActivity: {
      type: "boolean",
      label: "Sync AI activity after agent turns",
      description:
        "Run one debounced `wakatime-cli --sync-ai-activity` after agent turns. wakatime-cli decides which transcripts it uploads; this is the off-switch for that upload.",
      default: true,
    },
    entity: {
      type: "select",
      label: "Entity sent to WakaTime",
      description: "title: the thread title. threadId: the thread id only, for privacy.",
      options: [...ENTITY_MODES],
      default: "title",
    },
    excludeProjects: {
      type: "string",
      label: "Excluded projects",
      description:
        "bb project ids or names, one per line or comma-separated. Ids are recommended: they survive renames. A matching project sends no bb heartbeats.",
      experimental_multiline: true,
      default: "",
    },
  });
}

export type WakatimeSettingsHandle = ReturnType<typeof defineWakatimeSettings>;
export type WakatimeSettings = Awaited<ReturnType<WakatimeSettingsHandle["get"]>>;

export function parseExcludeList(raw: string): string[] {
  return raw
    .split(/[\n,]/)
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

export function entityModeOf(value: string): EntityMode {
  return (ENTITY_MODES as readonly string[]).includes(value) ? (value as EntityMode) : "title";
}
