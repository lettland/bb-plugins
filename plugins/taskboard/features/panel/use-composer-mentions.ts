import { useCallback, useEffect, useState } from 'react';
import {
  type PluginComposerMention,
  useComposer
} from '@get-bb/plugin-sdk/app';
import { toast } from 'sonner';
import { type WorkItem } from '../../contract.js';
import {
  parseTaskboardComposerMention,
  serializeTaskboardComposerMention,
  taskboardComposerMention
} from '../../composer-handoff.js';
import { useTaskboardComposerDrop } from './composer-drop.js';
import {
  loadRightPanelPinned,
  RIGHT_PANEL_PIN_EVENT,
  RIGHT_PANEL_PINNED_STORAGE_KEY
} from '../shared/storage.js';

export function useComposerMentions() {
  const composer = useComposer();
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

  return { composerAnnouncement, addItemToComposer };
}

export function useRightPanelPinned(): boolean {
  const [pinned, setPinned] = useState(loadRightPanelPinned);
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
  return pinned;
}
