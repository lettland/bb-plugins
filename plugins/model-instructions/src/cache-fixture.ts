import type { CacheSnapshot } from "./projects.js";

/** A cache snapshot for tests: `[provider, models]` and `[project name, checkout paths]` pairs. */
export function snapshotOf(
  providers: Array<[string, string[]]>,
  projects: Array<[string, string[]]>,
  state: { providers?: Partial<CacheSnapshot["providers"]>; projects?: Partial<CacheSnapshot["projects"]> } = {},
): CacheSnapshot {
  return {
    providers: {
      loaded: true,
      failed: false,
      list: providers.map(([id, models]) => ({ id, models })),
      unchecked: [],
      ...state.providers,
    },
    projects: {
      loaded: true,
      failed: false,
      list: projects.map(([name, paths]) => ({ id: `id-${name}`, name, paths })),
      ...state.projects,
    },
  };
}
