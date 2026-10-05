import { useEffect, useMemo, useRef, useState } from 'react';
import { type PluginPendingInteractionProps } from '@get-bb/plugin-sdk/app';
import { Button } from '@/components/ui/button';
import { type ProjectCredentialsInteractionResponse } from '../../contract.js';
import {
  projectCredentialsInteractionPayloadSchema,
  projectCredentialsInteractionResponseSchema
} from '../../credential-contract.js';
import { secretMutation } from './project-config-model.js';
import {
  CredentialStatus,
  RemoveCredentialButton,
  SecretInput
} from './credential-parts.js';

function useCredentialDrafts(interactionId: string) {
  const [linearDraft, setLinearDraft] = useState('');
  const [jiraDraft, setJiraDraft] = useState('');
  const [removeLinear, setRemoveLinear] = useState(false);
  const [removeJira, setRemoveJira] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const interactionIdRef = useRef(interactionId);
  interactionIdRef.current = interactionId;

  useEffect(() => {
    setLinearDraft('');
    setJiraDraft('');
    setRemoveLinear(false);
    setRemoveJira(false);
    setBusy(false);
    setError(null);
  }, [interactionId]);

  return {
    linearDraft,
    setLinearDraft,
    jiraDraft,
    setJiraDraft,
    removeLinear,
    setRemoveLinear,
    removeJira,
    setRemoveJira,
    busy,
    setBusy,
    error,
    setError,
    interactionIdRef
  };
}

type CredentialDrafts = ReturnType<typeof useCredentialDrafts>;

function useCredentialsSubmit(
  drafts: CredentialDrafts,
  interactionId: string,
  submit: PluginPendingInteractionProps['submit']
) {
  const { linearDraft, jiraDraft, removeLinear, removeJira } = drafts;
  const { setLinearDraft, setJiraDraft, setBusy, setError } = drafts;
  const { setRemoveLinear, setRemoveJira, interactionIdRef } = drafts;
  const hasChanges =
    linearDraft.trim() !== '' ||
    jiraDraft.trim() !== '' ||
    removeLinear ||
    removeJira;
  const submitCredentials = async () => {
    const submittedInteractionId = interactionId;
    const response: ProjectCredentialsInteractionResponse = {
      linearCredential: secretMutation(linearDraft, removeLinear),
      jiraCredential: secretMutation(jiraDraft, removeJira)
    };
    const validated =
      projectCredentialsInteractionResponseSchema.safeParse(response);
    if (!validated.success || !hasChanges) {
      setError('Enter or remove at least one project credential.');
      return;
    }
    setError(null);
    setBusy(true);
    try {
      await submit(validated.data);
      if (interactionIdRef.current !== submittedInteractionId) return;
      setLinearDraft('');
      setJiraDraft('');
      setRemoveLinear(false);
      setRemoveJira(false);
    } catch {
      // The host renders submission failures outside the plugin form.
    } finally {
      if (interactionIdRef.current === submittedInteractionId) setBusy(false);
    }
  };
  return { hasChanges, submitCredentials };
}

function CredentialDraftCard({
  provider,
  inputId,
  label,
  configured,
  draft,
  removed,
  busy,
  placeholders,
  onDraftChange,
  onToggleRemove
}: {
  provider: 'Linear' | 'Jira';
  inputId: string;
  label: string;
  configured: boolean;
  draft: string;
  removed: boolean;
  busy: boolean;
  placeholders: { replace: string; enter: string };
  onDraftChange: (value: string) => void;
  onToggleRemove: () => void;
}) {
  return (
    <div className="rounded-lg border border-border bg-card p-3">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <label htmlFor={inputId} className="text-xs font-semibold">
          {label}
        </label>
        <CredentialStatus
          configured={configured}
          hasDraft={draft.trim() !== ''}
          remove={removed}
        />
      </div>
      <SecretInput
        id={inputId}
        value={draft}
        placeholder={configured ? placeholders.replace : placeholders.enter}
        disabled={busy || removed}
        onChange={event => onDraftChange(event.target.value)}
      />
      {configured ? (
        <RemoveCredentialButton
          provider={provider}
          removed={removed}
          disabled={busy}
          className="mt-2 text-destructive hover:text-destructive"
          showIcon={false}
          onToggle={onToggleRemove}
        />
      ) : null}
    </div>
  );
}

function ProjectCredentialsInteractionForm({
  interaction,
  submit,
  cancel
}: PluginPendingInteractionProps) {
  const parsed = useMemo(
    () =>
      projectCredentialsInteractionPayloadSchema.safeParse(interaction.payload),
    [interaction.payload]
  );
  const drafts = useCredentialDrafts(interaction.id);
  const { hasChanges, submitCredentials } = useCredentialsSubmit(
    drafts,
    interaction.id,
    submit
  );
  const { busy, error, setError } = drafts;

  if (!parsed.success) {
    return (
      <div className="space-y-3">
        <p role="alert" className="text-sm text-muted-foreground">
          This project credential request is invalid.
        </p>
        <Button
          type="button"
          variant="outline"
          onClick={() => void cancel().catch(() => undefined)}
        >
          Cancel
        </Button>
      </div>
    );
  }
  const payload = parsed.data;

  return (
    <form
      className="space-y-4"
      onSubmit={event => {
        event.preventDefault();
        void submitCredentials();
      }}
    >
      <div className="space-y-1">
        <p className="text-sm font-semibold">{payload.projectName}</p>
        <p className="text-xs leading-relaxed text-muted-foreground">
          Credentials entered here are write-only and isolated to this BB
          project. Existing values are never loaded into the form.
        </p>
      </div>

      <dl className="grid gap-2 rounded-lg border border-border bg-surface-recessed p-3 text-xs sm:grid-cols-3">
        {[
          ['Linear team', payload.linearTeamKey || 'Not configured'],
          ['Jira site', payload.jiraBaseUrl || 'Not configured'],
          ['Jira account', payload.jiraEmail || 'Not configured']
        ].map(([label, value]) => (
          <div key={label} className="min-w-0 space-y-0.5">
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="truncate font-medium text-foreground" title={value}>
              {value}
            </dd>
          </div>
        ))}
      </dl>

      <div className="space-y-3">
        <CredentialDraftCard
          provider="Linear"
          inputId={`linear-${interaction.id}`}
          label="Linear API key"
          configured={payload.linearCredentialConfigured}
          draft={drafts.linearDraft}
          removed={drafts.removeLinear}
          busy={busy}
          placeholders={{
            replace: 'Enter to replace current key',
            enter: 'Enter project API key'
          }}
          onDraftChange={value => {
            drafts.setLinearDraft(value);
            setError(null);
          }}
          onToggleRemove={() => {
            drafts.setRemoveLinear(value => !value);
            drafts.setLinearDraft('');
            setError(null);
          }}
        />
        <CredentialDraftCard
          provider="Jira"
          inputId={`jira-${interaction.id}`}
          label="Jira API token"
          configured={payload.jiraCredentialConfigured}
          draft={drafts.jiraDraft}
          removed={drafts.removeJira}
          busy={busy}
          placeholders={{
            replace: 'Enter to replace current token',
            enter: 'Enter project API token'
          }}
          onDraftChange={value => {
            drafts.setJiraDraft(value);
            setError(null);
          }}
          onToggleRemove={() => {
            drafts.setRemoveJira(value => !value);
            drafts.setJiraDraft('');
            setError(null);
          }}
        />
      </div>

      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
      <div className="flex flex-col-reverse gap-2 border-t border-border-hairline pt-4 sm:flex-row sm:justify-end">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={busy}
          onClick={() => void cancel().catch(() => undefined)}
        >
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={busy || !hasChanges}>
          {busy ? 'Saving…' : 'Save credentials'}
        </Button>
      </div>
    </form>
  );
}

export function ProjectCredentialsInteraction(
  props: PluginPendingInteractionProps
) {
  return (
    <ProjectCredentialsInteractionForm key={props.interaction.id} {...props} />
  );
}
