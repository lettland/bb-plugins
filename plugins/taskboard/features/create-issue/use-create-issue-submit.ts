import { useRpc } from '@get-bb/plugin-sdk/app';
import { toast } from 'sonner';
import {
  CREATE_OUTCOME_UNCERTAIN_MARKER,
  type CreateIssueContext,
  type TaskboardRpcContract
} from '../../contract.js';
import {
  rememberCreateAssigneeAfterSuccess
} from '../../browse-preferences.js';
import {
  type CreateIssueForm,
  type CreateIssueMetadataState,
  type CreateIssueSubmitState
} from './use-create-issue-form.js';
import {
  type CreatedIssueResult,
  issueAssigneeScope
} from './create-issue-model.js';
import { sourceName } from '../shared/source.js';
import { describeError } from '../shared/format.js';

export function useCreateIssueSubmit({
  projectId,
  context,
  form,
  metadataState,
  submitState,
  currentMetadataScope,
  onCreated,
  onOpenChange
}: {
  projectId: string | null;
  context: CreateIssueContext | undefined;
  form: CreateIssueForm;
  metadataState: CreateIssueMetadataState;
  submitState: CreateIssueSubmitState;
  currentMetadataScope: string | null;
  onCreated?: (result: CreatedIssueResult) => void;
  onOpenChange: (open: boolean) => void;
}) {
  const rpc = useRpc<TaskboardRpcContract>();
  const { creating, createOutcomeUncertain, setCreating } = submitState;
  const { setCreateError, setCreateOutcomeUncertain } = submitState;
  const { metadataLoading, loadedConnectorRevision, loadedMetadataScope } =
    metadataState;

  return async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (
      !projectId ||
      !context?.available ||
      creating ||
      createOutcomeUncertain ||
      metadataLoading ||
      loadedConnectorRevision === null ||
      currentMetadataScope === null ||
      loadedMetadataScope !== currentMetadataScope
    ) {
      return;
    }
    setCreating(true);
    setCreateError(null);
    try {
      const { destinationId, issueType, assigneeId } = form;
      const submittedScope = issueAssigneeScope(
        projectId,
        context,
        destinationId,
        issueType
      );
      const result = await rememberCreateAssigneeAfterSuccess(
        rpc.call('createIssue', {
          projectId,
          expectedSource: context.source,
          connectorRevision: loadedConnectorRevision,
          title: form.title,
          description: form.description,
          destinationId,
          issueType: context.source === 'jira' ? issueType : null,
          statusId: form.statusId,
          assigneeId,
          priorityId: form.priorityId,
          labelIds: form.labelIds,
          dueDate: form.dueDate || null,
          milestoneId: form.milestoneId
        }),
        submittedScope,
        assigneeId
      );
      onCreated?.(result);
      toast.success(`${result.item.key} created in ${sourceName(result.item.source)}`);
      if (result.warnings.length > 0) {
        toast.warning(result.warnings.join(' '));
      }
      onOpenChange(false);
    } catch (error) {
      const message = describeError(error);
      const uncertain = message.includes(CREATE_OUTCOME_UNCERTAIN_MARKER);
      setCreateOutcomeUncertain(uncertain);
      setCreateError(
        message.replace(CREATE_OUTCOME_UNCERTAIN_MARKER, '').trim()
      );
    } finally {
      setCreating(false);
    }
  };
}
