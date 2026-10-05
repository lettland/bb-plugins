import {
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState
} from 'react';
import {
  definePluginApp,
  Markdown,
  type PluginComposerMention,
  type PluginNavPanelProps,
  type PluginNewThreadPanelProps,
  type PluginPendingInteractionProps,
  type PluginThreadHeaderActionProps,
  type PluginThreadPanelProps,
  useBbContext,
  useBbNavigate,
  useComposer,
  useComposerView,
  useRealtime,
  useRpc
} from '@get-bb/plugin-sdk/app';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
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
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger
} from '@/components/ui/tooltip';
import {
  type AssigneeConfirmation,
  CREATE_OUTCOME_UNCERTAIN_MARKER,
  type CreateIssueContext,
  type CreateIssueMetadata,
  type CreateIssueOption,
  FILTER_PRESET_NAME_MAX_LENGTH,
  type FilterPreset,
  formatWorkItemHandoffPrompt,
  type ProjectConfigMutation,
  type ProjectConfigView,
  type ProjectCredentialsInteractionResponse,
  type SecretMutation,
  type TaskboardRpcContract,
  type TrackerProject,
  type WorkItem,
  type WorkItemDetail,
  type WorkSource,
  type WorkStatusOption
} from './contract.js';
import {
  defaultProjectBoardSettings,
  type ProjectBoardSettings,
  projectBoardSettingsSchema
} from './board-settings.js';
import {
  jiraBaseUrlSchema,
  projectCredentialsInteractionPayloadSchema,
  projectCredentialsInteractionResponseSchema
} from './credential-contract.js';
import {
  createAssigneeScope,
  rememberCreateAssigneeAfterSuccess,
  restoreRememberedCreateAssignee
} from './browse-preferences.js';
import {
  availableContextProjectId,
  contextSelectionToken,
  type NavigationEntryLike,
  previousProjectRouteContext,
  projectRouteContext,
  type ProjectRouteContext,
  shouldApplyContextProject
} from './project-selection.js';
import {
  hasTaskboardComposerDragType,
  parseTaskboardComposerMention,
  serializeTaskboardComposerMention,
  TASKBOARD_COMPOSER_MIME,
  taskboardComposerMention
} from './composer-handoff.js';
import {
  parseTrackerRoute,
  routeToSubPath,
  type TrackerRoute
} from './features/shared/route.js';
import {
  loadLastProjectId,
  loadRightPanelPinned,
  loadSidebarCollapsed,
  RIGHT_PANEL_PIN_EVENT,
  RIGHT_PANEL_PINNED_STORAGE_KEY,
  storeLastProjectId,
  storeRightPanelPinned,
  storeSidebarCollapsed
} from './features/shared/storage.js';
import {
  changedProjectId,
  describeError,
  formatUpdatedAt,
  useRefreshOnReconnect
} from './features/shared/format.js';
import {
  SourceGlyph,
  SourceMark,
  sourceName
} from './features/shared/source.js';
import { WorkItemStatusMenu } from './features/list/work-item-row.js';
import { BOARD_FILTER_OPTIONS, toggled } from './features/shared/filters.js';
import {
  useProjectFilterPresets
} from './features/filter-presets/use-project-filter-presets.js';
import { SIDEBAR_AUTO_COLLAPSE_WIDTH } from './features/shared/constants.js';
import { SidebarDrawer, TrackerSidebar } from './features/sidebar/sidebar.js';
import { EmptyState, LoadingRows } from './features/list/list-states.js';
import { TrackerList } from './features/list/tracker-list.js';
import { TrackerTopbar } from './features/sidebar/topbar.js';
import './app.css';

const PANEL_PATH = 'tasks';
const THREAD_PANEL_ACTION_ID = 'taskboard-panel';

const CREATE_METADATA_NETWORK_ERROR =
  'Taskboard could not load issue creation options. Check the connection and try again.';
const COMPOSER_DROP_CUE_TEXT = 'Drop to add ticket to chat';

interface ComposerDropTarget {
  editor: HTMLElement;
  form: HTMLFormElement;
}

function composerDropTarget(target: EventTarget | null): ComposerDropTarget | null {
  const element = target instanceof Element ? target : null;
  const editor = element?.closest<HTMLElement>(
    '[contenteditable="true"][role="textbox"]'
  );
  const form = editor?.closest<HTMLFormElement>('form') ?? null;
  return editor && form ? { editor, form } : null;
}

function loadSourceProjectContext(): ProjectRouteContext | null {
  const browserNavigation = (
    window as Window & {
      navigation?: {
        currentEntry?: { index: number } | null;
        entries(): NavigationEntryLike[];
      };
    }
  ).navigation;
  const currentIndex = browserNavigation?.currentEntry?.index;
  if (browserNavigation !== undefined && currentIndex !== undefined) {
    try {
      return previousProjectRouteContext(
        browserNavigation.entries(),
        currentIndex,
        window.location.origin
      );
    } catch {
      // Fall back to the document referrer when navigation history is unavailable.
    }
  }
  return projectRouteContext(document.referrer, window.location.origin);
}

function ManageHeaderAction({ subPath }: PluginNavPanelProps) {
  const route = parseTrackerRoute(subPath);
  const { projectId: contextProjectId } = useBbContext();
  const navigate = useBbNavigate();
  const routeProjectId =
    route.kind === 'project' || route.kind === 'item'
      ? route.projectId
      : route.kind === 'manage'
        ? route.projectId
        : null;
  const projectId = routeProjectId ?? contextProjectId ?? loadLastProjectId();
  const showCreate = route.kind === 'root' || route.kind === 'project';

  return (
    <div className="flex items-center gap-1.5">
      {showCreate ? (
        <DirectCreateIssueAction projectId={projectId} variant="labeled" />
      ) : null}
      <Button
        type="button"
        size="sm"
        variant="outline"
        onClick={() =>
          navigate.toPluginPanel(PANEL_PATH, {
            subPath: projectId
              ? routeToSubPath({ kind: 'manage', projectId })
              : 'manage'
          })
        }
      >
        <Icon name="Settings" className="size-4" />
        Manage
      </Button>
    </div>
  );
}

const TRACKER_OPTIONS: ReadonlyArray<{
  source: WorkSource;
  description: string;
}> = [
  { source: 'github', description: 'Repository issues' },
  { source: 'linear', description: 'Team issues' },
  { source: 'jira', description: 'JQL-filtered issues' }
];

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

function CreateIssueDialog(props: CreateIssueDialogProps) {
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

function DirectCreateIssueAction({
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

function ComposerCreateIssueAction() {
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

function DetailMetadata({
  item,
  className
}: {
  item: WorkItemDetail;
  className?: string;
}) {
  const fields = [
    ['Source', sourceName(item.source)],
    ['Status', item.status],
    ['Priority', item.priority ?? 'None'],
    ['Assignee', item.assignee ?? 'Unassigned'],
    ['External project', item.project ?? 'None'],
    ['Updated', formatUpdatedAt(item.updatedAt)]
  ] as const;
  return (
    <dl className={cn('grid grid-cols-2 gap-x-4 gap-y-3', className)}>
      {fields.map(([label, value]) => (
        <div key={label} className="min-w-0">
          <dt className="text-xs text-muted-foreground">{label}</dt>
          <dd className="truncate text-sm font-medium">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function TrackerDetail({
  route,
  refreshGeneration,
  onAddToComposer
}: {
  route: Extract<TrackerRoute, { kind: 'item' }>;
  refreshGeneration: number;
  onAddToComposer?: (item: WorkItem) => void;
}) {
  const rpc = useRpc<TaskboardRpcContract>();
  const navigate = useBbNavigate();
  const [item, setItem] = useState<WorkItemDetail | null | undefined>();
  const [error, setError] = useState<string | null>(null);
  const requestRevisionRef = useRef(0);

  const load = useCallback(async () => {
    const requestRevision = ++requestRevisionRef.current;
    setError(null);
    try {
      const result = await rpc.call('getItem', {
        projectId: route.projectId,
        source: route.source,
        locator: route.locator
      });
      if (requestRevision !== requestRevisionRef.current) return;
      setItem(result.item);
    } catch (nextError) {
      if (requestRevision !== requestRevisionRef.current) return;
      setItem(null);
      setError(describeError(nextError));
    }
  }, [rpc, route.projectId, route.source, route.locator]);

  useEffect(() => {
    setItem(undefined);
    void load();
    return () => {
      requestRevisionRef.current += 1;
    };
  }, [load, refreshGeneration]);
  useRealtime('taskboard:changed', payload => {
    const changedProject = changedProjectId(payload);
    if (changedProject === null || changedProject === route.projectId) {
      void load();
    }
  });
  useRefreshOnReconnect(() => void load());

  const moveItemStatus = useCallback(
    async (_selectedItem: WorkItem, option: WorkStatusOption) => {
      if (!item) throw new Error('The work item is not loaded.');
      const previous = item;
      setItem({
        ...item,
        status: option.name,
        stateCategory: option.stateCategory
      });
      try {
        const result = await rpc.call('updateItemStatus', {
          projectId: route.projectId,
          source: route.source,
          locator: route.locator,
          statusId: option.id
        });
        setItem(current =>
          current
            ? { ...current, ...result.item, comments: current.comments }
            : current
        );
      } catch (nextError) {
        setItem(previous);
        throw nextError;
      }
    },
    [item, route.locator, route.projectId, route.source, rpc]
  );

  if (item === undefined) {
    return (
      <div className="space-y-4 p-4 md:p-5">
        <Skeleton className="h-8 w-2/3" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-52 w-full" />
      </div>
    );
  }

  if (item === null) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
        <Icon name="AlertCircle" className="size-6 text-destructive" />
        <p className="text-sm font-medium">Could not load this work item</p>
        <p role="alert" className="max-w-md text-sm text-muted-foreground">
          {error}
        </p>
        <Button
          variant="outline"
          onClick={() => {
            setItem(undefined);
            void load();
          }}
        >
          Try again
        </Button>
      </div>
    );
  }

  const prompt = formatWorkItemHandoffPrompt(item);

  return (
    <div className="@container flex min-h-full flex-col">
      <div className="tb-detail-frame flex flex-1 items-stretch">
        <article className="mx-auto w-full min-w-0 max-w-[52rem] flex-1 px-5 pb-16 pt-7 @3xl:px-10 @3xl:pt-10">
          <div className="mb-3 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
            <span className="font-medium tabular-nums">{item.key}</span>
            <WorkItemStatusMenu
              item={item}
              variant="detail"
              onMove={moveItemStatus}
            />
            <SourceMark source={item.source} />
          </div>
          <div className="flex flex-col gap-4 @lg:flex-row @lg:items-start">
            <h1 className="min-w-0 flex-1 text-2xl font-semibold leading-tight">
              {item.title}
            </h1>
            <div className="flex shrink-0 flex-wrap gap-2">
              <Button variant="outline" size="sm" asChild>
                <a href={item.url} target="_blank" rel="noreferrer">
                  <Icon name="ExternalLink" className="size-3.5" />
                  Open
                </a>
              </Button>
              {onAddToComposer ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => onAddToComposer(item)}
                >
                  <Icon name="MessageCirclePlus" className="size-3.5" />
                  Add to chat
                </Button>
              ) : null}
              <Button
                size="sm"
                onClick={() =>
                  navigate.toCompose({
                    initialPrompt: prompt,
                    focusPrompt: true
                  })
                }
              >
                <Icon name="AiContentGenerator01" className="size-3.5" />
                Send to agent
              </Button>
            </div>
          </div>

          <DetailMetadata
            item={item}
            className="tb-detail-meta mt-5 border-y py-4 @[45rem]:hidden"
          />

          {item.labels.length > 0 ? (
            <div className="mt-5 flex flex-wrap gap-1.5">
              {item.labels.map(label => (
                <Badge key={label} variant="secondary">
                  {label}
                </Badge>
              ))}
            </div>
          ) : null}

          <section className="mt-7">
            <h2 className="mb-3 text-sm font-semibold">Description</h2>
            {item.description.trim() ? (
              <Markdown content={item.description} />
            ) : (
              <p className="text-sm text-muted-foreground">
                No description provided.
              </p>
            )}
          </section>

          {item.comments.length > 0 ? (
            <section className="tb-comment-rail mt-8 border-t pt-5">
              <h2 className="mb-1 text-sm font-semibold">
                Comments <span className="text-muted-foreground">{item.comments.length}</span>
              </h2>
              <div className="ml-2">
                {item.comments.map((comment, index) => (
                  <article
                    key={`${comment.author}:${comment.createdAt}:${index}`}
                    className="tb-comment-entry relative py-4 pl-6"
                  >
                    <div className="mb-2 flex items-center justify-between gap-3 text-xs text-muted-foreground">
                      <span className="font-medium text-foreground">
                        {comment.author}
                      </span>
                      <time>{formatUpdatedAt(comment.createdAt)}</time>
                    </div>
                    <Markdown content={comment.body} />
                  </article>
                ))}
              </div>
            </section>
          ) : null}
        </article>

        <aside className="hidden w-56 shrink-0 border-l border-border-hairline py-10 pl-4 pr-6 @[45rem]:block">
          <DetailMetadata item={item} className="grid-cols-1" />
        </aside>
      </div>
    </div>
  );
}

function configFingerprint(config: ProjectConfigView): string {
  return JSON.stringify({
    source: config.source,
    linearTeamKey: config.linearTeamKey,
    jiraBaseUrl: config.jiraBaseUrl,
    jiraEmail: config.jiraEmail,
    jiraJql: config.jiraJql
  });
}

function secretMutation(value: string, remove: boolean): SecretMutation {
  if (value.trim()) return { operation: 'set', value: value.trim() };
  return remove ? { operation: 'clear' } : { operation: 'keep' };
}

function CredentialStatus({
  configured,
  hasDraft,
  remove
}: {
  configured: boolean;
  hasDraft: boolean;
  remove: boolean;
}) {
  const label = remove
    ? 'Removal queued'
    : hasDraft
      ? configured
        ? 'Replacement ready'
        : 'Credential ready'
      : configured
        ? 'Configured'
        : 'Not configured';
  return (
    <span
      className={cn(
        'tb-status-pill inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium',
        configured && !remove
          ? 'border-success/30 bg-success/10 text-success'
          : 'text-muted-foreground'
      )}
    >
      <span
        aria-hidden
        className={cn(
          'size-1.5 rounded-full',
          configured && !remove ? 'bg-success' : 'bg-muted-foreground/60'
        )}
      />
      {label}
    </span>
  );
}

function ProjectConfigForm({
  initialConfig,
  onSave,
  onSavingChange
}: {
  initialConfig: ProjectConfigView;
  onSave: (mutation: ProjectConfigMutation) => Promise<ProjectConfigView>;
  onSavingChange: (saving: boolean) => void;
}) {
  const [baseline, setBaseline] = useState(initialConfig);
  const [config, setConfig] = useState(initialConfig);
  const [linearDraft, setLinearDraft] = useState('');
  const [jiraDraft, setJiraDraft] = useState('');
  const [removeLinear, setRemoveLinear] = useState(false);
  const [removeJira, setRemoveJira] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setBaseline(initialConfig);
    setConfig(initialConfig);
    setLinearDraft('');
    setJiraDraft('');
    setRemoveLinear(false);
    setRemoveJira(false);
    setSaving(false);
    setSaved(false);
    setError(null);
  }, [initialConfig]);
  useEffect(
    () => () => {
      onSavingChange(false);
    },
    [onSavingChange]
  );

  const dirty =
    configFingerprint(config) !== configFingerprint(baseline) ||
    linearDraft.trim() !== '' ||
    jiraDraft.trim() !== '' ||
    removeLinear ||
    removeJira;
  const save = async () => {
    if (saving || !dirty) return;
    setSaved(false);
    setError(null);

    const linearCredential = secretMutation(linearDraft, removeLinear);
    const jiraCredential = secretMutation(jiraDraft, removeJira);
    const linearWillBeConfigured =
      linearCredential.operation === 'set' ||
      (baseline.linearCredentialConfigured &&
        linearCredential.operation === 'keep');
    const jiraWillBeConfigured =
      jiraCredential.operation === 'set' ||
      (baseline.jiraCredentialConfigured &&
        jiraCredential.operation === 'keep');

    if (config.source === 'linear') {
      if (!config.linearTeamKey.trim()) {
        setError('Add a Linear team key for this project.');
        return;
      }
      if (!linearWillBeConfigured && linearCredential.operation !== 'clear') {
        setError('Add a Linear API key for this project.');
        return;
      }
    }
    const parsedUrl = jiraBaseUrlSchema.safeParse(config.jiraBaseUrl.trim());
    if (!parsedUrl.success) {
      setError('Jira URL must be an HTTPS atlassian.net origin.');
      return;
    }
    const jiraBaseUrl = parsedUrl.data;
    const jiraIdentityChanged =
      jiraBaseUrl !== baseline.jiraBaseUrl ||
      config.jiraEmail.trim() !== baseline.jiraEmail;
    if (config.source === 'jira') {
      if (!config.jiraEmail.trim()) {
        setError('Add the Jira account email for this project.');
        return;
      }
      if (!config.jiraJql.trim()) {
        setError('Add a Jira JQL query for this project.');
        return;
      }
      if (!jiraWillBeConfigured && jiraCredential.operation !== 'clear') {
        setError('Add a Jira API token for this project.');
        return;
      }
    }
    if (
      jiraIdentityChanged &&
      baseline.jiraCredentialConfigured &&
      jiraCredential.operation === 'keep'
    ) {
      setError(
        'Changing the Jira site or email requires a replacement token or explicit credential removal.'
      );
      return;
    }

    setSaving(true);
    onSavingChange(true);
    try {
      const result = await onSave({
        projectId: config.projectId,
        source: config.source,
        linearTeamKey: config.linearTeamKey.trim(),
        jiraBaseUrl,
        jiraEmail: config.jiraEmail.trim(),
        jiraJql: config.jiraJql.trim(),
        linearCredential,
        jiraCredential
      });
      setBaseline(result);
      setConfig(result);
      setLinearDraft('');
      setJiraDraft('');
      setRemoveLinear(false);
      setRemoveJira(false);
      setSaved(true);
    } catch (nextError) {
      setError(describeError(nextError));
    } finally {
      setSaving(false);
      onSavingChange(false);
    }
  };

  const cardClass = 'tb-settings-card rounded-lg border p-4 @lg:p-5';
  return (
    <form
      className="space-y-3"
      onSubmit={event => {
        event.preventDefault();
        void save();
      }}
    >
      <fieldset disabled={saving} className="space-y-3">
        <legend className="text-sm font-semibold">External tracker</legend>
        <p className="text-xs leading-relaxed text-muted-foreground">
          Choose the one system this BB project uses for external work.
        </p>
        <div
          className="grid gap-2 @lg:grid-cols-3"
          role="radiogroup"
          aria-label="External tracker"
        >
          {TRACKER_OPTIONS.map(option => {
            const selected = config.source === option.source;
            return (
              <label
                key={option.source}
                data-selected={selected ? 'true' : 'false'}
                data-source={option.source}
                className="tb-source-option flex cursor-pointer items-center gap-3 rounded-lg border px-3 py-3"
              >
                <input
                  type="radio"
                  name="external-tracker"
                  value={option.source}
                  checked={selected}
                  className="sr-only"
                  onChange={() => {
                    setConfig(current => ({
                      ...current,
                      source: option.source
                    }));
                    setLinearDraft('');
                    setJiraDraft('');
                    setRemoveLinear(false);
                    setRemoveJira(false);
                    setSaved(false);
                    setError(null);
                  }}
                />
                <span className="tb-source-option-icon flex size-8 shrink-0 items-center justify-center rounded-md border">
                  <SourceGlyph source={option.source} />
                </span>
                <span className="min-w-0">
                  <span className="block text-sm font-medium">
                    {sourceName(option.source)}
                  </span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {option.description}
                  </span>
                </span>
                <span
                  aria-hidden
                  className="tb-source-option-dot ml-auto size-2 shrink-0 rounded-full"
                />
              </label>
            );
          })}
        </div>
      </fieldset>

      {config.source === 'github' ? (
        <section className={cardClass} aria-labelledby="github-connector-title">
          <div className="flex items-start justify-between gap-4">
            <div className="space-y-1">
              <div className="flex items-center gap-2">
                <span className="flex size-7 items-center justify-center rounded-md border border-border bg-secondary">
                  <SourceGlyph source="github" />
                </span>
                <h3
                  id="github-connector-title"
                  className="text-sm font-semibold"
                >
                  GitHub
                </h3>
              </div>
              <p className="max-w-xl text-xs leading-relaxed text-muted-foreground">
                Uses this BB project&apos;s repository mapping and the official
                GitHub connection. Taskboard never stores a GitHub token.
              </p>
              <p className="max-w-xl text-xs leading-relaxed text-muted-foreground">
                {config.githubRepos.length > 0
                  ? 'Mapped repositories for this BB project'
                  : 'No GitHub repositories are currently mapped to this BB project.'}
              </p>
              {config.githubRepos.length > 0 ? (
                <div className="flex flex-wrap gap-1.5 pt-1">
                  {config.githubRepos.map(repo => (
                    <span
                      key={repo}
                      data-source="github"
                      className="tb-repository-chip rounded-full px-2 py-0.5 font-mono text-xs"
                    >
                      {repo}
                    </span>
                  ))}
                </div>
              ) : null}
            </div>
          </div>
        </section>
      ) : null}

      {config.source === 'linear' ? (
        <section className={cardClass} aria-labelledby="linear-connector-title">
          <div className="flex items-start justify-between gap-4">
            <div className="space-y-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="flex size-7 items-center justify-center rounded-md border border-border bg-secondary">
                  <SourceGlyph source="linear" />
                </span>
                <h3
                  id="linear-connector-title"
                  className="text-sm font-semibold"
                >
                  Linear
                </h3>
                <CredentialStatus
                  configured={baseline.linearCredentialConfigured}
                  hasDraft={linearDraft.trim() !== ''}
                  remove={removeLinear}
                />
              </div>
              <p className="max-w-xl text-xs leading-relaxed text-muted-foreground">
                This API key belongs only to this BB project. A team key is
                required so the project cannot silently mix work from other
                teams.
              </p>
            </div>
          </div>
          <div className="mt-4 grid gap-3 @lg:grid-cols-2">
            <label className="space-y-1.5 text-xs font-medium">
              Linear API key{' '}
              <span className="font-normal text-muted-foreground">
                (write-only)
              </span>
              <Input
                type="password"
                autoComplete="new-password"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                aria-label="Linear API key"
                value={linearDraft}
                placeholder={
                  baseline.linearCredentialConfigured
                    ? 'Enter to replace current key'
                    : 'Enter project API key'
                }
                className="tb-field"
                disabled={saving || removeLinear}
                onChange={event => {
                  setLinearDraft(event.target.value);
                  setSaved(false);
                }}
              />
            </label>
            <label className="space-y-1.5 text-xs font-medium">
              Linear team key{' '}
              <span className="font-normal text-muted-foreground">
                (required)
              </span>
              <Input
                aria-label="Linear team key"
                value={config.linearTeamKey}
                placeholder="ENG"
                className="tb-field tb-field-mono"
                disabled={saving}
                onChange={event => {
                  setConfig({ ...config, linearTeamKey: event.target.value });
                  setSaved(false);
                }}
              />
            </label>
          </div>
          {baseline.linearCredentialConfigured ? (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="mt-3 text-destructive hover:text-destructive"
              disabled={saving}
              onClick={() => {
                const next = !removeLinear;
                setRemoveLinear(next);
                setLinearDraft('');
                setSaved(false);
              }}
            >
              <Icon
                name={removeLinear ? 'RotateCcw' : 'Trash2'}
                className="size-3.5"
              />
              {removeLinear
                ? 'Keep Linear credential'
                : 'Remove Linear credential'}
            </Button>
          ) : null}
        </section>
      ) : null}

      {config.source === 'jira' ? (
        <section className={cardClass} aria-labelledby="jira-connector-title">
          <div className="flex items-start justify-between gap-4">
            <div className="space-y-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="flex size-7 items-center justify-center rounded-md border border-border bg-secondary">
                  <SourceGlyph source="jira" />
                </span>
                <h3 id="jira-connector-title" className="text-sm font-semibold">
                  Jira
                </h3>
                <CredentialStatus
                  configured={baseline.jiraCredentialConfigured}
                  hasDraft={jiraDraft.trim() !== ''}
                  remove={removeJira}
                />
              </div>
              <p className="max-w-xl text-xs leading-relaxed text-muted-foreground">
                Jira accepts HTTPS atlassian.net sites only. Changing the site
                or account email requires replacing or removing the token.
              </p>
            </div>
          </div>
          <div className="mt-4 grid gap-3 @lg:grid-cols-2">
            <label className="space-y-1.5 text-xs font-medium">
              Jira site
              <Input
                aria-label="Jira site"
                value={config.jiraBaseUrl}
                placeholder="https://workspace.atlassian.net"
                className="tb-field tb-field-mono"
                disabled={saving}
                onChange={event => {
                  setConfig({ ...config, jiraBaseUrl: event.target.value });
                  setSaved(false);
                }}
              />
            </label>
            <label className="space-y-1.5 text-xs font-medium">
              Jira account email
              <Input
                type="email"
                aria-label="Jira account email"
                value={config.jiraEmail}
                placeholder="you@example.com"
                className="tb-field"
                disabled={saving}
                onChange={event => {
                  setConfig({ ...config, jiraEmail: event.target.value });
                  setSaved(false);
                }}
              />
            </label>
            <label className="space-y-1.5 text-xs font-medium @lg:col-span-2">
              Jira API token{' '}
              <span className="font-normal text-muted-foreground">
                (write-only)
              </span>
              <Input
                type="password"
                autoComplete="new-password"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                aria-label="Jira API token"
                value={jiraDraft}
                placeholder={
                  baseline.jiraCredentialConfigured
                    ? 'Enter to replace current token'
                    : 'Enter project API token'
                }
                className="tb-field"
                disabled={saving || removeJira}
                onChange={event => {
                  setJiraDraft(event.target.value);
                  setSaved(false);
                }}
              />
            </label>
            <label className="space-y-1.5 text-xs font-medium @lg:col-span-2">
              Jira JQL
              <Textarea
                aria-label="Jira JQL"
                value={config.jiraJql}
                placeholder='project = "BB" AND statusCategory != Done'
                className="tb-field min-h-24 font-mono text-xs"
                disabled={saving}
                onChange={event => {
                  setConfig({ ...config, jiraJql: event.target.value });
                  setSaved(false);
                }}
              />
            </label>
          </div>
          {baseline.jiraCredentialConfigured ? (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="mt-3 text-destructive hover:text-destructive"
              disabled={saving}
              onClick={() => {
                const next = !removeJira;
                setRemoveJira(next);
                setJiraDraft('');
                setSaved(false);
              }}
            >
              <Icon
                name={removeJira ? 'RotateCcw' : 'Trash2'}
                className="size-3.5"
              />
              {removeJira ? 'Keep Jira credential' : 'Remove Jira credential'}
            </Button>
          ) : null}
        </section>
      ) : null}

      <div className="tb-save-bar sticky bottom-0 flex flex-wrap items-center justify-end gap-3 rounded-lg border px-4 py-3 backdrop-blur-sm">
        {error ? (
          <p role="alert" className="mr-auto max-w-xl text-sm text-destructive">
            {error}
          </p>
        ) : saved ? (
          <span role="status" className="mr-auto text-sm text-success">
            Project connection saved
          </span>
        ) : dirty ? (
          <span className="mr-auto text-xs text-muted-foreground">
            Unsaved project changes
          </span>
        ) : null}
        {error ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={saving}
            onClick={() => void save()}
          >
            Retry save
          </Button>
        ) : null}
        <Button type="submit" size="sm" disabled={saving || !dirty}>
          {saving ? 'Saving…' : 'Save project connection'}
        </Button>
      </div>
    </form>
  );
}

function boardSettingsFingerprint(settings: ProjectBoardSettings): string {
  return JSON.stringify({
    defaultView: settings.defaultView,
    enabledFilters: settings.enabledFilters,
    statusOrder: settings.statusOrder
  });
}

function ProjectBoardSettingsForm({
  initialSettings,
  onSave,
  onSavingChange
}: {
  initialSettings: ProjectBoardSettings;
  onSave: (settings: ProjectBoardSettings) => Promise<ProjectBoardSettings>;
  onSavingChange: (saving: boolean) => void;
}) {
  const [baseline, setBaseline] = useState(initialSettings);
  const [settings, setSettings] = useState(initialSettings);
  const [statusOrderText, setStatusOrderText] = useState(
    initialSettings.statusOrder.join('\n')
  );
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setBaseline(initialSettings);
    setSettings(initialSettings);
    setStatusOrderText(initialSettings.statusOrder.join('\n'));
    setSaving(false);
    setSaved(false);
    setError(null);
  }, [initialSettings]);
  useEffect(
    () => () => {
      onSavingChange(false);
    },
    [onSavingChange]
  );

  const statusOrder = statusOrderText
    .split('\n')
    .map(status => status.trim())
    .filter(Boolean);
  const candidate = { ...settings, statusOrder };
  const dirty =
    boardSettingsFingerprint(candidate) !== boardSettingsFingerprint(baseline);

  const save = async () => {
    if (saving || !dirty) return;
    setSaved(false);
    setError(null);
    const parsed = projectBoardSettingsSchema.safeParse(candidate);
    if (!parsed.success) {
      setError(
        parsed.error.issues[0]?.message ?? 'Check the board settings and retry.'
      );
      return;
    }

    setSaving(true);
    onSavingChange(true);
    try {
      const result = await onSave(parsed.data);
      setBaseline(result);
      setSettings(result);
      setStatusOrderText(result.statusOrder.join('\n'));
      setSaved(true);
    } catch (nextError) {
      setError(describeError(nextError));
    } finally {
      setSaving(false);
      onSavingChange(false);
    }
  };

  return (
    <form
      className="tb-settings-card space-y-5 rounded-lg border p-4 @lg:p-5"
      onSubmit={event => {
        event.preventDefault();
        void save();
      }}
    >
      <div className="space-y-1">
        <h3 className="text-sm font-semibold">Board preferences</h3>
        <p className="max-w-2xl text-xs leading-relaxed text-muted-foreground">
          Choose the filters shown for this project, its default layout, and
          the workflow order shared by List and Kanban.
        </p>
      </div>

      <fieldset disabled={saving} className="space-y-2">
        <legend className="text-xs font-medium">Default layout</legend>
        <div className="grid gap-2 @sm:grid-cols-2">
          {(['list', 'kanban'] as const).map(view => (
            <label
              key={view}
              data-selected={settings.defaultView === view ? 'true' : 'false'}
              className="tb-source-option flex cursor-pointer items-center gap-3 rounded-lg border px-3 py-3"
            >
              <input
                type="radio"
                name="default-board-layout"
                value={view}
                checked={settings.defaultView === view}
                className="sr-only"
                onChange={() => {
                  setSettings(current => ({ ...current, defaultView: view }));
                  setSaved(false);
                }}
              />
              <Icon
                name={view === 'list' ? 'ListView' : 'Columns2'}
                className="size-4 text-muted-foreground"
              />
              <span className="text-sm font-medium">
                {view === 'list' ? 'List' : 'Kanban'}
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      <fieldset disabled={saving} className="space-y-2">
        <legend className="text-xs font-medium">Visible filters</legend>
        <div className="grid gap-2 @lg:grid-cols-2">
          {BOARD_FILTER_OPTIONS.map(option => (
            <label
              key={option.field}
              className="flex cursor-pointer items-start gap-3 rounded-lg border border-border px-3 py-3"
            >
              <input
                type="checkbox"
                checked={settings.enabledFilters.includes(option.field)}
                className="mt-0.5 size-4 accent-primary"
                onChange={event => {
                  setSettings(current => ({
                    ...current,
                    enabledFilters: toggled(
                      current.enabledFilters,
                      option.field,
                      event.target.checked
                    )
                  }));
                  setSaved(false);
                }}
              />
              <span className="min-w-0">
                <span className="flex items-center gap-1.5 text-sm font-medium">
                  <Icon
                    name={option.icon}
                    className="size-3.5 shrink-0 text-muted-foreground"
                    aria-hidden="true"
                  />
                  <span>{option.label}</span>
                </span>
                <span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">
                  {option.description}
                </span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      <label className="block space-y-1.5 text-xs font-medium">
        Workflow status order
        <Textarea
          aria-label="Workflow status order"
          value={statusOrderText}
          disabled={saving}
          className="tb-field min-h-40 font-mono text-xs"
          onChange={event => {
            setStatusOrderText(event.target.value);
            setSaved(false);
          }}
        />
        <span className="block font-normal leading-relaxed text-muted-foreground">
          Enter one exact status name per line. Provider-specific statuses not
          listed here stay near their broad workflow group.
        </span>
      </label>

      <div className="flex flex-wrap items-center justify-end gap-3 border-t border-border pt-4">
        {error ? (
          <p role="alert" className="mr-auto max-w-xl text-sm text-destructive">
            {error}
          </p>
        ) : saved ? (
          <span role="status" className="mr-auto text-sm text-success">
            Board preferences saved
          </span>
        ) : dirty ? (
          <span className="mr-auto text-xs text-muted-foreground">
            Unsaved board changes
          </span>
        ) : null}
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={saving}
          onClick={() => {
            const defaults = defaultProjectBoardSettings(settings.projectId);
            setSettings(defaults);
            setStatusOrderText(defaults.statusOrder.join('\n'));
            setSaved(false);
            setError(null);
          }}
        >
          Reset defaults
        </Button>
        <Button type="submit" size="sm" disabled={saving || !dirty}>
          {saving ? 'Saving…' : 'Save board preferences'}
        </Button>
      </div>
    </form>
  );
}

function FilterPresetsForm({ projectId }: { projectId: string }) {
  const rpc = useRpc<TaskboardRpcContract>();
  const presetState = useProjectFilterPresets(projectId);
  const [nameDrafts, setNameDrafts] = useState<Record<string, string>>({});
  const [mutating, setMutating] = useState(false);
  const [mutationFeedback, setMutationFeedback] = useState<{
    kind: 'error' | 'status';
    message: string;
    presetId?: string;
  } | null>(null);
  const mutationInFlightRef = useRef(false);
  const authoritativeNamesRef = useRef(new Map<string, string>());
  const presetNameInputRefs = useRef(new Map<string, HTMLInputElement>());
  const presetActionButtonRefs = useRef(new Map<string, HTMLButtonElement>());
  const headingRef = useRef<HTMLHeadingElement>(null);
  const mutationFeedbackId = useId();

  const restorePresetFocus = (
    presetId: string,
    action?: 'move-up' | 'move-down' | 'delete'
  ) => {
    window.requestAnimationFrame(() => {
      const actionButton = action
        ? presetActionButtonRefs.current.get(`${presetId}:${action}`)
        : undefined;
      if (actionButton && !actionButton.disabled) {
        actionButton.focus();
        return;
      }
      presetNameInputRefs.current.get(presetId)?.focus();
    });
  };

  useEffect(() => {
    const previousNames = authoritativeNamesRef.current;
    const nextNames = new Map(
      presetState.presets.map(preset => [preset.id, preset.name])
    );
    setNameDrafts(current =>
      Object.fromEntries(
        presetState.presets.map(preset => {
          const previousName = previousNames.get(preset.id);
          const currentDraft = current[preset.id];
          const dirty =
            previousName !== undefined &&
            currentDraft !== undefined &&
            currentDraft !== previousName;
          return [preset.id, dirty ? currentDraft : preset.name];
        })
      )
    );
    authoritativeNamesRef.current = nextNames;
  }, [presetState.presets]);

  const beginMutation = () => {
    if (mutationInFlightRef.current) return false;
    mutationInFlightRef.current = true;
    setMutating(true);
    setMutationFeedback(null);
    return true;
  };
  const finishMutation = () => {
    mutationInFlightRef.current = false;
    setMutating(false);
  };
  const reportMutationError = (
    nextError: unknown,
    options: { presetId?: string; action: string }
  ) => {
    const message = describeError(nextError);
    setMutationFeedback({
      kind: 'error',
      message: `${options.action}: ${message}`,
      ...(options.presetId ? { presetId: options.presetId } : {})
    });
    toast.error(message);
  };

  const renamePreset = async (preset: FilterPreset) => {
    const name = (nameDrafts[preset.id] ?? preset.name).trim();
    if (name === preset.name) {
      setNameDrafts(current => ({ ...current, [preset.id]: preset.name }));
      return;
    }
    if (!name) {
      setMutationFeedback({
        kind: 'error',
        presetId: preset.id,
        message: `Rename "${preset.name}": preset names cannot be empty.`
      });
      return;
    }
    if (!beginMutation()) return;
    try {
      const result = await rpc.call('saveFilterPreset', {
        projectId,
        id: preset.id,
        name,
        state: preset.state
      });
      presetState.setAuthoritative(result.presets);
      setMutationFeedback({
        kind: 'status',
        message: `Renamed preset to "${result.preset.name}".`
      });
      restorePresetFocus(preset.id);
    } catch (nextError) {
      reportMutationError(nextError, {
        presetId: preset.id,
        action: `Could not rename "${preset.name}"`
      });
      restorePresetFocus(preset.id);
    } finally {
      finishMutation();
    }
  };

  const removePreset = async (preset: FilterPreset) => {
    if (mutationInFlightRef.current) return;
    if (!window.confirm(`Delete the preset "${preset.name}"?`)) return;
    if (!beginMutation()) return;
    const deletedIndex = presetState.presets.findIndex(
      candidate => candidate.id === preset.id
    );
    try {
      const result = await rpc.call('deleteFilterPreset', {
        projectId,
        id: preset.id
      });
      presetState.setAuthoritative(result.presets);
      setMutationFeedback({
        kind: 'status',
        message: `Deleted preset "${preset.name}".`
      });
      const focusTarget =
        result.presets[
          Math.min(Math.max(deletedIndex, 0), result.presets.length - 1)
        ];
      window.requestAnimationFrame(() => {
        const input = focusTarget
          ? presetNameInputRefs.current.get(focusTarget.id)
          : undefined;
        (input ?? headingRef.current)?.focus();
      });
    } catch (nextError) {
      reportMutationError(nextError, {
        action: `Could not delete "${preset.name}"`
      });
      restorePresetFocus(preset.id, 'delete');
    } finally {
      finishMutation();
    }
  };

  const movePreset = async (preset: FilterPreset, delta: number) => {
    if (mutationInFlightRef.current) return;
    const ids = presetState.presets.map(candidate => candidate.id);
    const from = ids.indexOf(preset.id);
    const to = from + delta;
    if (from < 0 || to < 0 || to >= ids.length || !beginMutation()) return;
    const reordered = [...ids];
    const [moved] = reordered.splice(from, 1);
    if (!moved) {
      finishMutation();
      return;
    }
    reordered.splice(to, 0, moved);
    try {
      const result = await rpc.call('reorderFilterPresets', {
        projectId,
        ids: reordered
      });
      presetState.setAuthoritative(result.presets);
      setMutationFeedback({
        kind: 'status',
        message: `Moved preset "${preset.name}" ${delta < 0 ? 'up' : 'down'}.`
      });
      restorePresetFocus(preset.id, delta < 0 ? 'move-up' : 'move-down');
    } catch (nextError) {
      reportMutationError(nextError, {
        action: `Could not move "${preset.name}"`
      });
      restorePresetFocus(preset.id, delta < 0 ? 'move-up' : 'move-down');
    } finally {
      finishMutation();
    }
  };

  return (
    <div className="tb-settings-card space-y-3 rounded-lg border p-4 @lg:p-5">
      <div className="space-y-1">
        <h3 ref={headingRef} tabIndex={-1} className="text-sm font-semibold">
          Filter presets
        </h3>
        <p className="max-w-2xl text-xs leading-relaxed text-muted-foreground">
          Rename, reorder, or delete this project&apos;s saved views.
        </p>
      </div>
      {presetState.loading ? (
        <div
          role="status"
          aria-live="polite"
          aria-busy="true"
          className="space-y-2"
        >
          <span className="sr-only">Loading filter presets</span>
          <Skeleton className="h-7 w-full" />
          <Skeleton className="h-7 w-4/5" />
        </div>
      ) : presetState.error ? (
        <div className="rounded-md border border-destructive/30 p-3">
          <p role="alert" className="text-xs text-destructive">
            Could not load presets: {presetState.error}
          </p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="mt-2"
            onClick={() => void presetState.reload()}
          >
            Try again
          </Button>
        </div>
      ) : presetState.presets.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          Save a preset from the Presets menu on this project&apos;s board.
        </p>
      ) : (
        <ul className="flex min-w-0 flex-col gap-2">
          {presetState.presets.map((preset, index) => (
            <li
              key={preset.id}
              className="flex min-w-0 flex-col gap-1.5 @sm:flex-row @sm:items-center @sm:gap-2"
            >
              <Input
                ref={element => {
                  if (element) {
                    presetNameInputRefs.current.set(preset.id, element);
                  } else {
                    presetNameInputRefs.current.delete(preset.id);
                  }
                }}
                value={nameDrafts[preset.id] ?? preset.name}
                maxLength={FILTER_PRESET_NAME_MAX_LENGTH}
                disabled={mutating}
                aria-label={`Preset name for ${preset.name}`}
                aria-invalid={
                  mutationFeedback?.kind === 'error' &&
                  mutationFeedback.presetId === preset.id
                }
                aria-describedby={
                  mutationFeedback?.kind === 'error' &&
                  mutationFeedback.presetId === preset.id
                    ? mutationFeedbackId
                    : undefined
                }
                className="h-8 min-w-0 w-full text-xs max-md:pointer-coarse:h-10 @sm:flex-1"
                onChange={event => {
                  const name = event.target.value;
                  setNameDrafts(current => ({
                    ...current,
                    [preset.id]: name
                  }));
                  if (
                    mutationFeedback?.kind === 'error' &&
                    mutationFeedback.presetId === preset.id
                  ) {
                    setMutationFeedback(null);
                  }
                }}
                onKeyDown={event => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    void renamePreset(preset);
                  } else if (event.key === 'Escape') {
                    event.preventDefault();
                    setNameDrafts(current => ({
                      ...current,
                      [preset.id]: preset.name
                    }));
                    if (mutationFeedback?.presetId === preset.id) {
                      setMutationFeedback(null);
                    }
                  }
                }}
              />
              <div className="flex w-full min-w-0 flex-wrap items-center justify-end gap-1 @sm:w-auto @sm:shrink-0">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-8 w-8 p-0 max-md:pointer-coarse:h-10 max-md:pointer-coarse:w-10"
                  disabled={
                    mutating ||
                    (nameDrafts[preset.id] ?? preset.name) === preset.name
                  }
                  aria-label={`Save name for ${preset.name}`}
                  onClick={() => void renamePreset(preset)}
                >
                  <Icon name="Check" className="size-3" />
                </Button>
                <Button
                  ref={element => {
                    const key = `${preset.id}:move-up`;
                    if (element) {
                      presetActionButtonRefs.current.set(key, element);
                    } else {
                      presetActionButtonRefs.current.delete(key);
                    }
                  }}
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-8 w-8 p-0 max-md:pointer-coarse:h-10 max-md:pointer-coarse:w-10"
                  disabled={mutating || index === 0}
                  aria-label={`Move ${preset.name} up`}
                  onClick={() => void movePreset(preset, -1)}
                >
                  <Icon name="ChevronUp" className="size-3" />
                </Button>
                <Button
                  ref={element => {
                    const key = `${preset.id}:move-down`;
                    if (element) {
                      presetActionButtonRefs.current.set(key, element);
                    } else {
                      presetActionButtonRefs.current.delete(key);
                    }
                  }}
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-8 w-8 p-0 max-md:pointer-coarse:h-10 max-md:pointer-coarse:w-10"
                  disabled={
                    mutating || index === presetState.presets.length - 1
                  }
                  aria-label={`Move ${preset.name} down`}
                  onClick={() => void movePreset(preset, 1)}
                >
                  <Icon name="ChevronDown" className="size-3" />
                </Button>
                <Button
                  ref={element => {
                    const key = `${preset.id}:delete`;
                    if (element) {
                      presetActionButtonRefs.current.set(key, element);
                    } else {
                      presetActionButtonRefs.current.delete(key);
                    }
                  }}
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-8 w-8 p-0 max-md:pointer-coarse:h-10 max-md:pointer-coarse:w-10"
                  disabled={mutating}
                  aria-label={`Delete ${preset.name}`}
                  onClick={() => void removePreset(preset)}
                >
                  <Icon name="Trash2" className="size-3" />
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {presetState.refreshError && !presetState.error ? (
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-border px-3 py-2">
          <p role="alert" className="min-w-0 flex-1 text-xs text-muted-foreground">
            Could not refresh presets. Keeping your loaded presets and edits.
          </p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="max-md:pointer-coarse:h-10"
            onClick={() => void presetState.reload({ background: true })}
          >
            Try again
          </Button>
        </div>
      ) : null}
      {mutationFeedback?.kind === 'error' ? (
        <p
          id={mutationFeedbackId}
          role="alert"
          className="text-xs text-destructive"
        >
          {mutationFeedback.message}
        </p>
      ) : mutating ? (
        <p role="status" className="text-xs text-muted-foreground">
          Updating presets…
        </p>
      ) : mutationFeedback?.kind === 'status' ? (
        <p role="status" className="text-xs text-muted-foreground">
          {mutationFeedback.message}
        </p>
      ) : null}
    </div>
  );
}

function ManageView({
  projectId,
  projects,
  isLoadingProjects,
  onProjectChange
}: {
  projectId: string | null;
  projects: readonly TrackerProject[] | undefined;
  isLoadingProjects: boolean;
  onProjectChange: (projectId: string) => void;
}) {
  const rpc = useRpc<TaskboardRpcContract>();
  const [config, setConfig] = useState<ProjectConfigView | null>(null);
  const [boardSettings, setBoardSettings] =
    useState<ProjectBoardSettings | null>(null);
  const [loadingConfig, setLoadingConfig] = useState(false);
  const [savingConfig, setSavingConfig] = useState(false);
  const [savingBoardSettings, setSavingBoardSettings] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadRevision, setLoadRevision] = useState(0);

  useEffect(() => {
    setConfig(null);
    setBoardSettings(null);
    setError(null);
    if (!projectId) return;
    let cancelled = false;
    setLoadingConfig(true);
    void Promise.all([
      rpc.call('getProjectConfig', { projectId }),
      rpc.call('getProjectBoardSettings', { projectId })
    ])
      .then(([configResult, settingsResult]) => {
        if (cancelled) return;
        setConfig(configResult.config);
        setBoardSettings(settingsResult.settings);
      })
      .catch((nextError: unknown) => {
        if (!cancelled) setError(describeError(nextError));
      })
      .finally(() => {
        if (!cancelled) setLoadingConfig(false);
      });
    return () => {
      cancelled = true;
    };
  }, [loadRevision, projectId, rpc]);

  return (
    <div className="h-full overflow-y-auto p-3 @container">
      <div className="mx-auto w-full max-w-4xl space-y-4 pb-8">
        <header className="tb-manage-hero flex flex-col gap-3 rounded-lg border px-4 py-4 @lg:flex-row @lg:items-end @lg:justify-between @lg:px-5">
          <div className="space-y-1">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Project settings
            </p>
            <h2 className="text-lg font-semibold">Project setup</h2>
            <p className="max-w-2xl text-sm text-muted-foreground">
              Configure this project&apos;s external tracker, visible filters,
              default layout, and workflow order. Secret values are write-only
              and never loaded back here.
            </p>
          </div>
          {projects && projects.length > 0 ? (
            <Select
              value={projectId ?? undefined}
              disabled={savingConfig || savingBoardSettings}
              onValueChange={onProjectChange}
            >
              <SelectTrigger
                aria-label="BB project"
                className="tb-field h-9 w-64 max-w-full"
              >
                <SelectValue placeholder="Choose a BB project" />
              </SelectTrigger>
              <SelectContent>
                {projects.map(project => (
                  <SelectItem key={project.id} value={project.id}>
                    {project.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : null}
        </header>

        {isLoadingProjects || projects === undefined ? (
          <div className="space-y-3">
            <Skeleton className="h-40 w-full rounded-xl" />
            <Skeleton className="h-64 w-full rounded-xl" />
          </div>
        ) : projects.length === 0 || projectId === null ? (
          <div className="flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border bg-card p-10 text-center">
            <Icon name="Folder" className="size-5 text-muted-foreground" />
            <p className="text-sm font-medium">No BB projects found</p>
            <p className="text-sm text-muted-foreground">
              Create a BB project before configuring its external tracker.
            </p>
          </div>
        ) : loadingConfig ||
          (config !== null && config.projectId !== projectId) ||
          (boardSettings !== null && boardSettings.projectId !== projectId) ? (
          <div className="space-y-3">
            <Skeleton className="h-32 w-full rounded-xl" />
            <Skeleton className="h-64 w-full rounded-xl" />
          </div>
        ) : config && boardSettings ? (
          <>
            <ProjectConfigForm
              key={`connection:${config.projectId}`}
              initialConfig={config}
              onSavingChange={setSavingConfig}
              onSave={async mutation => {
                const result = await rpc.call('saveProjectConfig', mutation);
                return result.config;
              }}
            />
            <ProjectBoardSettingsForm
              key={`board:${boardSettings.projectId}`}
              initialSettings={boardSettings}
              onSavingChange={setSavingBoardSettings}
              onSave={async settings => {
                const result = await rpc.call(
                  'saveProjectBoardSettings',
                  settings
                );
                setBoardSettings(result.settings);
                return result.settings;
              }}
            />
            <FilterPresetsForm
              key={`presets:${boardSettings.projectId}`}
              projectId={boardSettings.projectId}
            />
          </>
        ) : (
          <div className="rounded-xl border border-destructive/30 bg-card p-5">
            <p role="alert" className="text-sm text-destructive">
              {error ?? 'Could not load this project connection.'}
            </p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="mt-3"
              onClick={() => setLoadRevision(revision => revision + 1)}
            >
              Try again
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

function TaskboardPanel({ subPath }: PluginNavPanelProps) {
  const route = parseTrackerRoute(subPath);
  const rpc = useRpc<TaskboardRpcContract>();
  const navigate = useBbNavigate();
  const {
    projectId: contextProjectId,
    threadId: contextThreadId
  } = useBbContext();
  const [sourceProjectContext] = useState(loadSourceProjectContext);
  const selectionContextProjectId = contextThreadId
    ? contextProjectId
    : (sourceProjectContext?.projectId ?? contextProjectId);
  const selectionContextThreadId =
    contextThreadId ?? sourceProjectContext?.threadId ?? null;
  const rootRef = useRef<HTMLDivElement>(null);
  const [projects, setProjects] = useState<TrackerProject[] | undefined>();
  const [projectsError, setProjectsError] = useState<string | null>(null);
  const [sidebarCollapsed, setSidebarCollapsed] =
    useState(loadSidebarCollapsed);
  const [narrow, setNarrow] = useState(false);
  const [narrowOverride, setNarrowOverride] = useState<boolean | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [refreshGeneration, setRefreshGeneration] = useState(0);
  const projectsRequestRevisionRef = useRef(0);
  const handledContextSelectionRef = useRef<string | null>(null);
  const lastBrowseRouteRef = useRef<Extract<
    TrackerRoute,
    { kind: 'all' | 'project' }
  > | null>(null);
  const contextTargetProjectId = useMemo(
    () => availableContextProjectId(projects, selectionContextProjectId),
    [projects, selectionContextProjectId]
  );
  const preferredProjectId = useMemo(() => {
    if (!projects || projects.length === 0) return null;
    if (contextTargetProjectId) return contextTargetProjectId;
    const lastProjectId = loadLastProjectId();
    if (
      lastProjectId &&
      projects.some(project => project.id === lastProjectId)
    ) {
      return lastProjectId;
    }
    return projects[0]?.id ?? null;
  }, [contextTargetProjectId, projects]);

  const loadProjects = useCallback(async () => {
    const requestRevision = ++projectsRequestRevisionRef.current;
    setProjectsError(null);
    try {
      const result = await rpc.call('listProjects', null);
      if (requestRevision !== projectsRequestRevisionRef.current) return null;
      setProjects(result.projects);
      return result.projects;
    } catch (nextError) {
      if (requestRevision !== projectsRequestRevisionRef.current) return null;
      setProjects([]);
      setProjectsError(describeError(nextError));
      return null;
    }
  }, [rpc]);
  useEffect(() => {
    void loadProjects();
    return () => {
      projectsRequestRevisionRef.current += 1;
    };
  }, [loadProjects]);
  useRefreshOnReconnect(() => void loadProjects());

  useEffect(() => {
    const root = rootRef.current;
    if (!root || typeof ResizeObserver === 'undefined') return;
    const update = () => {
      const width = root.clientWidth;
      setNarrow(width > 0 && width < SIDEBAR_AUTO_COLLAPSE_WIDTH);
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(root);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    setNarrowOverride(null);
  }, [narrow]);
  useEffect(() => {
    if (route.kind === 'all' || route.kind === 'project') {
      lastBrowseRouteRef.current = route;
      if (route.kind === 'project') storeLastProjectId(route.projectId);
    }
  }, [subPath]);
  useEffect(() => {
    if (projects === undefined || !shouldApplyContextProject(route)) return;
    const token = contextSelectionToken(
      selectionContextThreadId,
      selectionContextProjectId,
      contextTargetProjectId
    );
    if (handledContextSelectionRef.current === token) return;
    handledContextSelectionRef.current = token;
    if (contextTargetProjectId === null) return;

    storeLastProjectId(contextTargetProjectId);

    const nextRoute: TrackerRoute =
      route.kind === 'manage'
        ? { kind: 'manage', projectId: contextTargetProjectId }
        : { kind: 'project', projectId: contextTargetProjectId };
    navigate.toPluginPanel(PANEL_PATH, {
      subPath: routeToSubPath(nextRoute),
      replace: true
    });
  }, [
    contextTargetProjectId,
    navigate,
    projects,
    selectionContextProjectId,
    selectionContextThreadId,
    subPath
  ]);
  useEffect(() => {
    if (
      route.kind !== 'root' ||
      contextTargetProjectId !== null ||
      preferredProjectId === null
    ) {
      return;
    }
    storeLastProjectId(preferredProjectId);
    navigate.toPluginPanel(PANEL_PATH, {
      subPath: routeToSubPath({
        kind: 'project',
        projectId: preferredProjectId
      }),
      replace: true
    });
  }, [
    contextTargetProjectId,
    navigate,
    preferredProjectId,
    route.kind
  ]);
  useEffect(() => {
    if (
      route.kind !== 'manage' ||
      route.projectId !== null ||
      contextTargetProjectId !== null ||
      preferredProjectId === null
    ) {
      return;
    }
    navigate.toPluginPanel(PANEL_PATH, {
      subPath: routeToSubPath({
        kind: 'manage',
        projectId: preferredProjectId
      }),
      replace: true
    });
  }, [
    contextTargetProjectId,
    navigate,
    preferredProjectId,
    route.kind,
    subPath
  ]);

  const effectiveSidebarCollapsed = narrow
    ? (narrowOverride ?? true)
    : sidebarCollapsed;
  const sidebarOverlay = narrow && !effectiveSidebarCollapsed;

  const toggleSidebar = () => {
    const next = !effectiveSidebarCollapsed;
    if (narrow) setNarrowOverride(next);
    setSidebarCollapsed(next);
    storeSidebarCollapsed(next);
  };
  const go = (nextRoute: TrackerRoute) => {
    if (sidebarOverlay) setNarrowOverride(null);
    navigate.toPluginPanel(PANEL_PATH, { subPath: routeToSubPath(nextRoute) });
  };
  const backFromItem = () => {
    if (route.kind !== 'item') return;
    go(
      lastBrowseRouteRef.current ?? {
        kind: 'project',
        projectId: route.projectId
      }
    );
  };
  const refresh = async () => {
    if (refreshing) return;
    setRefreshing(true);
    setRefreshError(null);
    try {
      const latestProjects = await loadProjects();
      const projectIds =
        route.kind === 'project' || route.kind === 'item'
          ? [route.projectId]
          : route.kind === 'root' && preferredProjectId
            ? [preferredProjectId]
            : (latestProjects ?? projects ?? []).map(project => project.id);
      await Promise.all(
        projectIds.map(projectId => rpc.call('refresh', { projectId }))
      );
      setRefreshGeneration(generation => generation + 1);
    } catch (nextError) {
      setRefreshError(describeError(nextError));
    } finally {
      setRefreshing(false);
    }
  };

  const sidebar = (
    <TrackerSidebar
      route={route}
      projects={projects}
      isLoading={projects === undefined}
      preferredProjectId={preferredProjectId}
      overlay={sidebarOverlay}
      onNavigate={go}
    />
  );

  let outlet: ReactNode;
  if (route.kind === 'root' && preferredProjectId === null) {
    outlet =
      projects === undefined ? (
        <div className="h-full bg-surface-recessed-solid p-3">
          <div className="mx-auto h-full max-w-[100rem] rounded-xl border border-border bg-card p-4">
            <LoadingRows />
          </div>
        </div>
      ) : (
        <EmptyState filtered={false} onClear={() => undefined} />
      );
  } else if (route.kind === 'manage') {
    outlet = (
      <ManageView
        projectId={route.projectId ?? preferredProjectId}
        projects={projects}
        isLoadingProjects={projects === undefined}
        onProjectChange={projectId => go({ kind: 'manage', projectId })}
      />
    );
  } else if (route.kind === 'item') {
    outlet = (
      <TrackerDetail route={route} refreshGeneration={refreshGeneration} />
    );
  } else {
    const projectId =
      route.kind === 'project'
        ? route.projectId
        : route.kind === 'root'
          ? preferredProjectId
          : null;
    outlet = (
      <TrackerList
        key={projectId ?? 'all'}
        projectId={projectId}
        projects={projects}
        refreshGeneration={refreshGeneration}
        surfaceMode={narrow ? 'constrained' : 'full'}
        onOpen={item =>
          go({
            kind: 'item',
            projectId: item.bbProjectId,
            source: item.source,
            locator: item.locator
          })
        }
      />
    );
  }

  return (
    <div
      ref={rootRef}
      className="tb-linear relative flex h-full min-h-0 flex-row-reverse text-foreground"
    >
      {!effectiveSidebarCollapsed ? (
        sidebarOverlay ? (
          <SidebarDrawer onClose={toggleSidebar}>{sidebar}</SidebarDrawer>
        ) : (
          sidebar
        )
      ) : null}
      <main className="@container flex min-w-0 flex-1 flex-col">
        <TrackerTopbar
          route={route}
          projects={projects}
          sidebarCollapsed={effectiveSidebarCollapsed}
          refreshing={refreshing}
          refreshDisabled={
            route.kind === 'manage' ||
            (route.kind === 'all' && projects === undefined)
          }
          onNavigate={go}
          onBack={backFromItem}
          onRefresh={() => void refresh()}
          onToggleSidebar={toggleSidebar}
        />
        {projectsError ? (
          <p
            role="alert"
            className="shrink-0 border-b border-border-hairline px-3.5 py-1.5 text-xs text-destructive"
          >
            {projectsError}
          </p>
        ) : null}
        {refreshError ? (
          <p
            role="alert"
            className="shrink-0 border-b border-border-hairline px-3.5 py-1.5 text-xs text-destructive"
          >
            {refreshError}
          </p>
        ) : null}
        <div className="min-h-0 flex-1 overflow-auto">{outlet}</div>
      </main>
    </div>
  );
}

function useTaskboardComposerDrop(
  onMention: (mention: PluginComposerMention) => void
) {
  useEffect(() => {
    let activeForm: HTMLFormElement | null = null;
    let cue: HTMLDivElement | null = null;

    const clearTarget = () => {
      if (activeForm?.dataset.taskboardComposerDropTarget === 'active') {
        delete activeForm.dataset.taskboardComposerDropTarget;
      }
      cue?.remove();
      activeForm = null;
      cue = null;
    };

    const showTarget = (form: HTMLFormElement) => {
      if (activeForm === form) return;
      clearTarget();
      activeForm = form;
      form.dataset.taskboardComposerDropTarget = 'active';
      cue = document.createElement('div');
      cue.className = 'tb-composer-drop-cue';
      cue.setAttribute('aria-hidden', 'true');
      cue.textContent = COMPOSER_DROP_CUE_TEXT;
      form.append(cue);
    };

    const onDragOver = (event: DragEvent) => {
      const transfer = event.dataTransfer;
      if (
        !transfer ||
        !hasTaskboardComposerDragType(transfer.types)
      ) {
        clearTarget();
        return;
      }
      const target = composerDropTarget(event.target);
      if (target === null) {
        clearTarget();
        return;
      }
      event.preventDefault();
      event.stopImmediatePropagation();
      transfer.dropEffect = 'copy';
      showTarget(target.form);
    };

    const onDrop = (event: DragEvent) => {
      const transfer = event.dataTransfer;
      const target = composerDropTarget(event.target);
      if (
        !transfer ||
        target === null ||
        !hasTaskboardComposerDragType(transfer.types)
      ) {
        clearTarget();
        return;
      }
      const mention = parseTaskboardComposerMention(
        transfer.getData(TASKBOARD_COMPOSER_MIME)
      );
      clearTarget();
      if (mention === null) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      onMention(mention);
    };

    document.addEventListener('dragover', onDragOver, true);
    document.addEventListener('drop', onDrop, true);
    document.addEventListener('dragend', clearTarget, true);
    window.addEventListener('blur', clearTarget);
    return () => {
      document.removeEventListener('dragover', onDragOver, true);
      document.removeEventListener('drop', onDrop, true);
      document.removeEventListener('dragend', clearTarget, true);
      window.removeEventListener('blur', clearTarget);
      clearTarget();
    };
  }, [onMention]);
}

function TaskboardRightPanel({
  projectId
}: {
  projectId: string | null | undefined;
}) {
  const rpc = useRpc<TaskboardRpcContract>();
  const navigate = useBbNavigate();
  const composer = useComposer();
  const [itemRoute, setItemRoute] = useState<Extract<
    TrackerRoute,
    { kind: 'item' }
  > | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [refreshGeneration, setRefreshGeneration] = useState(0);
  const [pinned, setPinned] = useState(loadRightPanelPinned);
  const [composerAnnouncement, setComposerAnnouncement] = useState('');

  const insertComposerMention = useCallback(
    (mention: PluginComposerMention) => {
      const payload = serializeTaskboardComposerMention(mention);
      const safeMention = payload
        ? parseTaskboardComposerMention(payload)
        : null;
      if (safeMention === null) {
        toast.error('This ticket could not be added to chat.');
        return;
      }
      setComposerAnnouncement(`Added ${safeMention.label} to chat`);
      composer.insertMention(safeMention);
      composer.focus();
      toast.success(`Added ${safeMention.label} to chat`);
    },
    [composer]
  );
  const addItemToComposer = useCallback(
    (item: WorkItem) => insertComposerMention(taskboardComposerMention(item)),
    [insertComposerMention]
  );
  useTaskboardComposerDrop(insertComposerMention);

  useEffect(() => {
    setItemRoute(null);
    setRefreshError(null);
  }, [projectId]);
  useEffect(() => {
    const syncPinned = () => setPinned(loadRightPanelPinned());
    const syncStoredPin = (event: StorageEvent) => {
      if (event.key === RIGHT_PANEL_PINNED_STORAGE_KEY) syncPinned();
    };
    window.addEventListener(RIGHT_PANEL_PIN_EVENT, syncPinned);
    window.addEventListener('storage', syncStoredPin);
    return () => {
      window.removeEventListener(RIGHT_PANEL_PIN_EVENT, syncPinned);
      window.removeEventListener('storage', syncStoredPin);
    };
  }, []);

  const refresh = async () => {
    if (!projectId || refreshing) return;
    setRefreshing(true);
    setRefreshError(null);
    try {
      await rpc.call('refresh', { projectId });
      setRefreshGeneration(generation => generation + 1);
    } catch (nextError) {
      setRefreshError(describeError(nextError));
    } finally {
      setRefreshing(false);
    }
  };

  const activeItemRoute =
    projectId && itemRoute?.projectId === projectId ? itemRoute : null;
  const fullRoute: TrackerRoute =
    activeItemRoute ??
    (projectId
      ? { kind: 'project', projectId }
      : { kind: 'root' });

  return (
    <TooltipProvider delayDuration={250}>
      <div
        data-taskboard-right-panel
        className="tb-linear flex h-full min-h-0 flex-col text-foreground"
      >
        <p
          role="status"
          aria-live="polite"
          aria-atomic="true"
          className="sr-only"
        >
          {composerAnnouncement}
        </p>
        <header className="tb-topbar flex h-11 shrink-0 items-center gap-2 border-b px-2.5">
          {activeItemRoute ? (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-7"
              aria-label="Back to Taskboard issues"
              onClick={() => setItemRoute(null)}
            >
              <Icon name="ChevronLeft" className="size-4" />
            </Button>
          ) : null}
          <div className="min-w-0 flex-1">
            <p className="truncate text-xs font-semibold">
              {activeItemRoute ? activeItemRoute.locator : 'Taskboard'}
            </p>
            <p className="truncate text-2xs text-muted-foreground">
              {projectId === undefined
                ? 'Loading thread project…'
                : projectId
                ? pinned
                  ? 'Pinned across chats'
                  : 'Open beside this chat'
                : 'Choose a BB project'}
            </p>
          </div>
          {!activeItemRoute ? (
            <DirectCreateIssueAction
              projectId={projectId ?? null}
              variant="icon"
            />
          ) : null}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-7"
                aria-label={
                  pinned
                    ? 'Unpin Taskboard from the right panel'
                    : 'Keep Taskboard pinned across chats'
                }
                aria-pressed={pinned}
                onClick={() => storeRightPanelPinned(!pinned)}
              >
                <Icon
                  name={pinned ? 'Pin' : 'PinOff'}
                  className="size-3.5"
                />
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              {pinned ? 'Stop reopening across chats' : 'Keep open across chats'}
            </TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-7"
                aria-label="Refresh Taskboard"
                disabled={!projectId || refreshing}
                onClick={() => void refresh()}
              >
                <Icon
                  name="RotateCcw"
                  className={cn('size-3.5', refreshing && 'animate-spin')}
                />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Refresh Taskboard</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-7"
                aria-label="Open full Taskboard"
                onClick={() =>
                  navigate.toPluginPanel(PANEL_PATH, {
                    subPath: routeToSubPath(fullRoute)
                  })
                }
              >
                <Icon name="Maximize2" className="size-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Open full Taskboard</TooltipContent>
          </Tooltip>
        </header>
        {refreshError ? (
          <p
            role="alert"
            className="shrink-0 border-b border-border-hairline px-3 py-1.5 text-xs text-destructive"
          >
            {refreshError}
          </p>
        ) : null}
        <div
          className={cn(
            'min-h-0 flex-1',
            activeItemRoute ? 'overflow-y-auto' : 'overflow-hidden'
          )}
        >
          {projectId === undefined ? (
            <LoadingRows />
          ) : projectId === null ? (
            <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
              <Icon name="Folder" className="size-5 text-muted-foreground" />
              <p className="text-sm font-medium">Choose a project</p>
              <p className="max-w-xs text-xs text-muted-foreground">
                Select a BB project in the composer to load its Taskboard here.
              </p>
            </div>
          ) : activeItemRoute ? (
            <TrackerDetail
              route={activeItemRoute}
              refreshGeneration={refreshGeneration}
              onAddToComposer={addItemToComposer}
            />
          ) : (
            <TrackerList
              key={projectId}
              projectId={projectId}
              projects={undefined}
              refreshGeneration={refreshGeneration}
              surfaceMode="constrained"
              onOpen={item =>
                setItemRoute({
                  kind: 'item',
                  projectId: item.bbProjectId,
                  source: item.source,
                  locator: item.locator
                })
              }
            />
          )}
        </div>
      </div>
    </TooltipProvider>
  );
}

function TaskboardThreadPanel({ threadId }: PluginThreadPanelProps) {
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

function TaskboardNewThreadPanel({ projectId }: PluginNewThreadPanelProps) {
  return <TaskboardRightPanel projectId={projectId} />;
}

function TaskboardThreadHeaderAction({
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
  const [linearDraft, setLinearDraft] = useState('');
  const [jiraDraft, setJiraDraft] = useState('');
  const [removeLinear, setRemoveLinear] = useState(false);
  const [removeJira, setRemoveJira] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const interactionIdRef = useRef(interaction.id);
  interactionIdRef.current = interaction.id;

  useEffect(() => {
    setLinearDraft('');
    setJiraDraft('');
    setRemoveLinear(false);
    setRemoveJira(false);
    setBusy(false);
    setError(null);
  }, [interaction.id]);

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
  const hasChanges =
    linearDraft.trim() !== '' ||
    jiraDraft.trim() !== '' ||
    removeLinear ||
    removeJira;
  const submitCredentials = async () => {
    const submittedInteractionId = interaction.id;
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
        <div className="rounded-lg border border-border bg-card p-3">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <label
              htmlFor={`linear-${interaction.id}`}
              className="text-xs font-semibold"
            >
              Linear API key
            </label>
            <CredentialStatus
              configured={payload.linearCredentialConfigured}
              hasDraft={linearDraft.trim() !== ''}
              remove={removeLinear}
            />
          </div>
          <Input
            id={`linear-${interaction.id}`}
            type="password"
            autoComplete="new-password"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            value={linearDraft}
            placeholder={
              payload.linearCredentialConfigured
                ? 'Enter to replace current key'
                : 'Enter project API key'
            }
            disabled={busy || removeLinear}
            onChange={event => {
              setLinearDraft(event.target.value);
              setError(null);
            }}
          />
          {payload.linearCredentialConfigured ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="mt-2 text-destructive hover:text-destructive"
              disabled={busy}
              onClick={() => {
                setRemoveLinear(value => !value);
                setLinearDraft('');
                setError(null);
              }}
            >
              {removeLinear
                ? 'Keep Linear credential'
                : 'Remove Linear credential'}
            </Button>
          ) : null}
        </div>

        <div className="rounded-lg border border-border bg-card p-3">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <label
              htmlFor={`jira-${interaction.id}`}
              className="text-xs font-semibold"
            >
              Jira API token
            </label>
            <CredentialStatus
              configured={payload.jiraCredentialConfigured}
              hasDraft={jiraDraft.trim() !== ''}
              remove={removeJira}
            />
          </div>
          <Input
            id={`jira-${interaction.id}`}
            type="password"
            autoComplete="new-password"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            value={jiraDraft}
            placeholder={
              payload.jiraCredentialConfigured
                ? 'Enter to replace current token'
                : 'Enter project API token'
            }
            disabled={busy || removeJira}
            onChange={event => {
              setJiraDraft(event.target.value);
              setError(null);
            }}
          />
          {payload.jiraCredentialConfigured ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="mt-2 text-destructive hover:text-destructive"
              disabled={busy}
              onClick={() => {
                setRemoveJira(value => !value);
                setJiraDraft('');
                setError(null);
              }}
            >
              {removeJira ? 'Keep Jira credential' : 'Remove Jira credential'}
            </Button>
          ) : null}
        </div>
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

function ProjectCredentialsInteraction(props: PluginPendingInteractionProps) {
  return (
    <ProjectCredentialsInteractionForm key={props.interaction.id} {...props} />
  );
}

function TaskboardSettingsInfo() {
  const navigate = useBbNavigate();
  const { projectId } = useBbContext();
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        Each BB project has its own tracker connection, filter set, default
        layout, and workflow status order.
      </p>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() =>
          navigate.toPluginPanel(PANEL_PATH, {
            subPath: projectId
              ? routeToSubPath({ kind: 'manage', projectId })
              : 'manage'
          })
        }
      >
        <Icon name="Settings" className="size-4" />
        Open Taskboard project settings
      </Button>
    </div>
  );
}

export default definePluginApp(app => {
  app.composer.customize({
    id: 'create-taskboard-issue',
    scopes: ['thread', 'new-thread'],
    actions: [
      { id: 'create-issue', component: ComposerCreateIssueAction }
    ]
  });
  app.slots.threadPanelAction({
    id: THREAD_PANEL_ACTION_ID,
    title: 'Taskboard',
    icon: 'Target',
    component: TaskboardThreadPanel,
    layout: 'flush'
  });
  app.slots.experimental_newThreadPanelAction({
    id: 'taskboard-new-thread-panel',
    title: 'Taskboard',
    icon: 'Target',
    component: TaskboardNewThreadPanel,
    layout: 'flush'
  });
  app.slots.experimental_threadHeaderAction({
    id: 'open-taskboard-panel',
    title: 'Taskboard',
    component: TaskboardThreadHeaderAction
  });
  app.slots.navPanel({
    id: 'taskboard',
    title: 'Taskboard',
    icon: 'Target',
    path: PANEL_PATH,
    component: TaskboardPanel,
    headerContent: ManageHeaderAction
  });
  app.slots.settingsSection({
    id: 'connections',
    title: 'Project settings',
    description: 'Configure each project’s tracker and board experience.',
    component: TaskboardSettingsInfo
  });
  app.slots.pendingInteraction({
    id: 'taskboard-credentials',
    component: ProjectCredentialsInteraction
  });
});
