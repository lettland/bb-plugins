import { useRef } from 'react';
import {
  type PluginNavPanelProps,
  useBbNavigate
} from '@get-bb/plugin-sdk/app';
import {
  parseTrackerRoute,
  routeToSubPath,
  type TrackerRoute
} from '../shared/route.js';
import {
  useLastBrowseRoute,
  usePanelProjectContext,
  usePanelProjects,
  usePanelRefresh,
  usePreferredProject,
  useSidebarLayout
} from './panel-state.js';
import {
  useContextProjectSelection,
  useDefaultProjectRedirects
} from './use-panel-redirects.js';
import { PANEL_PATH } from '../shared/constants.js';
import { SidebarDrawer, TrackerSidebar } from '../sidebar/sidebar.js';
import { TrackerTopbar } from '../sidebar/topbar.js';
import { PanelOutlet } from './panel-outlet.js';

function PanelErrorBanner({ message }: { message: string }) {
  return (
    <p
      role="alert"
      className="shrink-0 border-b border-border-hairline px-3.5 py-1.5 text-xs text-destructive"
    >
      {message}
    </p>
  );
}

export function TaskboardPanel({ subPath }: PluginNavPanelProps) {
  const route = parseTrackerRoute(subPath);
  const navigate = useBbNavigate();
  const { selectionContextProjectId, selectionContextThreadId } =
    usePanelProjectContext();
  const rootRef = useRef<HTMLDivElement>(null);
  const { projects, projectsError, loadProjects } = usePanelProjects();
  const { contextTargetProjectId, preferredProjectId } = usePreferredProject(
    projects,
    selectionContextProjectId
  );
  const layout = useSidebarLayout(rootRef);
  const lastBrowseRouteRef = useLastBrowseRoute(route, subPath);
  useContextProjectSelection({
    route,
    subPath,
    projects,
    selectionContextProjectId,
    selectionContextThreadId,
    contextTargetProjectId
  });
  useDefaultProjectRedirects({
    route,
    subPath,
    contextTargetProjectId,
    preferredProjectId
  });
  const { refreshing, refreshError, refreshGeneration, refresh } =
    usePanelRefresh({ route, projects, preferredProjectId, loadProjects });

  const go = (nextRoute: TrackerRoute) => {
    layout.closeOverlay();
    navigate.toPluginPanel(PANEL_PATH, { subPath: routeToSubPath(nextRoute) });
  };
  const backFromItem = () => {
    if (route.kind !== 'item') return;
    go(
      lastBrowseRouteRef.current ?? {
        kind: 'project',
        projectId: route.projectId
      }
    );
  };

  const sidebar = (
    <TrackerSidebar
      route={route}
      projects={projects}
      isLoading={projects === undefined}
      preferredProjectId={preferredProjectId}
      overlay={layout.sidebarOverlay}
      onNavigate={go}
    />
  );

  return (
    <div
      ref={rootRef}
      className="tb-linear relative flex h-full min-h-0 flex-row-reverse text-foreground"
    >
      {!layout.effectiveSidebarCollapsed ? (
        layout.sidebarOverlay ? (
          <SidebarDrawer onClose={layout.toggleSidebar}>{sidebar}</SidebarDrawer>
        ) : (
          sidebar
        )
      ) : null}
      <main className="@container flex min-w-0 flex-1 flex-col">
        <TrackerTopbar
          route={route}
          projects={projects}
          sidebarCollapsed={layout.effectiveSidebarCollapsed}
          refreshing={refreshing}
          refreshDisabled={
            route.kind === 'manage' ||
            (route.kind === 'all' && projects === undefined)
          }
          onNavigate={go}
          onBack={backFromItem}
          onRefresh={() => void refresh()}
          onToggleSidebar={layout.toggleSidebar}
        />
        {projectsError ? <PanelErrorBanner message={projectsError} /> : null}
        {refreshError ? <PanelErrorBanner message={refreshError} /> : null}
        <div className="min-h-0 flex-1 overflow-auto">
          <PanelOutlet
            route={route}
            projects={projects}
            preferredProjectId={preferredProjectId}
            refreshGeneration={refreshGeneration}
            narrow={layout.narrow}
            onNavigate={go}
          />
        </div>
      </main>
    </div>
  );
}
