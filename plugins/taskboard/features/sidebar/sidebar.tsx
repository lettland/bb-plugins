import { type ReactNode, useEffect, useRef, useState } from 'react';
import { Icon } from '@/components/ui/icon';
import { cn } from '@/lib/utils';
import { Skeleton } from '@/components/ui/skeleton';
import { type TrackerProject } from '../../contract.js';
import { type TrackerRoute } from '../shared/route.js';
import {
  clampSidebarWidth,
  loadSidebarWidth,
  storeSidebarWidth
} from '../shared/storage.js';
import {
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH
} from '../shared/constants.js';

function SidebarRow({
  active = false,
  onClick,
  children
}: {
  active?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? 'page' : undefined}
      data-active={active ? 'true' : 'false'}
      className={cn(
        'tb-sidebar-row flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring max-md:pointer-coarse:h-10',
        active ? 'font-medium text-foreground' : 'hover:text-foreground'
      )}
    >
      {children}
    </button>
  );
}

export function TrackerSidebar({
  route,
  projects,
  isLoading,
  preferredProjectId,
  overlay = false,
  onNavigate
}: {
  route: TrackerRoute;
  projects: readonly TrackerProject[] | undefined;
  isLoading: boolean;
  preferredProjectId: string | null;
  overlay?: boolean;
  onNavigate: (route: TrackerRoute) => void;
}) {
  const activeProjectId =
    route.kind === 'project' || route.kind === 'item'
      ? route.projectId
      : route.kind === 'root'
        ? preferredProjectId
        : null;
  const managedProjectId =
    route.kind === 'project' || route.kind === 'item'
      ? route.projectId
      : route.kind === 'manage'
        ? route.projectId
        : preferredProjectId;
  const asideRef = useRef<HTMLElement>(null);
  const [width, setWidth] = useState(loadSidebarWidth);
  const [resizing, setResizing] = useState(false);
  const widthRef = useRef(width);
  widthRef.current = width;

  const startResize = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    setResizing(true);
  };
  const moveResize = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!resizing) return;
    const rightEdge = asideRef.current?.getBoundingClientRect().right;
    if (rightEdge === undefined) return;
    setWidth(clampSidebarWidth(Math.round(rightEdge - event.clientX)));
  };
  const endResize = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!resizing) return;
    event.currentTarget.releasePointerCapture(event.pointerId);
    setResizing(false);
    storeSidebarWidth(widthRef.current);
  };
  const resetWidth = () => {
    setWidth(SIDEBAR_DEFAULT_WIDTH);
    storeSidebarWidth(SIDEBAR_DEFAULT_WIDTH);
  };
  const resizeWithKeyboard = (event: React.KeyboardEvent<HTMLDivElement>) => {
    let nextWidth: number | null = null;
    if (event.key === 'ArrowLeft') nextWidth = widthRef.current + 10;
    if (event.key === 'ArrowRight') nextWidth = widthRef.current - 10;
    if (event.key === 'Home') nextWidth = SIDEBAR_MIN_WIDTH;
    if (event.key === 'End') nextWidth = SIDEBAR_MAX_WIDTH;
    if (nextWidth === null) return;
    event.preventDefault();
    const clamped = clampSidebarWidth(nextWidth);
    setWidth(clamped);
    storeSidebarWidth(clamped);
  };

  return (
    <aside
      ref={asideRef}
      aria-label="Taskboard navigation"
      style={overlay ? undefined : { width }}
      className={cn(
        'tb-sidebar relative flex h-full shrink-0 flex-col border-l',
        overlay && 'w-72 min-w-0 max-w-full shadow-lg',
        resizing && 'select-none'
      )}
    >
      {!overlay ? (
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize sidebar"
          aria-valuemin={SIDEBAR_MIN_WIDTH}
          aria-valuemax={SIDEBAR_MAX_WIDTH}
          aria-valuenow={width}
          tabIndex={0}
          title="Drag to resize · double-click to reset"
          className={cn(
            'absolute inset-y-0 -left-px z-10 w-1 cursor-col-resize transition-colors focus-visible:bg-primary/50 focus-visible:outline-none',
            resizing ? 'bg-primary/50' : 'hover:bg-primary/30'
          )}
          onPointerDown={startResize}
          onPointerMove={moveResize}
          onPointerUp={endResize}
          onPointerCancel={endResize}
          onDoubleClick={resetWidth}
          onKeyDown={resizeWithKeyboard}
        />
      ) : null}
      <nav
        aria-label="Taskboard navigation"
        className="min-h-0 flex-1 overflow-y-auto px-2 pb-4 pt-3"
      >
        <div className="px-2 pb-1.5 text-2xs font-semibold uppercase tracking-[0.14em] text-subtle-foreground">
          Projects
        </div>
        {isLoading ? (
          <div className="space-y-2 px-2 pt-2">
            {['w-3/4', 'w-2/3', 'w-4/5'].map(width => (
              <div className="flex h-7 items-center gap-2" key={width}>
                <Skeleton className="size-3 rounded-sm" />
                <Skeleton className={cn('h-3', width)} />
              </div>
            ))}
          </div>
        ) : projects && projects.length > 0 ? (
          <div className="space-y-px">
            {projects.map(project => (
              <SidebarRow
                key={project.id}
                active={activeProjectId === project.id}
                onClick={() =>
                  onNavigate({ kind: 'project', projectId: project.id })
                }
              >
                <Icon name="Folder" className="size-3.5 shrink-0" />
                <span className="min-w-0 flex-1 truncate" title={project.name}>
                  {project.name}
                </span>
              </SidebarRow>
            ))}
          </div>
        ) : (
          <p className="px-2 py-1 text-xs text-muted-foreground">
            No BB projects found.
          </p>
        )}

        <div className="my-3 border-t border-border-hairline/80" />
        <div className="space-y-px">
          <SidebarRow
            active={route.kind === 'all'}
            onClick={() => onNavigate({ kind: 'all' })}
          >
            <Icon name="ListView" className="size-3.5 shrink-0" />
            <span className="min-w-0 flex-1 truncate">Across projects</span>
          </SidebarRow>
        </div>
      </nav>

      <div className="shrink-0 border-t border-border-hairline px-2 py-1.5">
        <SidebarRow
          active={route.kind === 'manage'}
          onClick={() =>
            onNavigate({ kind: 'manage', projectId: managedProjectId })
          }
        >
          <Icon name="Settings" className="size-3.5 shrink-0" />
          <span className="min-w-0 flex-1 truncate">Manage</span>
        </SidebarRow>
      </div>
    </aside>
  );
}

export function SidebarDrawer({
  onClose,
  children
}: {
  onClose: () => void;
  children: ReactNode;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    dialogRef.current?.focus();
    return () => previous?.focus();
  }, []);

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key !== 'Tab' || !dialogRef.current) return;
    const focusables = dialogRef.current.querySelectorAll<HTMLElement>(
      'button, [href], input, textarea, select, [tabindex]:not([tabindex="-1"])'
    );
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (!first || !last) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label="Taskboard sidebar"
      tabIndex={-1}
      onKeyDown={onKeyDown}
      className="absolute inset-0 z-30 focus-visible:outline-none"
    >
      <button
        type="button"
        aria-label="Close sidebar"
        onClick={onClose}
        className="absolute inset-0 bg-foreground/18 backdrop-blur-[2px]"
      />
      <div className="absolute inset-y-0 right-0 flex max-w-[85%]">
        {children}
      </div>
    </div>
  );
}
