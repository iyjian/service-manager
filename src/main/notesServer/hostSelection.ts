import type { ServiceStore } from '../ssh/store';
import type { PrivateKeyVault } from '../vault/privateKeyVault';
import { validateHostDraft } from '../ssh/validation';
import type { HostConfig, NotesServerHostOption, NotesServerSettingsDraft } from '../../shared/types';
export function notesServerHostOptions(hosts: HostConfig[]): NotesServerHostOption[] {
  return hosts.map(host => ({ id: host.id, name: host.name, sshHost: host.sshHost, sshPort: host.sshPort, username: host.username,
    unavailableReason: host.jumpHosts.length ? 'Notes Server requires a direct SSH connection; jump hosts are not supported.' : undefined }));
}
export function notesServerDraftFromHost(hosts: HostConfig[], id: unknown): NotesServerSettingsDraft {
  if (typeof id !== 'string' || !id) throw new Error('Select a Host first.');
  const host = hosts.find(host => host.id === id);
  if (!host) throw new Error('The selected Host no longer exists. Refresh and select another Host.');
  if (host.jumpHosts.length) throw new Error('Notes Server requires a direct SSH connection; jump hosts are not supported.');
  return { sourceHostId: host.id, name: host.name, sshHost: host.sshHost, sshPort: host.sshPort, username: host.username,
    authType: host.authType, password: host.password, privateKeyId: host.privateKeyId, privateKey: host.privateKey, passphrase: host.passphrase };
}

export async function createNotesServerHost(store: ServiceStore, vault: PrivateKeyVault, draft: NotesServerSettingsDraft): Promise<HostConfig> {
  const host = validateHostDraft({ ...vault.resolve(draft), jumpHosts: [], forwards: [], services: [] });
  const existing = store.listHosts().find(candidate => candidate.name === host.name && candidate.sshHost === host.sshHost && candidate.sshPort === host.sshPort && candidate.username === host.username && candidate.authType === host.authType && candidate.privateKey === host.privateKey && candidate.password === host.password && candidate.passphrase === host.passphrase && candidate.jumpHosts.length === 0);
  if (existing) return existing;
  await store.upsertHost(host);
  return store.findHostById(host.id)!;
}
