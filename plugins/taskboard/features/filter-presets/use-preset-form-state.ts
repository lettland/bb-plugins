import { useEffect, useId, useRef, useState } from 'react';
import { toast } from 'sonner';
import { type FilterPreset } from '../../contract.js';
import { describeError } from '../shared/format.js';

type PresetFeedback = {
  kind: 'error' | 'status';
  message: string;
  presetId?: string;
} | null;

export function usePresetNameDrafts(presets: readonly FilterPreset[]) {
  const [nameDrafts, setNameDrafts] = useState<Record<string, string>>({});
  const authoritativeNamesRef = useRef(new Map<string, string>());

  useEffect(() => {
    const previousNames = authoritativeNamesRef.current;
    const nextNames = new Map(presets.map(preset => [preset.id, preset.name]));
    setNameDrafts(current =>
      Object.fromEntries(
        presets.map(preset => {
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
  }, [presets]);

  return { nameDrafts, setNameDrafts };
}

export function usePresetFocus() {
  const presetNameInputRefs = useRef(new Map<string, HTMLInputElement>());
  const presetActionButtonRefs = useRef(new Map<string, HTMLButtonElement>());
  const headingRef = useRef<HTMLHeadingElement>(null);

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

  return {
    presetNameInputRefs,
    presetActionButtonRefs,
    headingRef,
    restorePresetFocus
  };
}

export function usePresetMutationState() {
  const [mutating, setMutating] = useState(false);
  const [mutationFeedback, setMutationFeedback] =
    useState<PresetFeedback>(null);
  const mutationInFlightRef = useRef(false);
  const mutationFeedbackId = useId();

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

  return {
    mutating,
    mutationFeedback,
    setMutationFeedback,
    mutationInFlightRef,
    mutationFeedbackId,
    beginMutation,
    finishMutation,
    reportMutationError
  };
}

export type PresetMutationState = ReturnType<typeof usePresetMutationState>;
export type PresetFocus = ReturnType<typeof usePresetFocus>;
