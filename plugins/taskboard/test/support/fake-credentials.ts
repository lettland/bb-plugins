import type { SecretMutation } from '../../contract.ts';

export type CredentialSource = 'linear' | 'jira';

export const secrets = new Map<string, string>();
export const events: string[] = [];
export const faults = {
  credentials: new Map<string, number[]>(),
  configSaves: new Set<number>()
};

export function secretKey(projectId: string, source: CredentialSource): string {
  return `${projectId}:${source}`;
}

export function resetFakes(): void {
  secrets.clear();
  events.length = 0;
  faults.credentials.clear();
  faults.configSaves.clear();
}

export function createProjectCredentialVault() {
  return {
    credentialPath: (projectId: string, source: CredentialSource) =>
      secretKey(projectId, source),
    legacyCredentialPath: (source: CredentialSource) => `legacy:${source}`,
    async read(projectId: string, source: CredentialSource) {
      return secrets.get(secretKey(projectId, source));
    },
    async configured(projectId: string, source: CredentialSource) {
      return secrets.has(secretKey(projectId, source));
    },
    async mutate(
      projectId: string,
      source: CredentialSource,
      mutation: SecretMutation
    ): Promise<void> {
      if (mutation.operation === 'keep') return;
      const call = `credential:${source}:${mutation.operation}`;
      events.push(call);
      const occurrence = events.filter(event => event === call).length;
      if (faults.credentials.get(call)?.includes(occurrence)) {
        throw new Error(`injected ${call} failure`);
      }
      if (mutation.operation === 'clear') {
        secrets.delete(secretKey(projectId, source));
        return;
      }
      secrets.set(secretKey(projectId, source), mutation.value.trim());
    },
    async migrateLegacy() {
      return { outcome: 'no-legacy-credential', projectId: null };
    }
  };
}
