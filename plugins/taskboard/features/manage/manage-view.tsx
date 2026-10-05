import { useState } from 'react';
import { useRpc } from '@get-bb/plugin-sdk/app';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import {
  type TaskboardRpcContract,
  type TrackerProject
} from '../../contract.js';
import { useManageData } from './use-manage-data.js';
import { ProjectConfigForm } from './project-config-form.js';
import { ProjectBoardSettingsForm } from './board-settings-form.js';
import { FilterPresetsForm } from '../filter-presets/filter-presets-form.js';

function ManageHero({
  projectId,
  projects,
  disabled,
  onProjectChange
}: {
  projectId: string | null;
  projects: readonly TrackerProject[] | undefined;
  disabled: boolean;
  onProjectChange: (projectId: string) => void;
}) {
  return (
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
          disabled={disabled}
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
  );
}

export function ManageView({
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
  const {
    config,
    boardSettings,
    setBoardSettings,
    loadingConfig,
    error,
    setLoadRevision
  } = useManageData(projectId);
  const [savingConfig, setSavingConfig] = useState(false);
  const [savingBoardSettings, setSavingBoardSettings] = useState(false);

  return (
    <div className="h-full overflow-y-auto p-3 @container">
      <div className="mx-auto w-full max-w-4xl space-y-4 pb-8">
        <ManageHero
          projectId={projectId}
          projects={projects}
          disabled={savingConfig || savingBoardSettings}
          onProjectChange={onProjectChange}
        />

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
