import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { cn } from '@/lib/utils';
import { type TrackerProject } from '../../contract.js';
import { type TrackerRoute } from '../shared/route.js';

export function TrackerTopbar({
  route,
  projects,
  sidebarCollapsed,
  refreshing,
  refreshDisabled,
  onNavigate,
  onBack,
  onRefresh,
  onToggleSidebar
}: {
  route: TrackerRoute;
  projects: readonly TrackerProject[] | undefined;
  sidebarCollapsed: boolean;
  refreshing: boolean;
  refreshDisabled: boolean;
  onNavigate: (route: TrackerRoute) => void;
  onBack: () => void;
  onRefresh: () => void;
  onToggleSidebar: () => void;
}) {
  const projectId =
    route.kind === 'project' || route.kind === 'item'
      ? route.projectId
      : route.kind === 'manage'
        ? route.projectId
        : null;
  const project = projects?.find(candidate => candidate.id === projectId);

  const breadcrumb = (() => {
    if (route.kind === 'root') {
      return (
        <span className="whitespace-nowrap font-semibold">Taskboard</span>
      );
    }
    if (route.kind === 'all') {
      return (
        <span className="flex items-center gap-2 whitespace-nowrap">
          <span className="font-semibold">Across projects</span>
          <span className="tb-topbar-pill rounded-full px-2 py-0.5 text-2xs font-medium">
            All
          </span>
        </span>
      );
    }
    if (route.kind === 'manage') {
      return (
        <span className="flex min-w-0 items-center gap-2">
          <span className="whitespace-nowrap font-semibold">
            Project settings
          </span>
          {project ? (
            <>
              <Icon
                name="ChevronRight"
                className="size-3 shrink-0 text-muted-foreground"
              />
              <span className="truncate text-xs font-normal text-muted-foreground">
                {project.name}
              </span>
            </>
          ) : null}
        </span>
      );
    }
    if (route.kind === 'project') {
      return (
        <span className="flex min-w-0 items-center gap-2">
          <Icon
            name="Folder"
            className="size-3.5 shrink-0 text-muted-foreground"
          />
          <span className="truncate font-semibold">
            {project?.name ?? 'BB project'}
          </span>
          <span className="tb-topbar-pill hidden rounded-full px-2 py-0.5 text-2xs font-medium @md:inline-flex">
            Issues
          </span>
        </span>
      );
    }
    return (
      <span className="flex min-w-0 items-center gap-1.5">
        <Button
          variant="ghost"
          size="icon"
          className="size-6 shrink-0 max-md:pointer-coarse:size-9"
          aria-label="Back to work items"
          onClick={onBack}
        >
          <Icon name="ChevronLeft" className="size-4" />
        </Button>
        <button
          type="button"
          className="hidden min-w-0 items-center gap-2 text-muted-foreground hover:text-foreground @md:flex"
          onClick={() =>
            onNavigate({ kind: 'project', projectId: route.projectId })
          }
        >
          <Icon name="Folder" className="size-3.5 shrink-0" />
          <span className="truncate font-medium">
            {project?.name ?? 'BB project'}
          </span>
        </button>
        <Icon
          name="ChevronRight"
          className="hidden size-3 shrink-0 text-muted-foreground @md:block"
        />
        <span className="min-w-0 truncate font-medium text-muted-foreground">
          {route.locator}
        </span>
      </span>
    );
  })();

  return (
    <header className="tb-topbar flex h-11 shrink-0 items-center gap-2.5 border-b px-3.5 text-sm max-md:h-12 max-md:pl-12 max-md:pointer-coarse:pl-14">
      <div className="min-w-0 flex-1 overflow-hidden">{breadcrumb}</div>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="size-7 shrink-0 text-muted-foreground hover:text-foreground max-md:pointer-coarse:size-9"
        aria-label="Refresh work items"
        aria-busy={refreshing}
        disabled={refreshDisabled || refreshing}
        onClick={onRefresh}
      >
        <Icon
          name="RotateCcw"
          className={cn('size-3.5', refreshing && 'animate-spin')}
        />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="size-7 max-md:pointer-coarse:size-9"
        aria-label={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        aria-expanded={!sidebarCollapsed}
        onClick={onToggleSidebar}
      >
        <Icon name="PanelRight" className="size-4" />
      </Button>
    </header>
  );
}
