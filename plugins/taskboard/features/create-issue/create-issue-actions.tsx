import { useState } from 'react';
import {
  useBbContext,
  useComposer,
  useComposerView
} from '@get-bb/plugin-sdk/app';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { cn } from '@/lib/utils';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger
} from '@/components/ui/tooltip';
import { CreateIssueDialog } from './create-issue-dialog.js';

export function DirectCreateIssueAction({
  projectId,
  variant
}: {
  projectId: string | null;
  variant: 'labeled' | 'icon';
}) {
  const [launchProjectId, setLaunchProjectId] = useState<string | null>(null);
  const open = launchProjectId !== null;
  const label = projectId
    ? 'Create a new Taskboard issue'
    : 'Choose a BB project before creating an issue';
  const button = (
    <Button
      type="button"
      variant={variant === 'labeled' ? 'outline' : 'ghost'}
      size={variant === 'labeled' ? 'sm' : 'icon'}
      className={cn(
        variant === 'icon' &&
          'size-9 shrink-0 focus-visible:ring-2 focus-visible:ring-ring'
      )}
      aria-label={label}
      disabled={!projectId}
      onClick={() => {
        if (projectId) setLaunchProjectId(projectId);
      }}
    >
      <Icon
        name={variant === 'labeled' ? 'Ticket' : 'Plus'}
        className="size-4"
      />
      {variant === 'labeled' ? 'New issue' : null}
    </Button>
  );
  return (
    <>
      {variant === 'icon' ? (
        <Tooltip>
          <TooltipTrigger asChild>{button}</TooltipTrigger>
          <TooltipContent>{label}</TooltipContent>
        </Tooltip>
      ) : (
        button
      )}
      {launchProjectId ? (
        <CreateIssueDialog
          mode="direct"
          projectId={launchProjectId}
          open={open}
          onOpenChange={nextOpen => {
            if (!nextOpen) setLaunchProjectId(null);
          }}
        />
      ) : null}
    </>
  );
}

export function ComposerCreateIssueAction() {
  const view = useComposerView();
  const composer = useComposer();
  const { projectId: contextProjectId } = useBbContext();
  const [capturedPrompt, setCapturedPrompt] = useState<string | null>(null);
  const projectId =
    view.scope.kind === 'new-thread'
      ? (view.scope.projectId ?? contextProjectId)
      : contextProjectId;
  const hasPrompt = view.draft.text.trim().length > 0;
  const guidance = !projectId
    ? 'Choose a project to create an issue'
    : !hasPrompt
      ? 'Write a prompt to create an issue'
      : 'Turn prompt into Taskboard issue';

  return (
    <TooltipProvider delayDuration={300}>
      <div className="flex items-center" data-taskboard-create-action>
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="inline-flex">
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-7 bg-transparent text-foreground hover:bg-state-hover"
                aria-label="Create Taskboard issue"
                data-taskboard-create-button
                disabled={!projectId || !hasPrompt || view.run.isSubmitting}
                onMouseDown={event => event.preventDefault()}
                onClick={() => {
                  if (!projectId) {
                    toast.error('Choose a BB project before creating an issue.');
                    return;
                  }
                  if (!hasPrompt) {
                    toast.info(
                      'Write a prompt first, then click the Taskboard ticket.'
                    );
                    composer.focus();
                    return;
                  }
                  setCapturedPrompt(view.draft.text);
                }}
              >
                <Icon name="Ticket" className="size-4" aria-hidden="true" />
              </Button>
            </span>
          </TooltipTrigger>
          <TooltipContent side="top">{guidance}</TooltipContent>
        </Tooltip>
        {capturedPrompt !== null ? (
          <CreateIssueDialog
            mode="composer-assisted"
            projectId={projectId}
            open
            onOpenChange={nextOpen => {
              if (!nextOpen) setCapturedPrompt(null);
            }}
            initialPrompt={capturedPrompt}
            onCreated={result => {
              composer.insertMention(result.mention);
              composer.focus();
            }}
          />
        ) : null}
      </div>
    </TooltipProvider>
  );
}
