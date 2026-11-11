import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { normalizeDir } from "./paths.js";

export const PROJECT_REFRESH_MS = 60_000;
/** One hung project or provider call must not hold the refresh loop forever. */
const LOOKUP_TIMEOUT_MS = 30_000;

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

/** An available provider whose models could not be listed; its thread types are not budget-checked. */
export interface UncheckedProvider {
  id: string;
  /** The error code or message of the failed model lookup. */
  reason: string;
}

export interface ProjectEntry {
  id: string;
  name: string;
  /** Checkout paths of the project, normalized when the list is refreshed. */
  paths: string[];
}

/** A read-only copy of what the caches hold. */
export interface CacheSnapshot {
  providers: ListState & { list: ProviderEntry[]; unchecked: UncheckedProvider[] };
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
 * At most one refresh runs at a time; calls made while one runs share one follow-up refresh.
 */
export function createCaches(bb: BbPluginApi, onRefreshed: () => void) {
  let providers: ProviderEntry[] = [];
  let unchecked: UncheckedProvider[] = [];
  let providerState: ListState = { loaded: false, failed: false };
  let projects = new Map<string, { name: string; sources: ProjectSource[] }>();
  let projectState: ListState = { loaded: false, failed: false };

  async function refreshProjects(): Promise<void> {
    try {
      const listed = await bb.sdk.projects.list({
        includePersonal: true,
        signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
      });
      const next = new Map<string, { name: string; sources: ProjectSource[] }>();
      for (const project of listed) {
        next.set(project.id, {
          name: project.name,
          sources: projectSources(project.sources).map((source) => ({
            ...source,
            path: normalizeDir(source.path),
          })),
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
      const listed = await bb.sdk.providers.list({
        signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
      });
      // Every lookup runs at once, each with its own timeout and its own catch,
      // so a refresh takes one timeout at most and one failure only marks its own provider.
      const outcomes = await Promise.all(
        listed
          .filter((provider) => provider.available)
          .map(async (provider): Promise<ProviderEntry | UncheckedProvider> => {
            try {
              const result = await bb.sdk.providers.models({
                providerId: provider.id,
                signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
              });
              if (result.modelLoadError !== null) return { id: provider.id, reason: result.modelLoadError.code };
              const models = [...new Set(result.models.map((model) => model.model))];
              if (models.length === 0) return { id: provider.id, reason: "no models listed" };
              return { id: provider.id, models };
            } catch (error) {
              return { id: provider.id, reason: errorText(error) };
            }
          }),
      );
      const next: ProviderEntry[] = [];
      const skipped: UncheckedProvider[] = [];
      for (const outcome of outcomes) {
        if ("models" in outcome) next.push(outcome);
        else skipped.push(outcome);
      }
      for (const { id, reason } of skipped)
        bb.log.warn(`provider ${id} left unchecked: models not loaded (${reason})`);
      providers = next;
      unchecked = skipped;
      providerState = { loaded: true, failed: false };
    } catch (error) {
      providerState = { ...providerState, failed: true };
      bb.log.warn(`provider list refresh failed: ${errorText(error)}`);
    }
  }

  async function refreshOnce(): Promise<void> {
    await Promise.all([refreshProjects(), refreshProviders()]);
    onRefreshed();
  }

  let running: Promise<void> | null = null;
  let followUp = false;

  function refresh(): Promise<void> {
    if (running !== null) {
      followUp = true;
      return running;
    }
    running = (async () => {
      try {
        do {
          followUp = false;
          await refreshOnce();
        } while (followUp);
      } finally {
        running = null;
      }
    })();
    return running;
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
    refresh().catch((error) => {
      bb.log.warn(`cache refresh failed: ${errorText(error)}`);
    });
  });

  return {
    refresh,
    snapshot(): CacheSnapshot {
      return {
        providers: { ...providerState, list: providers, unchecked },
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
    /** The environment path (normalized here) and the project's checkout paths (normalized at refresh). */
    candidatesFor(
      environmentPath: string | null,
      projectId: string | null,
    ): string[] {
      const out: string[] = [];
      if (environmentPath) out.push(normalizeDir(environmentPath));
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
