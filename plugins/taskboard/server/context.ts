import type { BbPluginApi } from '@get-bb/plugin-sdk';
import { createProjectCredentialVault } from '../credentials.js';
import { createWorkItemStore } from '../store.js';

export interface ActiveSync {
  revision: number;
  forceRefresh: boolean;
  promise: Promise<void>;
}

export interface ConfigMutationState {
  active: number;
  migrationBarrier: Promise<void> | null;
  releaseMigrationBarrier: (() => void) | null;
  idleWaiters: Set<() => void>;
}

export interface TaskboardContext {
  bb: BbPluginApi;
  store: ReturnType<typeof createWorkItemStore>;
  credentials: ReturnType<typeof createProjectCredentialVault>;
  sourceRevisions: Map<string, number>;
  connectorRevisions: Map<string, number>;
  mutationTails: Map<string, Promise<void>>;
  activeSyncs: Map<string, ActiveSync>;
  configMutations: ConfigMutationState;
}

export function createTaskboardContext(bb: BbPluginApi): TaskboardContext {
  return {
    bb,
    store: createWorkItemStore(bb),
    credentials: createProjectCredentialVault(bb),
    sourceRevisions: new Map(),
    connectorRevisions: new Map(),
    mutationTails: new Map(),
    activeSyncs: new Map(),
    configMutations: {
      active: 0,
      migrationBarrier: null,
      releaseMigrationBarrier: null,
      idleWaiters: new Set()
    }
  };
}
