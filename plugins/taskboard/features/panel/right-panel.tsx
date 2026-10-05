import { useEffect, useState } from 'react';
import { useBbNavigate, useRpc } from '@get-bb/plugin-sdk/app';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { cn } from '@/lib/utils';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger
} from '@/components/ui/tooltip';
import { type TaskboardRpcContract } from '../../contract.js';
import {
  type ItemRoute,
  routeToSubPath,
  type TrackerRoute
} from '../shared/route.js';
import {
  DirectCreateIssueAction
} from '../create-issue/create-issue-actions.js';
import { storeRightPanelPinned } from '../shared/storage.js';
import { PANEL_PATH } from '../shared/constants.js';
import {
  useComposerMentions,
  useRightPanelPinned
} from './use-composer-mentions.js';
import { describeError } from '../shared/format.js';
import { LoadingRows } from '../list/list-states.js';
import { TrackerDetail } from '../detail/tracker-detail.js';
import { TrackerList } from '../list/tracker-list.js';

function RightPanelHeader({
  projectId,
  pinned,
  activeItemRoute,
  fullRoute,
  refreshing,
  onBack,
  onRefresh
}: {
  projectId: string | null | undefined;
  pinned: boolean;
  activeItemRoute: ItemRoute | null;
  fullRoute: TrackerRoute;
  refreshing: boolean;
  onBack: () => void;
  onRefresh: () => void;
}) {
  const navigate = useBbNavigate();
  return (
    <header className="tb-topbar flex h-11 shrink-0 items-center gap-2 border-b px-2.5">
      {activeItemRoute ? (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-7"
          aria-label="Back to Taskboard issues"
          onClick={onBack}
        >
          <Icon name="ChevronLeft" className="size-4" />
        </Button>
      ) : null}
      <div className="min-w-0 flex-1">
        <p className="truncate text-xs font-semibold">
          {activeItemRoute ? activeItemRoute.locator : 'Taskboard'}
        </p>
        <p className="truncate text-2xs text-muted-foreground">
          {projectId === undefined
            ? 'Loading thread project…'
            : projectId
            ? pinned
              ? 'Pinned across chats'
              : 'Open beside this chat'
            : 'Choose a BB project'}
        </p>
      </div>
      {!activeItemRoute ? (
        <DirectCreateIssueAction
          projectId={projectId ?? null}
          variant="icon"
        />
      ) : null}
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-7"
            aria-label={
              pinned
                ? 'Unpin Taskboard from the right panel'
                : 'Keep Taskboard pinned across chats'
            }
            aria-pressed={pinned}
            onClick={() => storeRightPanelPinned(!pinned)}
          >
            <Icon name={pinned ? 'Pin' : 'PinOff'} className="size-3.5" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>
          {pinned ? 'Stop reopening across chats' : 'Keep open across chats'}
        </TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-7"
            aria-label="Refresh Taskboard"
            disabled={!projectId || refreshing}
            onClick={onRefresh}
          >
            <Icon
              name="RotateCcw"
              className={cn('size-3.5', refreshing && 'animate-spin')}
            />
          </Button>
        </TooltipTrigger>
        <TooltipContent>Refresh Taskboard</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-7"
            aria-label="Open full Taskboard"
            onClick={() =>
              navigate.toPluginPanel(PANEL_PATH, {
                subPath: routeToSubPath(fullRoute)
              })
            }
          >
            <Icon name="Maximize2" className="size-3.5" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>Open full Taskboard</TooltipContent>
      </Tooltip>
    </header>
  );
}

function RightPanelNoProject() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
      <Icon name="Folder" className="size-5 text-muted-foreground" />
      <p className="text-sm font-medium">Choose a project</p>
      <p className="max-w-xs text-xs text-muted-foreground">
        Select a BB project in the composer to load its Taskboard here.
      </p>
    </div>
  );
}

export function TaskboardRightPanel({
  projectId
}: {
  projectId: string | null | undefined;
}) {
  const rpc = useRpc<TaskboardRpcContract>();
  const [itemRoute, setItemRoute] = useState<ItemRoute | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [refreshGeneration, setRefreshGeneration] = useState(0);
  const { composerAnnouncement, addItemToComposer } = useComposerMentions();

  useEffect(() => {
    setItemRoute(null);
    setRefreshError(null);
  }, [projectId]);
  const pinned = useRightPanelPinned();

  const refresh = async () => {
    if (!projectId || refreshing) return;
    setRefreshing(true);
    setRefreshError(null);
    try {
      await rpc.call('refresh', { projectId });
      setRefreshGeneration(generation => generation + 1);
    } catch (nextError) {
      setRefreshError(describeError(nextError));
    } finally {
      setRefreshing(false);
    }
  };

  const activeItemRoute =
    projectId && itemRoute?.projectId === projectId ? itemRoute : null;
  const fullRoute: TrackerRoute =
    activeItemRoute ??
    (projectId
      ? { kind: 'project', projectId }
      : { kind: 'root' });

  return (
    <TooltipProvider delayDuration={250}>
      <div
        data-taskboard-right-panel
        className="tb-linear flex h-full min-h-0 flex-col text-foreground"
      >
        <p
          role="status"
          aria-live="polite"
          aria-atomic="true"
          className="sr-only"
        >
          {composerAnnouncement}
        </p>
        <RightPanelHeader
          projectId={projectId}
          pinned={pinned}
          activeItemRoute={activeItemRoute}
          fullRoute={fullRoute}
          refreshing={refreshing}
          onBack={() => setItemRoute(null)}
          onRefresh={() => void refresh()}
        />
        {refreshError ? (
          <p
            role="alert"
            className="shrink-0 border-b border-border-hairline px-3 py-1.5 text-xs text-destructive"
          >
            {refreshError}
          </p>
        ) : null}
        <div
          className={cn(
            'min-h-0 flex-1',
            activeItemRoute ? 'overflow-y-auto' : 'overflow-hidden'
          )}
        >
          {projectId === undefined ? (
            <LoadingRows />
          ) : projectId === null ? (
            <RightPanelNoProject />
          ) : activeItemRoute ? (
            <TrackerDetail
              route={activeItemRoute}
              refreshGeneration={refreshGeneration}
              onAddToComposer={addItemToComposer}
            />
          ) : (
            <TrackerList
              key={projectId}
              projectId={projectId}
              projects={undefined}
              refreshGeneration={refreshGeneration}
              surfaceMode="constrained"
              onOpen={item =>
                setItemRoute({
                  kind: 'item',
                  projectId: item.bbProjectId,
                  source: item.source,
                  locator: item.locator
                })
              }
            />
          )}
        </div>
      </div>
    </TooltipProvider>
  );
}
