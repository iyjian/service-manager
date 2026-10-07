import type { NotesServerDeployment } from '../notesServer/deployment';
import type { VaultRemote } from './privateKeyVault';
import type { VaultRecord } from './entries';
/** APIs run only in the main process over the authenticated SSH channel. */
export function remoteVault(deployment: NotesServerDeployment): VaultRemote {
  let checked = false;
  return {
    enabled: () => deployment.settings.enabled && Boolean(deployment.settings.instanceId),
    async read() {
      if (!checked) {
        const health = await deployment.health(3);
        if (health.instanceId !== deployment.settings.instanceId) throw new Error('Vault database identity changed.');
        checked = true;
      }
      const snapshot = await deployment.api<{ instanceId: string; revision: number; records: VaultRecord[] }>('/v1/vault');
      if (snapshot.instanceId !== deployment.settings.instanceId) throw new Error('Vault database identity changed.');
      return snapshot;
    },
    async import(records, instanceId) { await deployment.api('/v1/vault/import', { records, instanceId }); },
    async write(records, expectedRevision, instanceId) { await deployment.api('/v1/vault/write', { records, expectedRevision, instanceId }); },
  };
}
