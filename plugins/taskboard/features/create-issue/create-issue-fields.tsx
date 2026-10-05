import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import {
  type CreateIssueContext,
  type CreateIssueMetadata
} from '../../contract.js';
import {
  type CreateIssueForm,
  type CreateIssueMetadataState
} from './use-create-issue-form.js';
import {
  IssueLabelsSelect,
  IssuePropertySelect
} from './issue-property-selects.js';

export function EditablePromptFields({
  formId,
  assisted,
  form,
  creating,
  onEdit
}: {
  formId: string;
  assisted: boolean;
  form: CreateIssueForm;
  creating: boolean;
  onEdit: () => void;
}) {
  return (
    <>
      {assisted ? (
        <div className="flex items-start gap-2.5 rounded-lg border border-border bg-surface-recessed-solid p-3">
          <Icon
            name="ListTodo"
            className="mt-0.5 size-4 shrink-0 text-muted-foreground"
            aria-hidden="true"
          />
          <div className="space-y-0.5">
            <p className="text-sm font-medium">Prompt copied for review</p>
            <p className="text-xs text-muted-foreground">
              Your prompt was copied into these editable fields. Nothing is
              created until you select Create.
            </p>
          </div>
        </div>
      ) : null}

      <div className="grid gap-1.5">
        <label htmlFor={`${formId}-title`} className="text-xs font-semibold">
          Title
        </label>
        <Input
          id={`${formId}-title`}
          value={form.title}
          autoFocus
          maxLength={500}
          placeholder="What needs to be done?"
          disabled={creating}
          onChange={event => {
            form.setTitle(event.target.value);
            onEdit();
          }}
        />
      </div>

      <div className="grid gap-1.5">
        <label
          htmlFor={`${formId}-description`}
          className="text-xs font-semibold"
        >
          Description
        </label>
        <Textarea
          id={`${formId}-description`}
          value={form.description}
          rows={9}
          maxLength={100_000}
          placeholder="Add context, acceptance criteria, or links…"
          disabled={creating}
          onChange={event => {
            form.setDescription(event.target.value);
            onEdit();
          }}
        />
        <p className="text-xs text-muted-foreground">
          Markdown is supported by GitHub and Linear. Jira receives formatted
          text.
        </p>
      </div>
    </>
  );
}

export function DestinationField({
  formId,
  context,
  destinationId,
  creating,
  onChange
}: {
  formId: string;
  context: CreateIssueContext;
  destinationId: string;
  creating: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <div className="grid gap-1.5">
      <label
        htmlFor={`${formId}-destination`}
        className="text-xs font-semibold"
      >
        {context.destinationLabel}
      </label>
      {context.allowsCustomDestination ? (
        <Input
          id={`${formId}-destination`}
          value={destinationId}
          autoCapitalize="characters"
          autoCorrect="off"
          spellCheck={false}
          placeholder="ENG"
          disabled={creating}
          onChange={event => onChange(event.target.value)}
        />
      ) : context.destinations.length > 1 ? (
        <Select
          value={destinationId}
          disabled={creating}
          onValueChange={onChange}
        >
          <SelectTrigger id={`${formId}-destination`} className="w-full">
            <SelectValue placeholder={`Choose ${context.destinationLabel.toLowerCase()}`} />
          </SelectTrigger>
          <SelectContent>
            {context.destinations.map(destination => (
              <SelectItem key={destination.id} value={destination.id}>
                {destination.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : (
        <div
          id={`${formId}-destination`}
          className="flex h-9 items-center rounded-md border border-border bg-surface-recessed-solid px-3 text-sm"
        >
          {context.destinations[0]?.label}
        </div>
      )}
      {context.source === 'jira' && context.destinations.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          Taskboard could not infer a project key from the JQL, so enter it here.
        </p>
      ) : null}
    </div>
  );
}

function MetadataFields({
  metadata,
  form,
  creating
}: {
  metadata: CreateIssueMetadata;
  form: CreateIssueForm;
  creating: boolean;
}) {
  return (
    <>
      {metadata.statusOptions.length > 0 ? (
        <IssuePropertySelect
          icon="Circle"
          label="Status"
          value={form.statusId}
          options={metadata.statusOptions}
          onChange={form.setStatusId}
          disabled={creating}
        />
      ) : null}
      {metadata.assigneeOptions.length > 0 ? (
        <IssuePropertySelect
          icon="UserRound"
          label="Assignee"
          value={form.assigneeId}
          options={metadata.assigneeOptions}
          onChange={form.setAssigneeId}
          disabled={creating}
        />
      ) : null}
      {metadata.priorityOptions.length > 0 ? (
        <IssuePropertySelect
          icon="ChartColumn"
          label="Priority"
          value={form.priorityId}
          options={metadata.priorityOptions}
          onChange={form.setPriorityId}
          disabled={creating}
        />
      ) : null}
      {metadata.labelOptions.length > 0 ? (
        <IssueLabelsSelect
          options={metadata.labelOptions}
          values={form.labelIds}
          onChange={form.setLabelIds}
          disabled={creating}
        />
      ) : null}
      {metadata.supportsDueDate ? (
        <label className="flex h-8 items-center gap-1.5 rounded-lg border border-border bg-background px-2.5 text-xs font-medium focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-1">
          <Icon name="Calendar" className="size-3.5 text-muted-foreground" />
          <span className="sr-only">Due date</span>
          <input
            type="date"
            value={form.dueDate}
            disabled={creating}
            aria-label="Due date"
            className="w-[7.3rem] border-0 bg-transparent p-0 text-xs outline-none disabled:opacity-60"
            onChange={event => form.setDueDate(event.target.value)}
          />
        </label>
      ) : null}
      {metadata.milestoneOptions.length > 0 ? (
        <IssuePropertySelect
          icon="Target"
          label="Milestone"
          value={form.milestoneId}
          options={metadata.milestoneOptions}
          onChange={form.setMilestoneId}
          disabled={creating}
        />
      ) : null}
      {metadata.issueTypeOptions.length > 0 ? (
        <IssuePropertySelect
          icon="Ticket"
          label="Issue type"
          value={form.issueType || null}
          options={metadata.issueTypeOptions}
          onChange={value => form.setIssueType(value ?? '')}
          disabled={creating}
        />
      ) : null}
    </>
  );
}

function MetadataErrorNotice({
  id,
  message,
  loading,
  onRetry
}: {
  id: string;
  message: string;
  loading: boolean;
  onRetry: () => void;
}) {
  return (
    <div
      id={id}
      role="alert"
      className="flex min-w-0 items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-destructive"
    >
      <Icon
        name="AlertCircle"
        className="mt-0.5 size-3.5 shrink-0"
        aria-hidden="true"
      />
      <div className="min-w-0 flex-1 space-y-0.5">
        <p className="text-xs font-medium">
          Couldn&apos;t load creation options
        </p>
        <p className="break-words text-xs">{message}</p>
      </div>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-7 shrink-0 px-2 text-xs"
        disabled={loading}
        onClick={onRetry}
      >
        {loading ? 'Retrying…' : 'Retry'}
      </Button>
    </div>
  );
}

export function IssuePropertyBar({
  form,
  metadataState,
  creating,
  metadataErrorId
}: {
  form: CreateIssueForm;
  metadataState: CreateIssueMetadataState;
  creating: boolean;
  metadataErrorId: string;
}) {
  const { metadata, metadataLoading, metadataError, setMetadataRevision } =
    metadataState;
  return (
    <div className="flex flex-wrap items-center gap-1.5 border-t border-border-hairline pt-3">
      {metadataLoading ? (
        <>
          <Skeleton className="h-8 w-20 rounded-lg" />
          <Skeleton className="h-8 w-24 rounded-lg" />
          <Skeleton className="h-8 w-20 rounded-lg" />
        </>
      ) : metadata ? (
        <MetadataFields metadata={metadata} form={form} creating={creating} />
      ) : null}
      {metadataError ? (
        <MetadataErrorNotice
          id={metadataErrorId}
          message={metadataError}
          loading={metadataLoading}
          onRetry={() => setMetadataRevision(value => value + 1)}
        />
      ) : null}
    </div>
  );
}
