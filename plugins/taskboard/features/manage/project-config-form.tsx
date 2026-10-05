import { type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  type ProjectConfigMutation,
  type ProjectConfigView,
  type WorkSource
} from '../../contract.js';
import { TRACKER_OPTIONS } from './project-config-model.js';
import { SourceGlyph, sourceName } from '../shared/source.js';
import {
  type ProjectConfigState,
  useProjectConfigSave,
  useProjectConfigState
} from './use-project-config-form.js';
import {
  CredentialStatus,
  RemoveCredentialButton,
  SecretField
} from './credential-parts.js';

const CARD_CLASS = 'tb-settings-card rounded-lg border p-4 @lg:p-5';

function TrackerPicker({
  source,
  onSelect
}: {
  source: WorkSource;
  onSelect: (source: WorkSource) => void;
}) {
  return (
    <div
      className="grid gap-2 @lg:grid-cols-3"
      role="radiogroup"
      aria-label="External tracker"
    >
      {TRACKER_OPTIONS.map(option => {
        const selected = source === option.source;
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
              onChange={() => onSelect(option.source)}
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
  );
}

function ConnectorHeader({
  source,
  title,
  wrap,
  status,
  children
}: {
  source: WorkSource;
  title: string;
  wrap: boolean;
  status?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="space-y-1">
        <div
          className={
            wrap
              ? 'flex flex-wrap items-center gap-2'
              : 'flex items-center gap-2'
          }
        >
          <span className="flex size-7 items-center justify-center rounded-md border border-border bg-secondary">
            <SourceGlyph source={source} />
          </span>
          <h3
            id={`${source}-connector-title`}
            className="text-sm font-semibold"
          >
            {title}
          </h3>
          {status}
        </div>
        {children}
      </div>
    </div>
  );
}

function GithubSection({ config }: { config: ProjectConfigView }) {
  return (
    <section className={CARD_CLASS} aria-labelledby="github-connector-title">
      <ConnectorHeader source="github" title="GitHub" wrap={false}>
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
      </ConnectorHeader>
    </section>
  );
}

function LinearSection({ state }: { state: ProjectConfigState }) {
  const { baseline, config, setConfig, linearDraft, setLinearDraft } = state;
  const { removeLinear, setRemoveLinear, saving, setSaved } = state;
  return (
    <section className={CARD_CLASS} aria-labelledby="linear-connector-title">
      <ConnectorHeader
        source="linear"
        title="Linear"
        wrap
        status={
          <CredentialStatus
            configured={baseline.linearCredentialConfigured}
            hasDraft={linearDraft.trim() !== ''}
            remove={removeLinear}
          />
        }
      >
        <p className="max-w-xl text-xs leading-relaxed text-muted-foreground">
          This API key belongs only to this BB project. A team key is
          required so the project cannot silently mix work from other
          teams.
        </p>
      </ConnectorHeader>
      <div className="mt-4 grid gap-3 @lg:grid-cols-2">
        <SecretField
          label="Linear API key"
          labelClassName="space-y-1.5 text-xs font-medium"
          inputProps={{
            'aria-label': 'Linear API key',
            value: linearDraft,
            placeholder: baseline.linearCredentialConfigured
              ? 'Enter to replace current key'
              : 'Enter project API key',
            className: 'tb-field',
            disabled: saving || removeLinear,
            onChange: event => {
              setLinearDraft(event.target.value);
              setSaved(false);
            }
          }}
        />
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
        <RemoveCredentialButton
          provider="Linear"
          removed={removeLinear}
          disabled={saving}
          className="mt-3 text-destructive hover:text-destructive"
          showIcon
          onToggle={() => {
            setRemoveLinear(!removeLinear);
            setLinearDraft('');
            setSaved(false);
          }}
        />
      ) : null}
    </section>
  );
}

function JiraSection({ state }: { state: ProjectConfigState }) {
  const { baseline, config, setConfig, jiraDraft, setJiraDraft } = state;
  const { removeJira, setRemoveJira, saving, setSaved } = state;
  return (
    <section className={CARD_CLASS} aria-labelledby="jira-connector-title">
      <ConnectorHeader
        source="jira"
        title="Jira"
        wrap
        status={
          <CredentialStatus
            configured={baseline.jiraCredentialConfigured}
            hasDraft={jiraDraft.trim() !== ''}
            remove={removeJira}
          />
        }
      >
        <p className="max-w-xl text-xs leading-relaxed text-muted-foreground">
          Jira accepts HTTPS atlassian.net sites only. Changing the site
          or account email requires replacing or removing the token.
        </p>
      </ConnectorHeader>
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
        <SecretField
          label="Jira API token"
          labelClassName="space-y-1.5 text-xs font-medium @lg:col-span-2"
          inputProps={{
            'aria-label': 'Jira API token',
            value: jiraDraft,
            placeholder: baseline.jiraCredentialConfigured
              ? 'Enter to replace current token'
              : 'Enter project API token',
            className: 'tb-field',
            disabled: saving || removeJira,
            onChange: event => {
              setJiraDraft(event.target.value);
              setSaved(false);
            }
          }}
        />
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
        <RemoveCredentialButton
          provider="Jira"
          removed={removeJira}
          disabled={saving}
          className="mt-3 text-destructive hover:text-destructive"
          showIcon
          onToggle={() => {
            setRemoveJira(!removeJira);
            setJiraDraft('');
            setSaved(false);
          }}
        />
      ) : null}
    </section>
  );
}

export function SettingsSaveStatus({
  error,
  saved,
  dirty,
  savedLabel,
  dirtyLabel
}: {
  error: string | null;
  saved: boolean;
  dirty: boolean;
  savedLabel: string;
  dirtyLabel: string;
}) {
  if (error) {
    return (
      <p role="alert" className="mr-auto max-w-xl text-sm text-destructive">
        {error}
      </p>
    );
  }
  if (saved) {
    return (
      <span role="status" className="mr-auto text-sm text-success">
        {savedLabel}
      </span>
    );
  }
  if (dirty) {
    return (
      <span className="mr-auto text-xs text-muted-foreground">
        {dirtyLabel}
      </span>
    );
  }
  return null;
}

export function ProjectConfigForm({
  initialConfig,
  onSave,
  onSavingChange
}: {
  initialConfig: ProjectConfigView;
  onSave: (mutation: ProjectConfigMutation) => Promise<ProjectConfigView>;
  onSavingChange: (saving: boolean) => void;
}) {
  const state = useProjectConfigState(initialConfig, onSavingChange);
  const { dirty, save } = useProjectConfigSave(state, onSave, onSavingChange);
  const { config, setConfig, saving, saved, error } = state;

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
        <TrackerPicker
          source={config.source}
          onSelect={source => {
            setConfig(current => ({ ...current, source }));
            state.clearCredentialDrafts();
            state.setSaved(false);
            state.setError(null);
          }}
        />
      </fieldset>

      {config.source === 'github' ? <GithubSection config={config} /> : null}
      {config.source === 'linear' ? <LinearSection state={state} /> : null}
      {config.source === 'jira' ? <JiraSection state={state} /> : null}

      <div className="tb-save-bar sticky bottom-0 flex flex-wrap items-center justify-end gap-3 rounded-lg border px-4 py-3 backdrop-blur-sm">
        <SettingsSaveStatus
          error={error}
          saved={saved}
          dirty={dirty}
          savedLabel="Project connection saved"
          dirtyLabel="Unsaved project changes"
        />
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
