import type { BbPluginApi } from "@get-bb/plugin-sdk";

export const PROJECT_REFRESH_MS = 60_000;
/** One hung provider call must not hold the plugin's startup or the refresh loop forever. */
const PROVIDER_TIMEOUT_MS = 30_000;

export interface ProjectSource {
  path: string;
  hostId: string | null;
}

export interface ListState {
  /** True once a refresh has succeeded at least once. */
  loaded: boolean;
  /** True when the most recent refresh failed; the data is then the last good one. */
  failed: boolean;
}

export interface ProviderEntry {
  id: string;
  models: string[];
}

export interface ProjectEntry {
  id: string;
  name: string;
  /** Checkout paths of the project. */
  paths: string[];
}

/** A read-only copy of what the caches hold. */
export interface CacheSnapshot {
  providers: ListState & { list: ProviderEntry[] };
  projects: ListState & { list: ProjectEntry[] };
}

export function projectSources(
  sources: ReadonlyArray<{ path?: string | null; hostId?: string | null }> | undefined,
): ProjectSource[] {
  const found: ProjectSource[] = [];
  for (const source of sources ?? []) {
    if (typeof source.path === "string" && source.path !== "")
      found.push({ path: source.path, hostId: source.hostId ?? null });
  }
  return found;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The project list and the provider/model list, kept in memory and refreshed together:
 * on a timer, on `thread.created`, and through `refresh()`. `onRefreshed` runs after every refresh.
 */
export function createCaches(bb: BbPluginApi, onRefreshed: () => void) {
  let providers: ProviderEntry[] = [];
  let providerState: ListState = { loaded: false, failed: false };
  let projects = new Map<string, { name: string; sources: ProjectSource[] }>();
  let projectState: ListState = { loaded: false, failed: false };

  async function refreshProjects(): Promise<void> {
    try {
      const listed = await bb.sdk.projects.list({ includePersonal: true });
      const next = new Map<string, { name: string; sources: ProjectSource[] }>();
      for (const project of listed) {
        next.set(project.id, {
          name: project.name,
          sources: projectSources(project.sources),
        });
      }
      projects = next;
      projectState = { loaded: true, failed: false };
    } catch (error) {
      projectState = { ...projectState, failed: true };
      bb.log.warn(`project list refresh failed: ${errorText(error)}`);
    }
  }

  async function refreshProviders(): Promise<void> {
    try {
      const signal = AbortSignal.timeout(PROVIDER_TIMEOUT_MS);
      const listed = await bb.sdk.providers.list({ signal });
      const next: ProviderEntry[] = [];
      for (const provider of listed) {
        if (!provider.available) continue;
        const result = await bb.sdk.providers.models({
          providerId: provider.id,
          signal,
        });
        if (result.modelLoadError !== null)
          throw new Error(
            `${provider.id}: models not loaded (${result.modelLoadError.code})`,
          );
        next.push({
          id: provider.id,
          models: [...new Set(result.models.map((model) => model.model))],
        });
      }
      providers = next;
      providerState = { loaded: true, failed: false };
    } catch (error) {
      providerState = { ...providerState, failed: true };
      bb.log.warn(`provider list refresh failed: ${errorText(error)}`);
    }
  }

  async function refresh(): Promise<void> {
    await Promise.all([refreshProjects(), refreshProviders()]);
    onRefreshed();
  }

  bb.background.service("project-path-cache", {
    async start(signal) {
      while (!signal.aborted) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, PROJECT_REFRESH_MS);
          signal.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              resolve();
            },
            { once: true },
          );
        });
        if (!signal.aborted) await refresh();
      }
    },
  });
  bb.events.on("thread.created", () => {
    void refresh();
  });

  return {
    refresh,
    snapshot(): CacheSnapshot {
      return {
        providers: { ...providerState, list: providers },
        projects: {
          ...projectState,
          list: [...projects].map(([id, { name, sources }]) => ({
            id,
            name,
            paths: sources.map((source) => source.path),
          })),
        },
      };
    },
    candidatesFor(
      environmentPath: string | null,
      projectId: string | null,
    ): string[] {
      const out: string[] = [];
      if (environmentPath) out.push(environmentPath);
      if (projectId)
        out.push(
          ...(projects.get(projectId)?.sources ?? []).map((s) => s.path),
        );
      return out;
    },
    projectName(projectId: string): string | undefined {
      return projects.get(projectId)?.name;
    },
  };
}

export type Caches = ReturnType<typeof createCaches>;
