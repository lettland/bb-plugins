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
  type PluginNavPanelProps,
  type PluginPendingInteractionProps,
  useBbContext,
  useBbNavigate,
  useRpc
} from '@get-bb/plugin-sdk/app';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
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
  FILTER_PRESET_NAME_MAX_LENGTH,
  type FilterPreset,
  type ProjectConfigMutation,
  type ProjectConfigView,
  type ProjectCredentialsInteractionResponse,
  type SecretMutation,
  type TaskboardRpcContract,
  type TrackerProject,
  type WorkSource
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
  availableContextProjectId,
  contextSelectionToken,
  type NavigationEntryLike,
  previousProjectRouteContext,
  projectRouteContext,
  type ProjectRouteContext,
  shouldApplyContextProject
} from './project-selection.js';
import {
  parseTrackerRoute,
  routeToSubPath,
  type TrackerRoute
} from './features/shared/route.js';
import {
  loadLastProjectId,
  loadSidebarCollapsed,
  storeLastProjectId,
  storeSidebarCollapsed
} from './features/shared/storage.js';
import {
  ComposerCreateIssueAction,
  DirectCreateIssueAction
} from './features/create-issue/create-issue-actions.js';
import {
  PANEL_PATH,
  SIDEBAR_AUTO_COLLAPSE_WIDTH,
  THREAD_PANEL_ACTION_ID
} from './features/shared/constants.js';
import {
  describeError,
  useRefreshOnReconnect
} from './features/shared/format.js';
import { SourceGlyph, sourceName } from './features/shared/source.js';
import { BOARD_FILTER_OPTIONS, toggled } from './features/shared/filters.js';
import {
  useProjectFilterPresets
} from './features/filter-presets/use-project-filter-presets.js';
import { SidebarDrawer, TrackerSidebar } from './features/sidebar/sidebar.js';
import { EmptyState, LoadingRows } from './features/list/list-states.js';
import { TrackerDetail } from './features/detail/tracker-detail.js';
import { TrackerList } from './features/list/tracker-list.js';
import { TrackerTopbar } from './features/sidebar/topbar.js';
import {
  TaskboardNewThreadPanel,
  TaskboardThreadHeaderAction,
  TaskboardThreadPanel
} from './features/panel/thread-panels.js';
import './app.css';

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
