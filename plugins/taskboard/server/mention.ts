import { formatWorkItemContext, sourceName } from '../contract.js';
import { assertSelectedSource } from './adapters.js';
import type { TaskboardContext } from './context.js';
import { assertProjectExists } from './projects.js';
import { mentionId, parseMentionId } from './util.js';

export function registerMentionProvider(tc: TaskboardContext): void {
  tc.bb.ui.registerMentionProvider({
    id: 'external-work-item',
    label: 'Taskboard',
    triggers: ['@', '#'],
    async search({ query, projectId }) {
      const trimmed = query.trim();
      if (!projectId || trimmed.length < 2) return [];
      try {
        await assertProjectExists(tc, projectId);
      } catch {
        return [];
      }
      return tc.store
        .list({ projectId, query: trimmed, limit: 10 })
        .map(item => ({
          id: mentionId(item),
          title: `${item.key} ${item.title}`,
          subtitle: `${sourceName(item.source)} · ${item.status}${item.assignee ? ` · ${item.assignee}` : ''}`
        }));
    },
    async resolve(itemId) {
      const { projectId, source, locator } = parseMentionId(itemId);
      await assertProjectExists(tc, projectId);
      assertSelectedSource(tc, projectId, source);
      const item = tc.store.get(projectId, source, locator);
      if (!item) throw new Error('Taskboard item is no longer available');
      return { context: formatWorkItemContext(item) };
    }
  });
}
