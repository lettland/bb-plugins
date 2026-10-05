import { definePluginApp } from '@get-bb/plugin-sdk/app';
import {
  ComposerCreateIssueAction
} from './features/create-issue/create-issue-actions.js';
import {
  PANEL_PATH,
  THREAD_PANEL_ACTION_ID
} from './features/shared/constants.js';
import {
  TaskboardNewThreadPanel,
  TaskboardThreadHeaderAction,
  TaskboardThreadPanel
} from './features/panel/thread-panels.js';
import { TaskboardPanel } from './features/panel/taskboard-panel.js';
import { ManageHeaderAction } from './features/panel/header-action.js';
import { TaskboardSettingsInfo } from './features/manage/settings-info.js';
import {
  ProjectCredentialsInteraction
} from './features/manage/credentials-interaction.js';
import './app.css';

export default definePluginApp(app => {
  app.composer.customize({
    id: 'create-taskboard-issue',
    scopes: ['thread', 'new-thread'],
    actions: [
      { id: 'create-issue', component: ComposerCreateIssueAction }
    ]
  });
  app.slots.threadPanelAction({
    id: THREAD_PANEL_ACTION_ID,
    title: 'Taskboard',
    icon: 'Target',
    component: TaskboardThreadPanel,
    layout: 'flush'
  });
  app.slots.experimental_newThreadPanelAction({
    id: 'taskboard-new-thread-panel',
    title: 'Taskboard',
    icon: 'Target',
    component: TaskboardNewThreadPanel,
    layout: 'flush'
  });
  app.slots.experimental_threadHeaderAction({
    id: 'open-taskboard-panel',
    title: 'Taskboard',
    component: TaskboardThreadHeaderAction
  });
  app.slots.navPanel({
    id: 'taskboard',
    title: 'Taskboard',
    icon: 'Target',
    path: PANEL_PATH,
    component: TaskboardPanel,
    headerContent: ManageHeaderAction
  });
  app.slots.settingsSection({
    id: 'connections',
    title: 'Project settings',
    description: 'Configure each project’s tracker and board experience.',
    component: TaskboardSettingsInfo
  });
  app.slots.pendingInteraction({
    id: 'taskboard-credentials',
    component: ProjectCredentialsInteraction
  });
});
