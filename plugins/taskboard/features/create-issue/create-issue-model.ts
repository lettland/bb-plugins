import {
  type AssigneeConfirmation,
  type CreateIssueContext,
  type WorkItem
} from '../../contract.js';
import { createAssigneeScope } from '../../browse-preferences.js';

export const CREATE_METADATA_NETWORK_ERROR =
  'Taskboard could not load issue creation options. Check the connection and try again.';

export interface CreatedIssueResult {
  item: WorkItem;
  warnings: string[];
  assigneeConfirmation: AssigneeConfirmation;
  mention: {
    provider: 'external-work-item';
    id: string;
    label: string;
  };
}

export function titleFromPrompt(prompt: string): string {
  const firstLine = prompt
    .split(/\r?\n/u)
    .map(line => line.trim())
    .find(Boolean);
  if (!firstLine) return '';
  return firstLine.replace(/^#{1,6}\s+/u, '').slice(0, 120);
}

export function issueAssigneeScope(
  projectId: string,
  context: CreateIssueContext,
  destinationId: string,
  issueType: string
) {
  return createAssigneeScope(
    projectId,
    context.source,
    destinationId,
    context.source === 'jira' ? issueType.trim() || null : null
  );
}

export function currentMetadataScopeKey(
  projectId: string | null,
  context: CreateIssueContext | undefined,
  destinationId: string,
  issueType: string
): string | null {
  return projectId && context?.available === true && destinationId.trim() !== ''
    ? JSON.stringify(
        issueAssigneeScope(projectId, context, destinationId, issueType)
      )
    : null;
}

export function canSubmitIssue({
  context,
  createOutcomeUncertain,
  metadataLoading,
  loadedConnectorRevision,
  currentMetadataScope,
  loadedMetadataScope,
  title,
  destinationId,
  issueType
}: {
  context: CreateIssueContext | undefined;
  createOutcomeUncertain: boolean;
  metadataLoading: boolean;
  loadedConnectorRevision: number | null;
  currentMetadataScope: string | null;
  loadedMetadataScope: string | null;
  title: string;
  destinationId: string;
  issueType: string;
}): boolean {
  return (
    context?.available === true &&
    !createOutcomeUncertain &&
    !metadataLoading &&
    loadedConnectorRevision !== null &&
    currentMetadataScope !== null &&
    loadedMetadataScope === currentMetadataScope &&
    title.trim() !== '' &&
    destinationId.trim() !== '' &&
    (context.source !== 'jira' || issueType.trim() !== '')
  );
}
