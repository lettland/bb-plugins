import type { PluginRpcHandlers } from '@get-bb/plugin-sdk';
import { filterPresetSummary, taskboardRpcContract } from '../contract.js';
import {
  assertSelectedSourceAfterMutations,
  statuses
} from './adapters.js';
import { SOURCES } from './constants.js';
import type { TaskboardContext } from './context.js';
import {
  createWorkItem,
  getCreateIssueContext,
  getCreateIssueMetadata
} from './create.js';
import { getLiveItem, liveStatusOptions, updateItemStatus } from './items.js';
import { waitForMutations } from './mutations.js';
import { persistProjectConfig } from './config.js';
import {
  publishFilterPresetsChanged,
  saveFilterPresetLinearized
} from './presets.js';
import {
  assertProjectExists,
  listProjects,
  projectConfig,
  readProjectConfigView
} from './projects.js';
import { syncAll } from './sync.js';
import { mentionId, refreshedItemCount } from './util.js';

type Handlers = PluginRpcHandlers<typeof taskboardRpcContract>;

function createProjectHandlers(
  tc: TaskboardContext
): Pick<Handlers, 'listProjects' | 'threadProject' | 'status' | 'listItems'> {
  return {
    async listProjects() {
      return { projects: await listProjects(tc) };
    },
    async threadProject(input) {
      const thread = await tc.bb.sdk.threads.get({ threadId: input.threadId });
      await assertProjectExists(tc, thread.projectId);
      return { projectId: thread.projectId };
    },
    async status(input) {
      await assertProjectExists(tc, input.projectId);
      return { sources: await statuses(tc, input.projectId) };
    },
    async listItems(input) {
      if (input.projectId) {
        await assertProjectExists(tc, input.projectId);
        await waitForMutations(tc, input.projectId, SOURCES);
        if (input.source) {
          await assertSelectedSourceAfterMutations(
            tc,
            input.projectId,
            input.source
          );
        }
        return {
          items: tc.store.list(input),
          provider: projectConfig(tc, input.projectId, true).source
        };
      }
      const projects = await listProjects(tc);
      return {
        items: tc.store.list({
          ...input,
          projectIds: projects.map(project => project.id)
        }),
        provider: null
      };
    }
  };
}

function createItemHandlers(
  tc: TaskboardContext
): Pick<
  Handlers,
  'refresh' | 'getItem' | 'statusOptions' | 'updateItemStatus'
> {
  return {
    async refresh(input) {
      await assertProjectExists(tc, input.projectId);
      const nextStatuses = await syncAll(
        tc,
        input.projectId,
        input.source,
        true
      );
      return {
        sources: nextStatuses,
        itemCount: refreshedItemCount(nextStatuses, input.source)
      };
    },
    async getItem(input) {
      await assertProjectExists(tc, input.projectId);
      return {
        item: await getLiveItem(
          tc,
          input.projectId,
          input.source,
          input.locator
        )
      };
    },
    async statusOptions(input) {
      await assertProjectExists(tc, input.projectId);
      return {
        options: await liveStatusOptions(
          tc,
          input.projectId,
          input.source,
          input.locator
        )
      };
    },
    async updateItemStatus(input) {
      await assertProjectExists(tc, input.projectId);
      return {
        item: await updateItemStatus(
          tc,
          input.projectId,
          input.source,
          input.locator,
          input.statusId
        )
      };
    }
  };
}

function createIssueHandlers(
  tc: TaskboardContext
): Pick<
  Handlers,
  'getCreateIssueContext' | 'getCreateIssueMetadata' | 'createIssue'
> {
  return {
    async getCreateIssueContext(input) {
      await assertProjectExists(tc, input.projectId);
      return { context: await getCreateIssueContext(tc, input.projectId) };
    },
    async getCreateIssueMetadata(input) {
      await assertProjectExists(tc, input.projectId);
      return getCreateIssueMetadata(tc, input);
    },
    async createIssue(input) {
      await assertProjectExists(tc, input.projectId);
      const { item, warnings, assigneeConfirmation } = await createWorkItem(
        tc,
        input
      );
      return {
        item,
        warnings,
        assigneeConfirmation,
        mention: {
          provider: 'external-work-item',
          id: mentionId(item),
          label: item.key
        }
      };
    }
  };
}

function createSettingsHandlers(
  tc: TaskboardContext
): Pick<
  Handlers,
  | 'getProjectConfig'
  | 'saveProjectConfig'
  | 'getProjectBoardSettings'
  | 'saveProjectBoardSettings'
  | 'listFilterPresets'
  | 'saveFilterPreset'
  | 'deleteFilterPreset'
  | 'reorderFilterPresets'
> {
  return {
    async getProjectConfig(input) {
      await assertProjectExists(tc, input.projectId);
      return { config: await readProjectConfigView(tc, input.projectId) };
    },
    async saveProjectConfig(input) {
      return { config: await persistProjectConfig(tc, input) };
    },
    async getProjectBoardSettings(input) {
      await assertProjectExists(tc, input.projectId);
      return { settings: tc.store.projectBoardSettings(input.projectId) };
    },
    async saveProjectBoardSettings(input) {
      await assertProjectExists(tc, input.projectId);
      const settings = tc.store.saveProjectBoardSettings(input);
      tc.bb.realtime.publish('taskboard:changed', {
        projectId: settings.projectId,
        source: null
      });
      return { settings };
    },
    async listFilterPresets(input) {
      await assertProjectExists(tc, input.projectId);
      return { presets: tc.store.listFilterPresets(input.projectId) };
    },
    async saveFilterPreset(input) {
      await assertProjectExists(tc, input.projectId);
      const result = await saveFilterPresetLinearized(tc, {
        projectId: input.projectId,
        ...(input.id ? { id: input.id } : {}),
        name: input.name,
        state: input.state
      });
      return {
        preset: filterPresetSummary(result.preset),
        presets: result.presets
      };
    },
    async deleteFilterPreset(input) {
      await assertProjectExists(tc, input.projectId);
      const presets = tc.store.deleteFilterPreset(input.projectId, input.id);
      publishFilterPresetsChanged(tc, input.projectId);
      return { presets };
    },
    async reorderFilterPresets(input) {
      await assertProjectExists(tc, input.projectId);
      const presets = tc.store.reorderFilterPresets(
        input.projectId,
        input.ids
      );
      publishFilterPresetsChanged(tc, input.projectId);
      return { presets };
    }
  };
}

export function registerRpc(tc: TaskboardContext): void {
  const handlers: Handlers = {
    ...createProjectHandlers(tc),
    ...createItemHandlers(tc),
    ...createIssueHandlers(tc),
    ...createSettingsHandlers(tc)
  };
  tc.bb.rpc.register(taskboardRpcContract, handlers);
}
