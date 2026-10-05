import { type TrackerProject } from '../../contract.js';
import { type TrackerRoute } from '../shared/route.js';
import { EmptyState, LoadingRows } from '../list/list-states.js';
import { ManageView } from '../manage/manage-view.js';
import { TrackerDetail } from '../detail/tracker-detail.js';
import { TrackerList } from '../list/tracker-list.js';

export function PanelOutlet({
  route,
  projects,
  preferredProjectId,
  refreshGeneration,
  narrow,
  onNavigate
}: {
  route: TrackerRoute;
  projects: TrackerProject[] | undefined;
  preferredProjectId: string | null;
  refreshGeneration: number;
  narrow: boolean;
  onNavigate: (route: TrackerRoute) => void;
}) {
  if (route.kind === 'root' && preferredProjectId === null) {
    return projects === undefined ? (
      <div className="h-full bg-surface-recessed-solid p-3">
        <div className="mx-auto h-full max-w-[100rem] rounded-xl border border-border bg-card p-4">
          <LoadingRows />
        </div>
      </div>
    ) : (
      <EmptyState filtered={false} onClear={() => undefined} />
    );
  }
  if (route.kind === 'manage') {
    return (
      <ManageView
        projectId={route.projectId ?? preferredProjectId}
        projects={projects}
        isLoadingProjects={projects === undefined}
        onProjectChange={projectId => onNavigate({ kind: 'manage', projectId })}
      />
    );
  }
  if (route.kind === 'item') {
    return <TrackerDetail route={route} refreshGeneration={refreshGeneration} />;
  }
  const projectId =
    route.kind === 'project'
      ? route.projectId
      : route.kind === 'root'
        ? preferredProjectId
        : null;
  return (
    <TrackerList
      key={projectId ?? 'all'}
      projectId={projectId}
      projects={projects}
      refreshGeneration={refreshGeneration}
      surfaceMode={narrow ? 'constrained' : 'full'}
      onOpen={item =>
        onNavigate({
          kind: 'item',
          projectId: item.bbProjectId,
          source: item.source,
          locator: item.locator
        })
      }
    />
  );
}
