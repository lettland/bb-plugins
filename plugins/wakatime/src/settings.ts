import type { BbPluginApi } from "@get-bb/plugin-sdk";

export const ENTITY_MODES = ["title", "threadId"] as const;
export const FILE_MODES = ["edits-and-reads", "edits", "off"] as const;
export type FileMode = (typeof FILE_MODES)[number];
/**
 * The categories wakatime-cli accepts, minus "ai coding": wakatime-cli v2.27.5
 * silently drops every externally submitted heartbeat with that category.
 */
export const CATEGORIES = [
  "coding",
  "building",
  "indexing",
  "debugging",
  "learning",
  "notes",
  "meeting",
  "planning",
  "researching",
  "communicating",
  "supporting",
  "advising",
  "running tests",
  "writing tests",
  "manual testing",
  "writing docs",
  "code reviewing",
  "browsing",
  "translating",
  "designing",
] as const;

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
      type: "select",
      label: "Category for my activity",
      options: [...CATEGORIES],
      default: "coding",
    },
    trackAgentActivity: {
      type: "boolean",
      label: "Track agent run time",
      description:
        "Send the thread's project, entity, branch, category and time about every 2 minutes while a thread is active and not waiting on you or its machine, whether or not you are watching. Overlapping time is shared with your other editors, so this can relabel their time. Off sends nothing about agent threads, files included.",
      default: true,
    },
    agentCategory: {
      type: "select",
      label: "Category for agent run time",
      description: '"ai coding" is not offered: wakatime-cli v2.27.5 silently drops externally submitted heartbeats with that category.',
      options: [...CATEGORIES],
      default: "building",
    },
    entity: {
      type: "select",
      label: "Entity sent to WakaTime",
      description:
        "title: the thread title is the entity of the per-thread heartbeat. threadId: the thread id is the entity. Besides dropping file entries (none are sent at all, whatever File activity says), this changes only the entity: the project and branch are still sent.",
      options: [...ENTITY_MODES],
      default: "title",
    },
    fileActivity: {
      type: "select",
      label: "File activity",
      description:
        "edits-and-reads: send the path of every file an agent edited or read inside the thread's environment folder, with AI line counts for edits. edits: edits only. off: no file entries; per-thread agent time continues. File entries reach WakaTime up to about 2 minutes late (they are sent with the thread's next heartbeat), and a change takes effect at the next send. File contents never leave the machine, but file names do.",
      options: [...FILE_MODES],
      default: "edits-and-reads",
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

/** An unknown stored value sends nothing: the mode fails closed. */
export function fileModeOf(value: string): FileMode {
  return (FILE_MODES as readonly string[]).includes(value) ? (value as FileMode) : "off";
}
