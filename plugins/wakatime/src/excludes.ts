import type { PluginLogger } from "@get-bb/plugin-sdk";
import { unmatchedEntries } from "./heartbeat.js";
import type { ProjectLike } from "./heartbeat.js";
import { parseExcludeList } from "./settings.js";
import type { WakatimeSettings } from "./settings.js";

export interface ProjectListSdk {
  projects: {
    list(args: { includePersonal: boolean }): Promise<ProjectLike[]>;
  };
}

export class ExcludeCheck {
  private readonly sdk: ProjectListSdk;
  private readonly settings: { get(): Promise<WakatimeSettings> };
  private readonly log: PluginLogger;
  private checked: string | null = null;

  constructor(deps: { sdk: ProjectListSdk; settings: { get(): Promise<WakatimeSettings> }; log: PluginLogger }) {
    this.sdk = deps.sdk;
    this.settings = deps.settings;
    this.log = deps.log;
  }

  async unmatched(settings: WakatimeSettings): Promise<string[]> {
    const entries = parseExcludeList(settings.excludeProjects);
    if (entries.length === 0) return [];
    return unmatchedEntries(entries, await this.sdk.projects.list({ includePersonal: true }));
  }

  /** Warn once per distinct `excludeProjects` value, by entry position only. */
  async check(): Promise<void> {
    try {
      const settings = await this.settings.get();
      if (settings.excludeProjects === this.checked) return;
      this.checked = settings.excludeProjects;
      const unmatched = await this.unmatched(settings);
      parseExcludeList(settings.excludeProjects).forEach((entry, index) => {
        if (unmatched.includes(entry)) this.log.warn(`excludeProjects entry #${index + 1} matches no project`);
      });
    } catch {
      this.checked = null;
    }
  }
}
