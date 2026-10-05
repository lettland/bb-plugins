import { useEffect, useState } from 'react';
import { useRpc } from '@get-bb/plugin-sdk/app';
import {
  type CreateIssueContext,
  type CreateIssueMetadata,
  type TaskboardRpcContract
} from '../../contract.js';
import {
  createAssigneeScope,
  restoreRememberedCreateAssignee
} from '../../browse-preferences.js';
import {
  type CreateIssueForm,
  type CreateIssueMetadataState,
  type CreateIssueSubmitState
} from './use-create-issue-form.js';
import { describeError } from '../shared/format.js';
import { CREATE_METADATA_NETWORK_ERROR } from './create-issue-model.js';

export function useCreateIssueContext({
  open,
  projectId,
  form,
  metadataState,
  submitState
}: {
  open: boolean;
  projectId: string | null;
  form: CreateIssueForm;
  metadataState: CreateIssueMetadataState;
  submitState: CreateIssueSubmitState;
}) {
  const rpc = useRpc<TaskboardRpcContract>();
  const [context, setContext] = useState<CreateIssueContext>();
  const [contextError, setContextError] = useState<string | null>(null);
  const { setDestinationId, setIssueType, resetProperties } = form;
  const { setCreating, setCreateError, setCreateOutcomeUncertain } =
    submitState;
  const { resetMetadata } = metadataState;

  useEffect(() => {
    if (!open) return;
    setContext(undefined);
    setContextError(null);
    setDestinationId('');
    setIssueType('');
    resetMetadata();
    resetProperties();
    setCreating(false);
    setCreateError(null);
    setCreateOutcomeUncertain(false);
    if (!projectId) {
      setContextError('Choose a BB project before creating an issue.');
      return;
    }
    let active = true;
    void rpc
      .call('getCreateIssueContext', { projectId })
      .then(result => {
        if (!active) return;
        setContext(result.context);
        setDestinationId(result.context.defaultDestinationId ?? '');
        setIssueType(result.context.defaultIssueType ?? '');
      })
      .catch(error => {
        if (active) setContextError(describeError(error));
      });
    return () => {
      active = false;
    };
  }, [open, projectId, rpc]);

  return { context, contextError };
}

function applyLoadedMetadata({
  loaded,
  requestedIssueType,
  projectId,
  context,
  form,
  metadataState
}: {
  loaded: { metadata: CreateIssueMetadata; connectorRevision: number };
  requestedIssueType: string | null;
  projectId: string;
  context: CreateIssueContext;
  form: CreateIssueForm;
  metadataState: CreateIssueMetadataState;
}): void {
  const { metadata, connectorRevision } = loaded;
  const selectedIssueType =
    requestedIssueType &&
    metadata.issueTypeOptions.some(option => option.id === requestedIssueType)
      ? requestedIssueType
      : metadata.defaultIssueTypeId;
  const resolvedScope = createAssigneeScope(
    projectId,
    context.source,
    form.destinationId,
    context.source === 'jira' ? selectedIssueType : null
  );
  metadataState.setMetadata(metadata);
  metadataState.setLoadedMetadataScope(JSON.stringify(resolvedScope));
  metadataState.setLoadedConnectorRevision(connectorRevision);
  form.setStatusId(metadata.defaultStatusId);
  if (selectedIssueType) {
    form.setIssueType(selectedIssueType);
  }
  form.setAssigneeId(
    restoreRememberedCreateAssignee(resolvedScope, metadata.assigneeOptions)
  );
}

export function useCreateIssueMetadata({
  open,
  projectId,
  context,
  form,
  metadataState
}: {
  open: boolean;
  projectId: string | null;
  context: CreateIssueContext | undefined;
  form: CreateIssueForm;
  metadataState: CreateIssueMetadataState;
}) {
  const rpc = useRpc<TaskboardRpcContract>();
  const { destinationId, issueType, resetProperties } = form;
  const { metadataRevision, resetMetadata } = metadataState;
  const { setMetadataLoading, setMetadataError } = metadataState;

  useEffect(() => {
    resetMetadata();
    resetProperties();
    if (
      !open ||
      !projectId ||
      context?.available !== true ||
      destinationId.trim() === ''
    ) {
      return;
    }
    const requestedIssueType =
      context.source === 'jira' ? issueType.trim() || null : null;
    let active = true;
    setMetadataLoading(true);
    const timeout = window.setTimeout(() => {
      void rpc
        .call('getCreateIssueMetadata', {
          projectId,
          expectedSource: context.source,
          destinationId,
          issueType: requestedIssueType
        })
        .then(result => {
          if (!active) return;
          if (!result.ok) {
            setMetadataError(result.error.safeMessage);
            return;
          }
          applyLoadedMetadata({
            loaded: result,
            requestedIssueType,
            projectId,
            context,
            form,
            metadataState
          });
        })
        .catch(() => {
          if (active) {
            setMetadataError(CREATE_METADATA_NETWORK_ERROR);
          }
        })
        .finally(() => {
          if (active) setMetadataLoading(false);
        });
    }, 220);
    return () => {
      active = false;
      window.clearTimeout(timeout);
    };
  }, [
    context,
    destinationId,
    issueType,
    metadataRevision,
    open,
    projectId,
    rpc
  ]);
}
