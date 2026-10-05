import { SYNC_INTERVAL_MS } from './constants.js';
import type { TaskboardContext } from './context.js';
import { migrateLegacyCredentials } from './migration.js';
import { listProjects } from './projects.js';
import { syncAll } from './sync.js';
import { errorMessage, sleep } from './util.js';

async function configuredLiveProjectIds(
  tc: TaskboardContext
): Promise<string[]> {
  const liveProjectIds = new Set(
    (await listProjects(tc)).map(project => project.id)
  );
  return tc.store
    .configuredProjectIds()
    .filter(projectId => liveProjectIds.has(projectId));
}

export function registerBackgroundSync(tc: TaskboardContext): void {
  tc.bb.background.service('sync', {
    async start(signal) {
      let legacyMigrationFinished = false;
      while (!signal.aborted) {
        if (!legacyMigrationFinished) {
          try {
            await migrateLegacyCredentials(tc);
            legacyMigrationFinished = true;
          } catch (error) {
            tc.bb.log.warn(
              `Legacy credential migration deferred: ${errorMessage(error)}`
            );
          }
        }
        try {
          const projectIds = await configuredLiveProjectIds(tc);
          await Promise.all(
            projectIds.map(projectId =>
              syncAll(tc, projectId, undefined, false)
            )
          );
        } catch (error) {
          tc.bb.log.warn(`Background sync failed: ${errorMessage(error)}`);
        }
        await sleep(SYNC_INTERVAL_MS, signal);
      }
    }
  });
}
