import { useCallback, useEffect, useRef, useState } from 'react';
import { type CreateIssueMetadata } from '../../contract.js';
import { titleFromPrompt } from './create-issue-model.js';

export function useCreateIssueForm({
  open,
  assisted,
  initialPrompt
}: {
  open: boolean;
  assisted: boolean;
  initialPrompt: string;
}) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [destinationId, setDestinationId] = useState('');
  const [issueType, setIssueType] = useState('');
  const [statusId, setStatusId] = useState<string | null>(null);
  const [assigneeId, setAssigneeId] = useState<string | null>(null);
  const [priorityId, setPriorityId] = useState<string | null>(null);
  const [labelIds, setLabelIds] = useState<string[]>([]);
  const [dueDate, setDueDate] = useState('');
  const [milestoneId, setMilestoneId] = useState<string | null>(null);
  const initializedForOpenRef = useRef(false);

  useEffect(() => {
    if (!open) {
      initializedForOpenRef.current = false;
      return;
    }
    if (initializedForOpenRef.current) return;
    initializedForOpenRef.current = true;
    setTitle(assisted ? titleFromPrompt(initialPrompt) : '');
    setDescription(assisted ? initialPrompt.trim() : '');
  }, [assisted, initialPrompt, open]);

  const resetProperties = useCallback(() => {
    setStatusId(null);
    setAssigneeId(null);
    setPriorityId(null);
    setLabelIds([]);
    setDueDate('');
    setMilestoneId(null);
  }, []);

  return {
    title,
    setTitle,
    description,
    setDescription,
    destinationId,
    setDestinationId,
    issueType,
    setIssueType,
    statusId,
    setStatusId,
    assigneeId,
    setAssigneeId,
    priorityId,
    setPriorityId,
    labelIds,
    setLabelIds,
    dueDate,
    setDueDate,
    milestoneId,
    setMilestoneId,
    resetProperties
  };
}

export type CreateIssueForm = ReturnType<typeof useCreateIssueForm>;

export function useCreateIssueSubmitState() {
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [createOutcomeUncertain, setCreateOutcomeUncertain] = useState(false);
  return {
    creating,
    setCreating,
    createError,
    setCreateError,
    createOutcomeUncertain,
    setCreateOutcomeUncertain
  };
}

export type CreateIssueSubmitState = ReturnType<
  typeof useCreateIssueSubmitState
>;

export function useCreateIssueMetadataState() {
  const [metadata, setMetadata] = useState<CreateIssueMetadata>();
  const [metadataLoading, setMetadataLoading] = useState(false);
  const [metadataError, setMetadataError] = useState<string | null>(null);
  const [loadedMetadataScope, setLoadedMetadataScope] = useState<string | null>(
    null
  );
  const [loadedConnectorRevision, setLoadedConnectorRevision] = useState<
    number | null
  >(null);
  const [metadataRevision, setMetadataRevision] = useState(0);

  const resetMetadata = useCallback(() => {
    setMetadata(undefined);
    setMetadataLoading(false);
    setMetadataError(null);
    setLoadedMetadataScope(null);
    setLoadedConnectorRevision(null);
  }, []);

  return {
    metadata,
    setMetadata,
    metadataLoading,
    setMetadataLoading,
    metadataError,
    setMetadataError,
    loadedMetadataScope,
    setLoadedMetadataScope,
    loadedConnectorRevision,
    setLoadedConnectorRevision,
    metadataRevision,
    setMetadataRevision,
    resetMetadata
  };
}

export type CreateIssueMetadataState = ReturnType<
  typeof useCreateIssueMetadataState
>;
