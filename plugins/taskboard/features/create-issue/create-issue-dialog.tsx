import { useId } from 'react';
import { useBbNavigate } from '@get-bb/plugin-sdk/app';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog';
import { Icon } from '@/components/ui/icon';
import { Skeleton } from '@/components/ui/skeleton';
import { type CreateIssueContext } from '../../contract.js';
import {
  canSubmitIssue,
  type CreatedIssueResult,
  currentMetadataScopeKey
} from './create-issue-model.js';
import { SourceGlyph, sourceName } from '../shared/source.js';
import {
  useCreateIssueForm,
  useCreateIssueMetadataState,
  useCreateIssueSubmitState
} from './use-create-issue-form.js';
import {
  useCreateIssueContext,
  useCreateIssueMetadata
} from './use-create-issue-loaders.js';
import { useCreateIssueSubmit } from './use-create-issue-submit.js';
import {
  DestinationField,
  EditablePromptFields,
  IssuePropertyBar
} from './create-issue-fields.js';
import { PANEL_PATH } from '../shared/constants.js';
import { routeToSubPath } from '../shared/route.js';

type CreateIssueDialogProps = {
  projectId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated?: (result: CreatedIssueResult) => void;
} & (
  | { mode: 'direct' }
  | {
      mode: 'composer-assisted';
      initialPrompt: string;
    }
);

function CreateIssueDialogHeader({
  context,
  assisted
}: {
  context: CreateIssueContext | undefined;
  assisted: boolean;
}) {
  return (
    <DialogHeader>
      <div className="flex items-center gap-2 pr-7">
        {context ? <SourceGlyph source={context.source} /> : null}
        <DialogTitle>
          {context
            ? `${context.projectName} · ${sourceName(context.source)} · New issue`
            : 'Prepare issue'}
        </DialogTitle>
      </div>
      <DialogDescription>
        {context === undefined
          ? 'Loading the tracker configured for this BB project…'
          : !context.available
            ? `Finish setting up ${sourceName(context.source)} for this project.`
            : !assisted
              ? `Create an issue directly in the tracker configured for ${context.projectName}.`
              : 'Review the copied prompt and provider fields before creating the issue.'}
      </DialogDescription>
    </DialogHeader>
  );
}

function CreateIssueFooter({
  context,
  creating,
  canSubmit,
  metadataError,
  metadataErrorId,
  onCancel
}: {
  context: CreateIssueContext;
  creating: boolean;
  canSubmit: boolean;
  metadataError: string | null;
  metadataErrorId: string;
  onCancel: () => void;
}) {
  return (
    <DialogFooter className="border-t border-border-hairline pt-4">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        disabled={creating}
        onClick={onCancel}
      >
        Cancel
      </Button>
      <Button
        type="submit"
        size="sm"
        disabled={!canSubmit || creating}
        aria-describedby={metadataError ? metadataErrorId : undefined}
      >
        {creating ? 'Creating…' : `Create ${sourceName(context.source)} issue`}
      </Button>
    </DialogFooter>
  );
}

export function CreateIssueDialog(props: CreateIssueDialogProps) {
  const { projectId, open, onOpenChange, onCreated } = props;
  const assisted = props.mode === 'composer-assisted';
  const initialPrompt = assisted ? props.initialPrompt : '';
  const navigate = useBbNavigate();
  const formId = useId();
  const metadataErrorId = `${formId}-metadata-error`;
  const form = useCreateIssueForm({ open, assisted, initialPrompt });
  const submitState = useCreateIssueSubmitState();
  const metadataState = useCreateIssueMetadataState();
  const { context, contextError } = useCreateIssueContext({
    open,
    projectId,
    form,
    metadataState,
    submitState
  });
  useCreateIssueMetadata({ open, projectId, context, form, metadataState });

  const { creating, createError, setCreateError } = submitState;
  const { metadataError } = metadataState;
  const closeDialog = () => {
    onOpenChange(false);
  };
  const currentMetadataScope = currentMetadataScopeKey(
    projectId,
    context,
    form.destinationId,
    form.issueType
  );
  const create = useCreateIssueSubmit({
    projectId,
    context,
    form,
    metadataState,
    submitState,
    currentMetadataScope,
    onCreated,
    onOpenChange
  });
  const canSubmit = canSubmitIssue({
    context,
    createOutcomeUncertain: submitState.createOutcomeUncertain,
    metadataLoading: metadataState.metadataLoading,
    loadedConnectorRevision: metadataState.loadedConnectorRevision,
    currentMetadataScope,
    loadedMetadataScope: metadataState.loadedMetadataScope,
    title: form.title,
    destinationId: form.destinationId,
    issueType: form.issueType
  });
  const editablePromptFields = (
    <EditablePromptFields
      formId={formId}
      assisted={assisted}
      form={form}
      creating={creating}
      onEdit={() => setCreateError(null)}
    />
  );

  return (
    <Dialog
      open={open}
      onOpenChange={nextOpen => {
        if (!creating) {
          if (nextOpen) onOpenChange(true);
          else closeDialog();
        }
      }}
    >
      <DialogContent className="sm:max-w-2xl">
        <CreateIssueDialogHeader context={context} assisted={assisted} />

        {contextError ? (
          <div className="grid gap-4">
            {assisted ? editablePromptFields : null}
            <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3">
              <p role="alert" className="text-sm text-destructive">
                {contextError}
              </p>
            </div>
          </div>
        ) : context === undefined ? (
          <div className="grid gap-4" aria-label="Loading issue provider">
            {assisted ? editablePromptFields : null}
            <div className="space-y-3 py-1">
              <Skeleton className="h-9 w-full" />
              <Skeleton className="h-9 w-full" />
              {!assisted ? <Skeleton className="h-28 w-full" /> : null}
            </div>
          </div>
        ) : !context.available ? (
          <div className="space-y-3 rounded-lg border border-border bg-card p-4">
            {assisted ? editablePromptFields : null}
            <p role="alert" className="text-sm text-muted-foreground">
              {context.message ?? `${sourceName(context.source)} is not ready.`}
            </p>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => {
                closeDialog();
                navigate.toPluginPanel(PANEL_PATH, {
                  subPath: routeToSubPath({
                    kind: 'manage',
                    projectId: context.projectId
                  })
                });
              }}
            >
              <Icon name="Settings" className="size-4" />
              Manage Taskboard
            </Button>
          </div>
        ) : (
          <form id={formId} className="grid gap-4" onSubmit={create}>
            <DestinationField
              formId={formId}
              context={context}
              destinationId={form.destinationId}
              creating={creating}
              onChange={value => {
                form.setDestinationId(value);
                setCreateError(null);
              }}
            />
            {editablePromptFields}
            <IssuePropertyBar
              form={form}
              metadataState={metadataState}
              creating={creating}
              metadataErrorId={metadataErrorId}
            />

            {createError ? (
              <p role="alert" className="text-sm text-destructive">
                {createError}
              </p>
            ) : null}

            <CreateIssueFooter
              context={context}
              creating={creating}
              canSubmit={canSubmit}
              metadataError={metadataError}
              metadataErrorId={metadataErrorId}
              onCancel={closeDialog}
            />
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
