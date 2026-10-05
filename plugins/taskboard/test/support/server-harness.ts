import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';
import type { BbPluginApi } from '@get-bb/plugin-sdk';
import Database from 'better-sqlite3';
import type { taskboardRpcContract } from '../../contract.ts';
import { events, faults, resetFakes, secrets } from './fake-credentials.ts';

const FAKE_CREDENTIALS_URL = new URL('./fake-credentials.ts', import.meta.url);

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === './credentials.js' && context.parentURL?.endsWith('/server.ts')) {
      return { shortCircuit: true, url: FAKE_CREDENTIALS_URL.href };
    }
    if (specifier.startsWith('.') && specifier.endsWith('.js')) {
      const sourceUrl = new URL(
        `${specifier.slice(0, -'.js'.length)}.ts`,
        context.parentURL
      );
      if (existsSync(fileURLToPath(sourceUrl))) {
        return { shortCircuit: true, url: sourceUrl.href };
      }
    }
    return nextResolve(specifier, context);
  }
});

const { default: plugin } = await import('../../server.ts');

export { events, faults, secrets };
export const PROJECT_ID = 'proj_alpha';
export const JIRA_URL = 'https://example.atlassian.net';

type Handlers = {
  [Method in keyof typeof taskboardRpcContract]: (
    input: never
  ) => Promise<unknown>;
};

export interface Published {
  channel: string;
  payload: unknown;
}

export interface Harness {
  db: Database.Database;
  handlers: Handlers;
  published: Published[];
  warnings: string[];
  cli: { register: unknown[]; run: (argv: string[]) => Promise<unknown> };
  seedJiraProject: (token?: string) => void;
}

function instrument(db: Database.Database): void {
  const prepare = db.prepare.bind(db) as (sql: string) => unknown;
  let configSaves = 0;
  (db as unknown as { prepare: (sql: string) => unknown }).prepare = sql => {
    if (/INSERT INTO project_source_config[\s\S]*DO UPDATE/u.test(sql)) {
      configSaves += 1;
      events.push('store:saveProjectConfig');
      if (faults.configSaves.has(configSaves)) {
        throw new Error(`injected config save ${configSaves} failure`);
      }
    }
    return prepare(sql);
  };
}

export async function bootPlugin(
  projects = [{ id: PROJECT_ID, name: 'Alpha' }]
): Promise<Harness> {
  resetFakes();
  const db = new Database(':memory:');
  instrument(db);
  const published: Published[] = [];
  const warnings: string[] = [];
  const registered: { handlers?: Handlers; cli?: { run: Function } } = {};
  const cliRegistrations: unknown[] = [];
  const bb = {
    storage: {
      database: () => db,
      migrate(database: Database.Database, migrations: readonly string[]) {
        for (const migration of migrations) database.exec(migration);
      }
    },
    realtime: {
      publish: (channel: string, payload: unknown) =>
        published.push({ channel, payload })
    },
    log: { info() {}, warn: (message: string) => warnings.push(message) },
    rpc: {
      register: (_contract: unknown, handlers: Handlers) => {
        registered.handlers = handlers;
      }
    },
    cli: {
      register: (definition: { run: Function }) => {
        registered.cli = definition;
        cliRegistrations.push(definition);
      }
    },
    background: { service() {} },
    ui: { registerMentionProvider() {} },
    sdk: {
      projects: { list: async () => projects },
      plugins: {
        callRpc: async () => {
          throw new Error('github plugin unavailable');
        }
      },
      threads: { get: async () => ({ projectId: PROJECT_ID }) }
    }
  } as unknown as BbPluginApi;
  await plugin(bb);
  return {
    db,
    handlers: registered.handlers!,
    published,
    warnings,
    cli: {
      register: cliRegistrations,
      run: argv =>
        registered.cli!.run(argv, { projectId: PROJECT_ID, signal: undefined })
    },
    seedJiraProject(token = 'old-token') {
      db.prepare(
        `INSERT INTO project_source_config (
          bb_project_id, source, linear_team_key, jira_base_url, jira_email,
          jira_jql, updated_at
        ) VALUES (?, 'jira', '', ?, 'me@example.com', 'project = ENG', ?)`
      ).run(PROJECT_ID, JIRA_URL, new Date().toISOString());
      if (token) secrets.set(`${PROJECT_ID}:jira`, token);
    }
  };
}
