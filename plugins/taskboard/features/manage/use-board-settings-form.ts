import { useEffect, useState } from 'react';
import {
  defaultProjectBoardSettings,
  type ProjectBoardSettings,
  projectBoardSettingsSchema
} from '../../board-settings.js';
import { describeError } from '../shared/format.js';

function boardSettingsFingerprint(settings: ProjectBoardSettings): string {
  return JSON.stringify({
    defaultView: settings.defaultView,
    enabledFilters: settings.enabledFilters,
    statusOrder: settings.statusOrder
  });
}

export function useBoardSettingsForm({
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

  const resetDefaults = () => {
    const defaults = defaultProjectBoardSettings(settings.projectId);
    setSettings(defaults);
    setStatusOrderText(defaults.statusOrder.join('\n'));
    setSaved(false);
    setError(null);
  };

  return {
    settings,
    setSettings,
    statusOrderText,
    setStatusOrderText,
    saving,
    saved,
    setSaved,
    error,
    dirty,
    save,
    resetDefaults
  };
}
