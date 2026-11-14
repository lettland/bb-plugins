import { createContext, useContext, useMemo } from "react";
import { useAtomValue } from "jotai";
import { sidebarThreadLifecyclesAtom } from "../preferences/atoms.js";
import {
  experimental_useSidebarThreads,
  type PluginSidebarProject,
  type PluginSidebarSection,
  type PluginSidebarThread,
  type PluginSidebarThreadsState,
} from "@get-bb/plugin-sdk/app";
import {
  readSidebarSpaces,
  readThreadSpaceId,
  type ForkSidebarSpace,
} from "../../fork-sdk-types.js";
import type { SidebarThread } from "./sidebar-thread.js";

export interface SidebarProject {
  id: string;
  name: string;
  href: string;
  settingsHref: string;
  isPersonal: boolean;
  threads: SidebarThread[];
}

export interface SidebarSpace extends ForkSidebarSpace {
  threads: SidebarThread[];
}

export interface SidebarHost {
  id: string;
  name: string;
}

export interface SidebarData {
  status: PluginSidebarThreadsState["status"];
  sections: readonly PluginSidebarSection[];
  projects: SidebarProject[];
  spaces: readonly SidebarSpace[];
  personalProject: SidebarProject | null;
  hostsById: ReadonlyMap<string, SidebarHost>;
}

function sameElements<T>(left: readonly T[], right: readonly T[]): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function sameHosts(
  left: ReadonlyMap<string, SidebarHost>,
  right: ReadonlyMap<string, SidebarHost>,
): boolean {
  if (left.size !== right.size) return false;
  for (const [id, host] of left) {
    const other = right.get(id);
    if (other === undefined || other.name !== host.name) return false;
  }
  return true;
}

function sameProjectShape(
  previous: SidebarProject,
  project: PluginSidebarProject,
): boolean {
  return (
    previous.id === project.id &&
    previous.name === project.name &&
    previous.href === project.href &&
    previous.settingsHref === project.settingsHref &&
    previous.isPersonal === project.isPersonal
  );
}

function sameSpaceShape(
  previous: SidebarSpace,
  space: ForkSidebarSpace,
): boolean {
  return (
    previous.id === space.id &&
    previous.name === space.name &&
    previous.brief === space.brief &&
    previous.directory === space.directory &&
    previous.createdAt === space.createdAt &&
    previous.updatedAt === space.updatedAt &&
    previous.archivedAt === space.archivedAt
  );
}

function buildSidebarSpaces(
  spaces: readonly ForkSidebarSpace[],
  threads: readonly SidebarThread[],
  previous: readonly SidebarSpace[],
): readonly SidebarSpace[] {
  if (spaces.length === 0) return previous.length === 0 ? previous : NO_SPACES;
  const threadsBySpaceId = new Map<string, SidebarThread[]>();
  for (const thread of threads) {
    const spaceId = readThreadSpaceId(thread);
    if (spaceId === null) continue;
    const bucket = threadsBySpaceId.get(spaceId);
    if (bucket === undefined) {
      threadsBySpaceId.set(spaceId, [thread]);
    } else {
      bucket.push(thread);
    }
  }
  const previousById = new Map(previous.map((space) => [space.id, space]));
  const built = spaces.map<SidebarSpace>((space) => {
    const bucket = threadsBySpaceId.get(space.id) ?? EMPTY_THREADS;
    const before = previousById.get(space.id);
    if (
      before !== undefined &&
      sameSpaceShape(before, space) &&
      sameElements(before.threads, bucket)
    ) {
      return before;
    }
    return {
      ...space,
      threads:
        before !== undefined && sameElements(before.threads, bucket)
          ? before.threads
          : bucket,
    };
  });
  return sameElements(previous, built) ? previous : built;
}

const EMPTY_THREADS: SidebarThread[] = [];
const NO_SPACES: readonly SidebarSpace[] = [];
const EMPTY_HOSTS: readonly SidebarHost[] = [];

export function buildSidebarData(
  status: PluginSidebarThreadsState["status"],
  threads: readonly PluginSidebarThread[],
  projects: readonly PluginSidebarProject[],
  sections: readonly PluginSidebarSection[],
  hosts: readonly SidebarHost[] = [],
  previous: SidebarData | null = null,
  spaces: readonly ForkSidebarSpace[] = [],
): SidebarData {
  const threadsByProjectId = new Map<string, SidebarThread[]>();
  const hostsById = new Map(hosts.map((host) => [host.id, host]));
  for (const thread of threads) {
    const bucket = threadsByProjectId.get(thread.projectId);
    if (bucket === undefined) {
      threadsByProjectId.set(thread.projectId, [thread]);
    } else {
      bucket.push(thread);
    }
    if (thread.host !== null && !hostsById.has(thread.host.id)) {
      hostsById.set(thread.host.id, thread.host);
    }
  }
  const previousProjectsById = new Map(
    previous?.projects.map((project) => [project.id, project]) ?? [],
  );
  const groupedProjects = projects.map<SidebarProject>((project) => {
    const bucket = threadsByProjectId.get(project.id) ?? EMPTY_THREADS;
    const before = previousProjectsById.get(project.id);
    if (
      before !== undefined &&
      sameProjectShape(before, project) &&
      sameElements(before.threads, bucket)
    ) {
      return before;
    }
    return {
      id: project.id,
      name: project.name,
      href: project.href,
      settingsHref: project.settingsHref,
      isPersonal: project.isPersonal,
      threads:
        before !== undefined && sameElements(before.threads, bucket)
          ? before.threads
          : bucket,
    };
  });
  const sharedProjects =
    previous !== null && sameElements(previous.projects, groupedProjects)
      ? previous.projects
      : groupedProjects;
  return {
    status,
    sections,
    projects: sharedProjects,
    spaces: buildSidebarSpaces(spaces, threads, previous?.spaces ?? []),
    personalProject:
      sharedProjects.find((project) => project.isPersonal) ?? null,
    hostsById:
      previous !== null && sameHosts(previous.hostsById, hostsById)
        ? previous.hostsById
        : hostsById,
  };
}

interface SidebarDataCacheEntry {
  status: PluginSidebarThreadsState["status"];
  threads: readonly PluginSidebarThread[];
  projects: readonly PluginSidebarProject[];
  sections: readonly PluginSidebarSection[];
  hosts: readonly SidebarHost[];
  spaces: readonly ForkSidebarSpace[];
  data: SidebarData;
}

let sidebarDataCache: SidebarDataCacheEntry | null = null;

export function getSidebarData(state: PluginSidebarThreadsState): SidebarData {
  const cached = sidebarDataCache;
  const hosts = state.experimental_hosts ?? EMPTY_HOSTS;
  const spaces = readSidebarSpaces(state);
  if (
    cached !== null &&
    cached.status === state.status &&
    cached.threads === state.threads &&
    cached.projects === state.projects &&
    cached.sections === state.sections &&
    cached.hosts === hosts &&
    cached.spaces === spaces
  ) {
    return cached.data;
  }
  const data = buildSidebarData(
    state.status,
    state.threads,
    state.projects,
    state.sections,
    hosts,
    cached?.data ?? null,
    spaces,
  );
  sidebarDataCache = {
    status: state.status,
    threads: state.threads,
    projects: state.projects,
    sections: state.sections,
    hosts,
    spaces,
    data,
  };
  return data;
}

export function resetSidebarDataCacheForTest(): void {
  sidebarDataCache = null;
}

export const SidebarProjectsContext = createContext<
  readonly PluginSidebarProject[]
>([]);

export function useSidebarProjectName(
  projectId: string | null,
): string | undefined {
  const projects = useContext(SidebarProjectsContext);
  return projectId === null
    ? undefined
    : projects.find((project) => project.id === projectId)?.name;
}

export function useSidebarData() {
  const lifecycles = useAtomValue(sidebarThreadLifecyclesAtom);
  const state = experimental_useSidebarThreads({
    experimental_lifecycles: lifecycles,
  });
  return useMemo(
    () => ({ ...getSidebarData(state), archived: state.experimental_archived }),
    [state],
  );
}

export function useSidebarMachineHosts(
  hostsById: ReadonlyMap<string, SidebarHost>,
): SidebarHost[] {
  return useMemo(() => [...hostsById.values()], [hostsById]);
}
