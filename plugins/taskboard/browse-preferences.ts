import { createBrowsePreferenceStore } from './browse-preferences/store.ts';
import {
  browserStorageSubscription,
  defaultBrowserStorage
} from './browse-preferences/storage.ts';

export {
  ACROSS_PROJECTS_SCOPE,
  BROWSE_PREFERENCES_VERSION,
  CREATE_ASSIGNEE_DEFAULT_VERSION,
  MAX_BROWSE_QUERY_LENGTH,
  browsePreferencesV1Schema,
  type BrowsePreferenceScope,
  type BrowsePreferenceSeed,
  type BrowsePreferenceStore,
  type BrowsePreferenceStoreOptions,
  type BrowsePreferences,
  type PreferenceStorage,
  type ProjectBrowseScope,
  type SourceFilter
} from './browse-preferences/schemas.ts';
export {
  browsePreferenceStorageKey,
  clearBrowseFilters,
  defaultBrowsePreferences,
  parseBrowsePreferences,
  parseBrowsePreferencesJson,
  projectBrowseScope,
  reconcileBrowseProvider
} from './browse-preferences/preferences.ts';
export {
  isGroupCollapsed,
  isTerminalStateCategory,
  setGroupCollapsedOverride,
  toggleGroupCollapsedOverride
} from './browse-preferences/groups.ts';
export {
  createAssigneeDefaultV1Schema,
  createAssigneeScope,
  createAssigneeScopeSchema,
  createAssigneeStorageKey,
  readRememberedCreateAssignee,
  rememberCreateAssignee,
  rememberCreateAssigneeAfterSuccess,
  restoreRememberedCreateAssignee,
  validateRememberedCreateAssignee,
  type CreateAssigneeDefault,
  type CreateAssigneeScope
} from './browse-preferences/create-assignee.ts';
export { createBrowsePreferenceStore } from './browse-preferences/store.ts';

export const browsePreferenceStore = createBrowsePreferenceStore({
  storage: defaultBrowserStorage,
  subscribeToStorage: browserStorageSubscription
});
