import { useEffect } from 'react';
import { type PluginComposerMention } from '@get-bb/plugin-sdk/app';
import {
  hasTaskboardComposerDragType,
  parseTaskboardComposerMention,
  TASKBOARD_COMPOSER_MIME
} from '../../composer-handoff.js';

const COMPOSER_DROP_CUE_TEXT = 'Drop to add ticket to chat';

interface ComposerDropTarget {
  editor: HTMLElement;
  form: HTMLFormElement;
}

function composerDropTarget(target: EventTarget | null): ComposerDropTarget | null {
  const element = target instanceof Element ? target : null;
  const editor = element?.closest<HTMLElement>(
    '[contenteditable="true"][role="textbox"]'
  );
  const form = editor?.closest<HTMLFormElement>('form') ?? null;
  return editor && form ? { editor, form } : null;
}

export function useTaskboardComposerDrop(
  onMention: (mention: PluginComposerMention) => void
) {
  useEffect(() => {
    let activeForm: HTMLFormElement | null = null;
    let cue: HTMLDivElement | null = null;

    const clearTarget = () => {
      if (activeForm?.dataset.taskboardComposerDropTarget === 'active') {
        delete activeForm.dataset.taskboardComposerDropTarget;
      }
      cue?.remove();
      activeForm = null;
      cue = null;
    };

    const showTarget = (form: HTMLFormElement) => {
      if (activeForm === form) return;
      clearTarget();
      activeForm = form;
      form.dataset.taskboardComposerDropTarget = 'active';
      cue = document.createElement('div');
      cue.className = 'tb-composer-drop-cue';
      cue.setAttribute('aria-hidden', 'true');
      cue.textContent = COMPOSER_DROP_CUE_TEXT;
      form.append(cue);
    };

    const onDragOver = (event: DragEvent) => {
      const transfer = event.dataTransfer;
      if (
        !transfer ||
        !hasTaskboardComposerDragType(transfer.types)
      ) {
        clearTarget();
        return;
      }
      const target = composerDropTarget(event.target);
      if (target === null) {
        clearTarget();
        return;
      }
      event.preventDefault();
      event.stopImmediatePropagation();
      transfer.dropEffect = 'copy';
      showTarget(target.form);
    };

    const onDrop = (event: DragEvent) => {
      const transfer = event.dataTransfer;
      const target = composerDropTarget(event.target);
      if (
        !transfer ||
        target === null ||
        !hasTaskboardComposerDragType(transfer.types)
      ) {
        clearTarget();
        return;
      }
      const mention = parseTaskboardComposerMention(
        transfer.getData(TASKBOARD_COMPOSER_MIME)
      );
      clearTarget();
      if (mention === null) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      onMention(mention);
    };

    document.addEventListener('dragover', onDragOver, true);
    document.addEventListener('drop', onDrop, true);
    document.addEventListener('dragend', clearTarget, true);
    window.addEventListener('blur', clearTarget);
    return () => {
      document.removeEventListener('dragover', onDragOver, true);
      document.removeEventListener('drop', onDrop, true);
      document.removeEventListener('dragend', clearTarget, true);
      window.removeEventListener('blur', clearTarget);
      clearTarget();
    };
  }, [onMention]);
}
