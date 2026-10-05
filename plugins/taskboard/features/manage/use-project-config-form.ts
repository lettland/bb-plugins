import { useCallback, useEffect, useState } from 'react';
import {
  type ProjectConfigMutation,
  type ProjectConfigView
} from '../../contract.js';
import {
  configFingerprint,
  secretMutation,
  validateProjectConfig
} from './project-config-model.js';
import { describeError } from '../shared/format.js';

export function useProjectConfigState(
  initialConfig: ProjectConfigView,
  onSavingChange: (saving: boolean) => void
) {
  const [baseline, setBaseline] = useState(initialConfig);
  const [config, setConfig] = useState(initialConfig);
  const [linearDraft, setLinearDraft] = useState('');
  const [jiraDraft, setJiraDraft] = useState('');
  const [removeLinear, setRemoveLinear] = useState(false);
  const [removeJira, setRemoveJira] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const clearCredentialDrafts = useCallback(() => {
    setLinearDraft('');
    setJiraDraft('');
    setRemoveLinear(false);
    setRemoveJira(false);
  }, []);

  useEffect(() => {
    setBaseline(initialConfig);
    setConfig(initialConfig);
    clearCredentialDrafts();
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

  return {
    baseline,
    setBaseline,
    config,
    setConfig,
    linearDraft,
    setLinearDraft,
    jiraDraft,
    setJiraDraft,
    removeLinear,
    setRemoveLinear,
    removeJira,
    setRemoveJira,
    saving,
    setSaving,
    saved,
    setSaved,
    error,
    setError,
    clearCredentialDrafts
  };
}

export type ProjectConfigState = ReturnType<typeof useProjectConfigState>;

export function useProjectConfigSave(
  state: ProjectConfigState,
  onSave: (mutation: ProjectConfigMutation) => Promise<ProjectConfigView>,
  onSavingChange: (saving: boolean) => void
) {
  const { baseline, config, linearDraft, jiraDraft } = state;
  const { removeLinear, removeJira, saving } = state;
  const { setBaseline, setConfig, setSaving, setSaved, setError } = state;
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
    const validation = validateProjectConfig({
      config,
      baseline,
      linearCredential,
      jiraCredential
    });
    if (validation.error !== null) {
      setError(validation.error);
      return;
    }

    setSaving(true);
    onSavingChange(true);
    try {
      const result = await onSave({
        projectId: config.projectId,
        source: config.source,
        linearTeamKey: config.linearTeamKey.trim(),
        jiraBaseUrl: validation.jiraBaseUrl,
        jiraEmail: config.jiraEmail.trim(),
        jiraJql: config.jiraJql.trim(),
        linearCredential,
        jiraCredential
      });
      setBaseline(result);
      setConfig(result);
      state.clearCredentialDrafts();
      setSaved(true);
    } catch (nextError) {
      setError(describeError(nextError));
    } finally {
      setSaving(false);
      onSavingChange(false);
    }
  };

  return { dirty, save };
}
