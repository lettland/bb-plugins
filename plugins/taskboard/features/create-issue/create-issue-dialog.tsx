import { useEffect, useId, useRef, useState } from 'react';
import { useBbNavigate, useRpc } from '@get-bb/plugin-sdk/app';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu';
import { Icon, type IconName } from '@/components/ui/icon';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
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
  type AssigneeConfirmation,
  CREATE_OUTCOME_UNCERTAIN_MARKER,
  type CreateIssueContext,
  type CreateIssueMetadata,
  type CreateIssueOption,
  type TaskboardRpcContract,
  type WorkItem
} from '../../contract.js';
import {
  createAssigneeScope,
  rememberCreateAssigneeAfterSuccess,
  restoreRememberedCreateAssignee
} from '../../browse-preferences.js';
import { describeError } from '../shared/format.js';
import { SourceGlyph, sourceName } from '../shared/source.js';
import { PANEL_PATH } from '../shared/constants.js';
import { routeToSubPath } from '../shared/route.js';

const CREATE_METADATA_NETWORK_ERROR =
  'Taskboard could not load issue creation options. Check the connection and try again.';

interface CreatedIssueResult {
  item: WorkItem;
  warnings: string[];
  assigneeConfirmation: AssigneeConfirmation;
  mention: {
    provider: 'external-work-item';
    id: string;
    label: string;
  };
}

function titleFromPrompt(prompt: string): string {
  const firstLine = prompt
    .split(/\r?\n/u)
    .map(line => line.trim())
    .find(Boolean);
  if (!firstLine) return '';
  return firstLine.replace(/^#{1,6}\s+/u, '').slice(0, 120);
}

function createOptionLabel(
  options: readonly CreateIssueOption[],
  value: string | null,
  fallback: string
): string {
  if (!value) return fallback;
  return options.find(option => option.id === value)?.label ?? fallback;
}

function IssuePropertySelect({
  icon,
  label,
  value,
  options,
  onChange,
  disabled = false
}: {
  icon: IconName;
  label: string;
  value: string | null;
  options: readonly CreateIssueOption[];
  onChange: (value: string | null) => void;
  disabled?: boolean;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-8 gap-1.5 rounded-lg bg-background px-2.5 text-xs font-medium shadow-none"
          disabled={disabled}
          aria-label={`${label}: ${createOptionLabel(options, value, `No ${label.toLowerCase()}`)}`}
        >
          <Icon name={icon} className="size-3.5 text-muted-foreground" />
          <span className={cn(!value && 'text-muted-foreground')}>
            {createOptionLabel(options, value, label)}
          </span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className="max-h-72 min-w-56 overflow-y-auto"
        mobileTitle={label}
      >
        <DropdownMenuItem onSelect={() => onChange(null)}>
          <span className="text-muted-foreground">
            No {label.toLowerCase()}
          </span>
          {value === null ? (
            <Icon name="Check" className="ml-auto size-3.5" />
          ) : null}
        </DropdownMenuItem>
        {options.map(option => (
          <DropdownMenuItem
            key={option.id}
            onSelect={() => onChange(option.id)}
          >
            <span className="min-w-0 flex-1 truncate">{option.label}</span>
            {value === option.id ? (
              <Icon name="Check" className="ml-auto size-3.5" />
            ) : null}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function IssueLabelsSelect({
  options,
  values,
  onChange,
  disabled = false
}: {
  options: readonly CreateIssueOption[];
  values: readonly string[];
  onChange: (values: string[]) => void;
  disabled?: boolean;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-8 gap-1.5 rounded-lg bg-background px-2.5 text-xs font-medium shadow-none"
          disabled={disabled}
          aria-label={`${values.length} labels selected`}
        >
          <Icon name="Layers" className="size-3.5 text-muted-foreground" />
          <span className={cn(values.length === 0 && 'text-muted-foreground')}>
            {values.length === 0
              ? 'Labels'
              : `${values.length} label${values.length === 1 ? '' : 's'}`}
          </span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className="max-h-72 min-w-56 overflow-y-auto"
        mobileTitle="Labels"
      >
        {options.map(option => (
          <DropdownMenuCheckboxItem
            key={option.id}
            checked={values.includes(option.id)}
            onSelect={event => event.preventDefault()}
            onCheckedChange={checked => {
              onChange(
                checked
                  ? [...new Set([...values, option.id])]
                  : values.filter(value => value !== option.id)
              );
            }}
          >
            {option.label}
          </DropdownMenuCheckboxItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

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

export function CreateIssueDialog(props: CreateIssueDialogProps) {
  const { projectId, open, onOpenChange, onCreated } = props;
  const assisted = props.mode === 'composer-assisted';
  const initialPrompt = assisted ? props.initialPrompt : '';
  const rpc = useRpc<TaskboardRpcContract>();
  const navigate = useBbNavigate();
  const formId = useId();
  const metadataErrorId = `${formId}-metadata-error`;
  const [context, setContext] = useState<CreateIssueContext>();
  const [contextError, setContextError] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [destinationId, setDestinationId] = useState('');
  const [issueType, setIssueType] = useState('');
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
  const [statusId, setStatusId] = useState<string | null>(null);
  const [assigneeId, setAssigneeId] = useState<string | null>(null);
  const [priorityId, setPriorityId] = useState<string | null>(null);
  const [labelIds, setLabelIds] = useState<string[]>([]);
  const [dueDate, setDueDate] = useState('');
  const [milestoneId, setMilestoneId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [createOutcomeUncertain, setCreateOutcomeUncertain] = useState(false);
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

  useEffect(() => {
    if (!open) return;
    setContext(undefined);
    setContextError(null);
    setDestinationId('');
    setIssueType('');
    setMetadata(undefined);
    setMetadataLoading(false);
    setMetadataError(null);
    setLoadedMetadataScope(null);
    setLoadedConnectorRevision(null);
    setStatusId(null);
    setAssigneeId(null);
    setPriorityId(null);
    setLabelIds([]);
    setDueDate('');
    setMilestoneId(null);
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

  useEffect(() => {
    setMetadata(undefined);
    setMetadataLoading(false);
    setMetadataError(null);
    setLoadedMetadataScope(null);
    setLoadedConnectorRevision(null);
    setStatusId(null);
    setAssigneeId(null);
    setPriorityId(null);
    setLabelIds([]);
    setDueDate('');
    setMilestoneId(null);
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
          const selectedIssueType =
            requestedIssueType &&
            result.metadata.issueTypeOptions.some(
              option => option.id === requestedIssueType
            )
              ? requestedIssueType
              : result.metadata.defaultIssueTypeId;
          const resolvedScope = createAssigneeScope(
            projectId,
            context.source,
            destinationId,
            context.source === 'jira' ? selectedIssueType : null
          );
          setMetadata(result.metadata);
          setLoadedMetadataScope(JSON.stringify(resolvedScope));
          setLoadedConnectorRevision(result.connectorRevision);
          setStatusId(result.metadata.defaultStatusId);
          if (selectedIssueType) {
            setIssueType(selectedIssueType);
          }
          setAssigneeId(
            restoreRememberedCreateAssignee(
              resolvedScope,
              result.metadata.assigneeOptions
            )
          );
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

  const closeDialog = () => {
    onOpenChange(false);
  };

  const currentMetadataScope =
    projectId && context?.available === true && destinationId.trim() !== ''
      ? JSON.stringify(
          createAssigneeScope(
            projectId,
            context.source,
            destinationId,
            context.source === 'jira' ? issueType.trim() || null : null
          )
        )
      : null;

  const create = async (event: React.FormEvent<HTMLFormElement>) => {
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
      const submittedScope = createAssigneeScope(
        projectId,
        context.source,
        destinationId,
        context.source === 'jira' ? issueType.trim() || null : null
      );
      const result = await rememberCreateAssigneeAfterSuccess(
        rpc.call('createIssue', {
          projectId,
          expectedSource: context.source,
          connectorRevision: loadedConnectorRevision,
          title,
          description,
          destinationId,
          issueType: context.source === 'jira' ? issueType : null,
          statusId,
          assigneeId,
          priorityId,
          labelIds,
          dueDate: dueDate || null,
          milestoneId
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

  const canSubmit =
    context?.available === true &&
    !createOutcomeUncertain &&
    !metadataLoading &&
    loadedConnectorRevision !== null &&
    currentMetadataScope !== null &&
    loadedMetadataScope === currentMetadataScope &&
    title.trim() !== '' &&
    destinationId.trim() !== '' &&
    (context.source !== 'jira' || issueType.trim() !== '');

  const editablePromptFields = (
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
          value={title}
          autoFocus
          maxLength={500}
          placeholder="What needs to be done?"
          disabled={creating}
          onChange={event => {
            setTitle(event.target.value);
            setCreateError(null);
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
          value={description}
          rows={9}
          maxLength={100_000}
          placeholder="Add context, acceptance criteria, or links…"
          disabled={creating}
          onChange={event => {
            setDescription(event.target.value);
            setCreateError(null);
          }}
        />
        <p className="text-xs text-muted-foreground">
          Markdown is supported by GitHub and Linear. Jira receives formatted
          text.
        </p>
      </div>
    </>
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
                  onChange={event => {
                    setDestinationId(event.target.value);
                    setCreateError(null);
                  }}
                />
              ) : context.destinations.length > 1 ? (
                <Select
                  value={destinationId}
                  disabled={creating}
                  onValueChange={value => {
                    setDestinationId(value);
                    setCreateError(null);
                  }}
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

            <>
              {editablePromptFields}

                <div className="flex flex-wrap items-center gap-1.5 border-t border-border-hairline pt-3">
                  {metadataLoading ? (
                    <>
                      <Skeleton className="h-8 w-20 rounded-lg" />
                      <Skeleton className="h-8 w-24 rounded-lg" />
                      <Skeleton className="h-8 w-20 rounded-lg" />
                    </>
                  ) : metadata ? (
                    <>
                      {metadata.statusOptions.length > 0 ? (
                        <IssuePropertySelect
                          icon="Circle"
                          label="Status"
                          value={statusId}
                          options={metadata.statusOptions}
                          onChange={setStatusId}
                          disabled={creating}
                        />
                      ) : null}
                      {metadata.assigneeOptions.length > 0 ? (
                        <IssuePropertySelect
                          icon="UserRound"
                          label="Assignee"
                          value={assigneeId}
                          options={metadata.assigneeOptions}
                          onChange={setAssigneeId}
                          disabled={creating}
                        />
                      ) : null}
                      {metadata.priorityOptions.length > 0 ? (
                        <IssuePropertySelect
                          icon="ChartColumn"
                          label="Priority"
                          value={priorityId}
                          options={metadata.priorityOptions}
                          onChange={setPriorityId}
                          disabled={creating}
                        />
                      ) : null}
                      {metadata.labelOptions.length > 0 ? (
                        <IssueLabelsSelect
                          options={metadata.labelOptions}
                          values={labelIds}
                          onChange={setLabelIds}
                          disabled={creating}
                        />
                      ) : null}
                      {metadata.supportsDueDate ? (
                        <label className="flex h-8 items-center gap-1.5 rounded-lg border border-border bg-background px-2.5 text-xs font-medium focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-1">
                          <Icon
                            name="Calendar"
                            className="size-3.5 text-muted-foreground"
                          />
                          <span className="sr-only">Due date</span>
                          <input
                            type="date"
                            value={dueDate}
                            disabled={creating}
                            aria-label="Due date"
                            className="w-[7.3rem] border-0 bg-transparent p-0 text-xs outline-none disabled:opacity-60"
                            onChange={event => setDueDate(event.target.value)}
                          />
                        </label>
                      ) : null}
                      {metadata.milestoneOptions.length > 0 ? (
                        <IssuePropertySelect
                          icon="Target"
                          label="Milestone"
                          value={milestoneId}
                          options={metadata.milestoneOptions}
                          onChange={setMilestoneId}
                          disabled={creating}
                        />
                      ) : null}
                      {metadata.issueTypeOptions.length > 0 ? (
                        <IssuePropertySelect
                          icon="Ticket"
                          label="Issue type"
                          value={issueType || null}
                          options={metadata.issueTypeOptions}
                          onChange={value => setIssueType(value ?? '')}
                          disabled={creating}
                        />
                      ) : null}
                    </>
                  ) : null}
                  {metadataError ? (
                    <div
                      id={metadataErrorId}
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
                        <p className="break-words text-xs">{metadataError}</p>
                      </div>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-7 shrink-0 px-2 text-xs"
                        disabled={metadataLoading}
                        onClick={() => setMetadataRevision(value => value + 1)}
                      >
                        {metadataLoading ? 'Retrying…' : 'Retry'}
                      </Button>
                    </div>
                  ) : null}
                </div>
            </>

            {createError ? (
              <p role="alert" className="text-sm text-destructive">
                {createError}
              </p>
            ) : null}

            <DialogFooter className="border-t border-border-hairline pt-4">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={creating}
                onClick={closeDialog}
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
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
