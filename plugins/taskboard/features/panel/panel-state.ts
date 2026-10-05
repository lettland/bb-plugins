import {
  type RefObject,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState
} from 'react';
import { useBbContext, useRpc } from '@get-bb/plugin-sdk/app';
import {
  type TaskboardRpcContract,
  type TrackerProject
} from '../../contract.js';
import { availableContextProjectId } from '../../project-selection.js';
import { loadSourceProjectContext } from './source-context.js';
import { describeError, useRefreshOnReconnect } from '../shared/format.js';
import {
  loadLastProjectId,
  loadSidebarCollapsed,
  storeLastProjectId,
  storeSidebarCollapsed
} from '../shared/storage.js';
import { SIDEBAR_AUTO_COLLAPSE_WIDTH } from '../shared/constants.js';
import { type TrackerRoute } from '../shared/route.js';

export function usePanelProjectContext() {
  const { projectId: contextProjectId, threadId: contextThreadId } =
    useBbContext();
  const [sourceProjectContext] = useState(loadSourceProjectContext);
  const selectionContextProjectId = contextThreadId
    ? contextProjectId
    : (sourceProjectContext?.projectId ?? contextProjectId);
  const selectionContextThreadId =
    contextThreadId ?? sourceProjectContext?.threadId ?? null;
  return { selectionContextProjectId, selectionContextThreadId };
}

export function usePanelProjects() {
  const rpc = useRpc<TaskboardRpcContract>();
  const [projects, setProjects] = useState<TrackerProject[] | undefined>();
  const [projectsError, setProjectsError] = useState<string | null>(null);
  const projectsRequestRevisionRef = useRef(0);

  const loadProjects = useCallback(async () => {
    const requestRevision = ++projectsRequestRevisionRef.current;
    setProjectsError(null);
    try {
      const result = await rpc.call('listProjects', null);
      if (requestRevision !== projectsRequestRevisionRef.current) return null;
      setProjects(result.projects);
      return result.projects;
    } catch (nextError) {
      if (requestRevision !== projectsRequestRevisionRef.current) return null;
      setProjects([]);
      setProjectsError(describeError(nextError));
      return null;
    }
  }, [rpc]);
  useEffect(() => {
    void loadProjects();
    return () => {
      projectsRequestRevisionRef.current += 1;
    };
  }, [loadProjects]);
  useRefreshOnReconnect(() => void loadProjects());

  return { projects, projectsError, loadProjects };
}

export function usePreferredProject(
  projects: readonly TrackerProject[] | undefined,
  selectionContextProjectId: string | null
) {
  const contextTargetProjectId = useMemo(
    () => availableContextProjectId(projects, selectionContextProjectId),
    [projects, selectionContextProjectId]
  );
  const preferredProjectId = useMemo(() => {
    if (!projects || projects.length === 0) return null;
    if (contextTargetProjectId) return contextTargetProjectId;
    const lastProjectId = loadLastProjectId();
    if (
      lastProjectId &&
      projects.some(project => project.id === lastProjectId)
    ) {
      return lastProjectId;
    }
    return projects[0]?.id ?? null;
  }, [contextTargetProjectId, projects]);
  return { contextTargetProjectId, preferredProjectId };
}

export function useSidebarLayout(rootRef: RefObject<HTMLDivElement | null>) {
  const [sidebarCollapsed, setSidebarCollapsed] =
    useState(loadSidebarCollapsed);
  const [narrow, setNarrow] = useState(false);
  const [narrowOverride, setNarrowOverride] = useState<boolean | null>(null);

  useEffect(() => {
    const root = rootRef.current;
    if (!root || typeof ResizeObserver === 'undefined') return;
    const update = () => {
      const width = root.clientWidth;
      setNarrow(width > 0 && width < SIDEBAR_AUTO_COLLAPSE_WIDTH);
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(root);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    setNarrowOverride(null);
  }, [narrow]);

  const effectiveSidebarCollapsed = narrow
    ? (narrowOverride ?? true)
    : sidebarCollapsed;
  const sidebarOverlay = narrow && !effectiveSidebarCollapsed;
  const toggleSidebar = () => {
    const next = !effectiveSidebarCollapsed;
    if (narrow) setNarrowOverride(next);
    setSidebarCollapsed(next);
    storeSidebarCollapsed(next);
  };
  const closeOverlay = () => {
    if (sidebarOverlay) setNarrowOverride(null);
  };

  return {
    narrow,
    effectiveSidebarCollapsed,
    sidebarOverlay,
    toggleSidebar,
    closeOverlay
  };
}

export function useLastBrowseRoute(route: TrackerRoute, subPath: string) {
  const lastBrowseRouteRef = useRef<Extract<
    TrackerRoute,
    { kind: 'all' | 'project' }
  > | null>(null);
  useEffect(() => {
    if (route.kind === 'all' || route.kind === 'project') {
      lastBrowseRouteRef.current = route;
      if (route.kind === 'project') storeLastProjectId(route.projectId);
    }
  }, [subPath]);
  return lastBrowseRouteRef;
}

export function usePanelRefresh({
  route,
  projects,
  preferredProjectId,
  loadProjects
}: {
  route: TrackerRoute;
  projects: readonly TrackerProject[] | undefined;
  preferredProjectId: string | null;
  loadProjects: () => Promise<TrackerProject[] | null>;
}) {
  const rpc = useRpc<TaskboardRpcContract>();
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [refreshGeneration, setRefreshGeneration] = useState(0);

  const refresh = async () => {
    if (refreshing) return;
    setRefreshing(true);
    setRefreshError(null);
    try {
      const latestProjects = await loadProjects();
      const projectIds =
        route.kind === 'project' || route.kind === 'item'
          ? [route.projectId]
          : route.kind === 'root' && preferredProjectId
            ? [preferredProjectId]
            : (latestProjects ?? projects ?? []).map(project => project.id);
      await Promise.all(
        projectIds.map(projectId => rpc.call('refresh', { projectId }))
      );
      setRefreshGeneration(generation => generation + 1);
    } catch (nextError) {
      setRefreshError(describeError(nextError));
    } finally {
      setRefreshing(false);
    }
  };

  return { refreshing, refreshError, refreshGeneration, refresh };
}
