import { useId } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { FILTER_PRESET_NAME_MAX_LENGTH } from '../../contract.js';

export function SavePresetDialog({
  presetNameDraft,
  setPresetNameDraft,
  presetSaveError,
  setPresetSaveError,
  savingPreset,
  onSave
}: {
  presetNameDraft: string | null;
  setPresetNameDraft: (draft: string | null) => void;
  presetSaveError: string | null;
  setPresetSaveError: (error: string | null) => void;
  savingPreset: boolean;
  onSave: (name: string) => void;
}) {
  const presetSaveDescriptionId = useId();
  const presetSaveErrorId = useId();
  const close = () => {
    setPresetNameDraft(null);
    setPresetSaveError(null);
  };
  return (
    <Dialog
      open={presetNameDraft !== null}
      onOpenChange={open => {
        if (!open && !savingPreset) close();
      }}
    >
      <DialogContent aria-busy={savingPreset}>
        <DialogHeader>
          <DialogTitle>Save filter preset</DialogTitle>
          <DialogDescription id={presetSaveDescriptionId}>
            Save the current filters, search, layout, and collapsed groups
            for this project.
          </DialogDescription>
        </DialogHeader>
        <form
          onSubmit={event => {
            event.preventDefault();
            const name = (presetNameDraft ?? '').trim();
            if (name) onSave(name);
          }}
          className="flex flex-col gap-3"
        >
          <Input
            autoFocus
            value={presetNameDraft ?? ''}
            disabled={savingPreset}
            onChange={event => setPresetNameDraft(event.target.value)}
            placeholder="My work"
            maxLength={FILTER_PRESET_NAME_MAX_LENGTH}
            aria-label="Preset name"
            aria-invalid={presetSaveError !== null}
            aria-describedby={
              presetSaveError
                ? `${presetSaveDescriptionId} ${presetSaveErrorId}`
                : presetSaveDescriptionId
            }
          />
          {presetSaveError ? (
            <p
              id={presetSaveErrorId}
              role="alert"
              className="text-sm text-destructive"
            >
              {presetSaveError}
            </p>
          ) : null}
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="ghost"
              disabled={savingPreset}
              onClick={close}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={savingPreset || !(presetNameDraft ?? '').trim()}
            >
              {savingPreset ? 'Saving…' : 'Save'}
            </Button>
          </div>
          {savingPreset ? (
            <p role="status" className="sr-only">
              Saving filter preset
            </p>
          ) : null}
        </form>
      </DialogContent>
    </Dialog>
  );
}
