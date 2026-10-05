import { type MutableRefObject } from 'react';
import { Button } from '@/components/ui/button';
import { Icon, type IconName } from '@/components/ui/icon';
import { Input } from '@/components/ui/input';
import {
  FILTER_PRESET_NAME_MAX_LENGTH,
  type FilterPreset
} from '../../contract.js';
import {
  type PresetFocus,
  type PresetMutationState
} from './use-preset-form-state.js';

function mapRef<T>(refs: MutableRefObject<Map<string, T>>, key: string) {
  return (element: T | null) => {
    if (element) {
      refs.current.set(key, element);
    } else {
      refs.current.delete(key);
    }
  };
}

function PresetActionButton({
  icon,
  label,
  disabled,
  buttonRef,
  onClick
}: {
  icon: IconName;
  label: string;
  disabled: boolean;
  buttonRef?: (element: HTMLButtonElement | null) => void;
  onClick: () => void;
}) {
  return (
    <Button
      ref={buttonRef}
      type="button"
      variant="ghost"
      size="sm"
      className="h-8 w-8 p-0 max-md:pointer-coarse:h-10 max-md:pointer-coarse:w-10"
      disabled={disabled}
      aria-label={label}
      onClick={onClick}
    >
      <Icon name={icon} className="size-3" />
    </Button>
  );
}

export function PresetRow({
  preset,
  index,
  count,
  nameDrafts,
  mutation,
  focus,
  onDraftChange,
  onDraftReset,
  onRename,
  onMove,
  onRemove
}: {
  preset: FilterPreset;
  index: number;
  count: number;
  nameDrafts: Record<string, string>;
  mutation: PresetMutationState;
  focus: PresetFocus;
  onDraftChange: (name: string) => void;
  onDraftReset: () => void;
  onRename: () => void;
  onMove: (delta: number) => void;
  onRemove: () => void;
}) {
  const { mutating, mutationFeedback, mutationFeedbackId } = mutation;
  const feedbackIsForPreset =
    mutationFeedback?.kind === 'error' &&
    mutationFeedback.presetId === preset.id;
  return (
    <li className="flex min-w-0 flex-col gap-1.5 @sm:flex-row @sm:items-center @sm:gap-2">
      <Input
        ref={mapRef(focus.presetNameInputRefs, preset.id)}
        value={nameDrafts[preset.id] ?? preset.name}
        maxLength={FILTER_PRESET_NAME_MAX_LENGTH}
        disabled={mutating}
        aria-label={`Preset name for ${preset.name}`}
        aria-invalid={feedbackIsForPreset}
        aria-describedby={feedbackIsForPreset ? mutationFeedbackId : undefined}
        className="h-8 min-w-0 w-full text-xs max-md:pointer-coarse:h-10 @sm:flex-1"
        onChange={event => {
          onDraftChange(event.target.value);
          if (feedbackIsForPreset) mutation.setMutationFeedback(null);
        }}
        onKeyDown={event => {
          if (event.key === 'Enter') {
            event.preventDefault();
            onRename();
          } else if (event.key === 'Escape') {
            event.preventDefault();
            onDraftReset();
            if (mutationFeedback?.presetId === preset.id) {
              mutation.setMutationFeedback(null);
            }
          }
        }}
      />
      <div className="flex w-full min-w-0 flex-wrap items-center justify-end gap-1 @sm:w-auto @sm:shrink-0">
        <PresetActionButton
          icon="Check"
          label={`Save name for ${preset.name}`}
          disabled={
            mutating || (nameDrafts[preset.id] ?? preset.name) === preset.name
          }
          onClick={onRename}
        />
        <PresetActionButton
          icon="ChevronUp"
          label={`Move ${preset.name} up`}
          disabled={mutating || index === 0}
          buttonRef={mapRef(
            focus.presetActionButtonRefs,
            `${preset.id}:move-up`
          )}
          onClick={() => onMove(-1)}
        />
        <PresetActionButton
          icon="ChevronDown"
          label={`Move ${preset.name} down`}
          disabled={mutating || index === count - 1}
          buttonRef={mapRef(
            focus.presetActionButtonRefs,
            `${preset.id}:move-down`
          )}
          onClick={() => onMove(1)}
        />
        <PresetActionButton
          icon="Trash2"
          label={`Delete ${preset.name}`}
          disabled={mutating}
          buttonRef={mapRef(
            focus.presetActionButtonRefs,
            `${preset.id}:delete`
          )}
          onClick={onRemove}
        />
      </div>
    </li>
  );
}
