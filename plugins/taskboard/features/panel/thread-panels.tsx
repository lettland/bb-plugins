import { useCallback, useEffect, useRef, useState } from 'react';
import {
  type PluginNewThreadPanelProps,
  type PluginThreadHeaderActionProps,
  type PluginThreadPanelProps,
  useBbContext,
  useBbNavigate,
  useRpc
} from '@get-bb/plugin-sdk/app';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger
} from '@/components/ui/tooltip';
import { type TaskboardRpcContract } from '../../contract.js';
import { describeError } from '../shared/format.js';
import { TaskboardRightPanel } from './right-panel.js';
import { THREAD_PANEL_ACTION_ID } from '../shared/constants.js';
import {
  loadRightPanelPinned,
  storeRightPanelPinned
} from '../shared/storage.js';

export function TaskboardThreadPanel({ threadId }: PluginThreadPanelProps) {
  const rpc = useRpc<TaskboardRpcContract>();
  const { projectId: contextProjectId, threadId: contextThreadId } =
    useBbContext();
  const fallbackProjectId =
    contextThreadId === threadId ? contextProjectId : null;
  const [projectId, setProjectId] = useState<string | null | undefined>();

  useEffect(() => {
    let cancelled = false;
    setProjectId(undefined);
    void rpc
      .call('threadProject', { threadId })
      .then(result => {
        if (!cancelled) setProjectId(result.projectId);
      })
      .catch(nextError => {
        if (cancelled) return;
        setProjectId(fallbackProjectId);
        toast.error('Could not resolve this thread’s Taskboard project.', {
          description: describeError(nextError)
        });
      });
    return () => {
      cancelled = true;
    };
  }, [fallbackProjectId, rpc, threadId]);

  return <TaskboardRightPanel projectId={projectId} />;
}

export function TaskboardNewThreadPanel({ projectId }: PluginNewThreadPanelProps) {
  return <TaskboardRightPanel projectId={projectId} />;
}

export function TaskboardThreadHeaderAction({
  threadId
}: PluginThreadHeaderActionProps) {
  const { openThreadPanel } = useBbNavigate();
  const autoOpenedThreadRef = useRef<string | null>(null);
  const openTaskboard = useCallback(
    (showError: boolean) => {
      const opened = openThreadPanel({
        actionId: THREAD_PANEL_ACTION_ID,
        title: 'Taskboard'
      });
      if (!opened && showError) {
        toast.error('Taskboard cannot open beside this thread.');
      }
      return opened;
    },
    [openThreadPanel]
  );

  useEffect(() => {
    if (
      !loadRightPanelPinned() ||
      autoOpenedThreadRef.current === threadId
    ) {
      return;
    }
    autoOpenedThreadRef.current = threadId;
    const timeout = window.setTimeout(() => openTaskboard(false), 0);
    return () => window.clearTimeout(timeout);
  }, [openTaskboard, threadId]);

  return (
    <TooltipProvider delayDuration={250}>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-7"
            aria-label="Pin Taskboard on the right"
            onClick={() => {
              storeRightPanelPinned(true);
              openTaskboard(true);
            }}
          >
            <Icon name="PanelRight" className="size-4" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>Pin Taskboard on the right</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
