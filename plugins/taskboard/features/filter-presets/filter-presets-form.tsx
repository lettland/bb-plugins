import { type ReactNode } from 'react';
import { useRpc } from '@get-bb/plugin-sdk/app';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { type TaskboardRpcContract } from '../../contract.js';
import {
  type ProjectFilterPresets,
  useProjectFilterPresets
} from './use-project-filter-presets.js';
import {
  type PresetMutationState,
  usePresetFocus,
  usePresetMutationState,
  usePresetNameDrafts
} from './use-preset-form-state.js';
import {
  movePreset,
  type PresetActionContext,
  removePreset,
  renamePreset
} from './preset-actions.js';
import { PresetRow } from './preset-row.js';

function PresetListBody({
  presetState,
  children
}: {
  presetState: ProjectFilterPresets;
  children: ReactNode;
}) {
  if (presetState.loading) {
    return (
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
    );
  }
  if (presetState.error) {
    return (
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
    );
  }
  if (presetState.presets.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        Save a preset from the Presets menu on this project&apos;s board.
      </p>
    );
  }
  return <ul className="flex min-w-0 flex-col gap-2">{children}</ul>;
}

function PresetRefreshNotice({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-md border border-border px-3 py-2">
      <p role="alert" className="min-w-0 flex-1 text-xs text-muted-foreground">
        Could not refresh presets. Keeping your loaded presets and edits.
      </p>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="max-md:pointer-coarse:h-10"
        onClick={onRetry}
      >
        Try again
      </Button>
    </div>
  );
}

function PresetMutationFeedback({
  mutation
}: {
  mutation: PresetMutationState;
}) {
  const { mutating, mutationFeedback, mutationFeedbackId } = mutation;
  if (mutationFeedback?.kind === 'error') {
    return (
      <p
        id={mutationFeedbackId}
        role="alert"
        className="text-xs text-destructive"
      >
        {mutationFeedback.message}
      </p>
    );
  }
  if (mutating) {
    return (
      <p role="status" className="text-xs text-muted-foreground">
        Updating presets…
      </p>
    );
  }
  if (mutationFeedback?.kind === 'status') {
    return (
      <p role="status" className="text-xs text-muted-foreground">
        {mutationFeedback.message}
      </p>
    );
  }
  return null;
}

export function FilterPresetsForm({ projectId }: { projectId: string }) {
  const rpc = useRpc<TaskboardRpcContract>();
  const presetState = useProjectFilterPresets(projectId);
  const { nameDrafts, setNameDrafts } = usePresetNameDrafts(
    presetState.presets
  );
  const mutation = usePresetMutationState();
  const focus = usePresetFocus();
  const actionContext: PresetActionContext = {
    rpc,
    projectId,
    presetState,
    nameDrafts,
    setNameDrafts,
    mutation,
    focus
  };

  return (
    <div className="tb-settings-card space-y-3 rounded-lg border p-4 @lg:p-5">
      <div className="space-y-1">
        <h3
          ref={focus.headingRef}
          tabIndex={-1}
          className="text-sm font-semibold"
        >
          Filter presets
        </h3>
        <p className="max-w-2xl text-xs leading-relaxed text-muted-foreground">
          Rename, reorder, or delete this project&apos;s saved views.
        </p>
      </div>
      <PresetListBody presetState={presetState}>
        {presetState.presets.map((preset, index) => (
          <PresetRow
            key={preset.id}
            preset={preset}
            index={index}
            count={presetState.presets.length}
            nameDrafts={nameDrafts}
            mutation={mutation}
            focus={focus}
            onDraftChange={name =>
              setNameDrafts(current => ({ ...current, [preset.id]: name }))
            }
            onDraftReset={() =>
              setNameDrafts(current => ({
                ...current,
                [preset.id]: preset.name
              }))
            }
            onRename={() => void renamePreset(actionContext, preset)}
            onMove={delta => void movePreset(actionContext, preset, delta)}
            onRemove={() => void removePreset(actionContext, preset)}
          />
        ))}
      </PresetListBody>
      {presetState.refreshError && !presetState.error ? (
        <PresetRefreshNotice
          onRetry={() => void presetState.reload({ background: true })}
        />
      ) : null}
      <PresetMutationFeedback mutation={mutation} />
    </div>
  );
}
