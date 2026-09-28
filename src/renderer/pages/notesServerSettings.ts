import { refreshVaultKeys, openAddPrivateKey } from './vaultPage.js';
import type { NotesServerSettingsDraft } from '../../shared/types';
import { requireElement } from '../utils/dom.js';
import { toErrorMessage } from '../utils/error.js';
let initialized = false;
let hostOptions: import('../../shared/types').NotesServerHostOption[] = [];
let serverEnabled = false;
let working = false;
function updateHostSelection(): void {
  const section = requireElement<HTMLElement>('#notes-server-settings');
  const selected = section.querySelector<HTMLSelectElement>('[data-notes-host]')!.value;
  const manual = selected === '__new__' || selected === '__custom__';
  section.querySelector<HTMLElement>('.notes-server-fields')!.hidden = !manual;
  const host = hostOptions.find(host => host.id === selected);
  section.querySelector<HTMLElement>('[data-notes-host-detail]')!.textContent = manual
    ? selected === '__new__' ? 'This Host will also be added to Service Manager. Use a direct SSH connection.' : 'Saved direct connection. Select an existing Host to reuse its authentication.'
    : host ? `${host.username}@${host.sshHost}:${host.sshPort}${host.unavailableReason ? ` · ${host.unavailableReason}` : ' · Uses the saved Host authentication.'}` : 'Select a saved Host to reuse its SSH connection and authentication.';
  section.querySelector<HTMLSelectElement>('[data-notes-host]')!.disabled = working || serverEnabled;
}

const serverError = (error: unknown): string => toErrorMessage(error).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');
export async function refreshNotesServerSettings(): Promise<void> {
  const section = requireElement<HTMLElement>('#notes-server-settings');
  const [state, hosts] = await Promise.all([window.notesServerApi.getSettings(), window.notesServerApi.listHosts()]);
  hostOptions = hosts; serverEnabled = state.enabled;
  const hostSelect = section.querySelector<HTMLSelectElement>('[data-notes-host]')!;
  hostSelect.replaceChildren(new Option('Select an existing Host…', ''));
  for (const host of hosts) {
    const option = new Option(`${host.name} · ${host.username}@${host.sshHost}:${host.sshPort}${host.unavailableReason ? ' (requires jump host)' : ''}`, host.id);
    option.disabled = Boolean(host.unavailableReason); hostSelect.add(option);
  }
  hostSelect.add(new Option('Add New Host…', '__new__'));
  if (state.configured && !state.sourceHostId) hostSelect.add(new Option('Saved connection', '__custom__'));
  if (state.sourceHostId && !hosts.some(host => host.id === state.sourceHostId)) hostSelect.add(new Option('Previously selected Host (removed)', state.sourceHostId));
  hostSelect.value = state.sourceHostId ?? (state.configured ? '__custom__' : hosts.some(host => !host.unavailableReason) ? '' : '__new__');
  updateHostSelection();
  for (const key of ['name', 'sshHost', 'sshPort', 'username', 'authType'] as const) {
    const input = section.querySelector<HTMLInputElement | HTMLSelectElement>(`[name="${key}"]`)!; input.value = String(state[key]);
  }
  for (const key of ['password', 'privateKey', 'passphrase'] as const) {
    const input = section.querySelector<HTMLInputElement>(`[name="${key}"]`)!; input.value = '';
    const saved = key === 'password' ? state.hasPassword : key === 'privateKey' ? state.hasPrivateKey : state.hasPassphrase;
    input.placeholder = saved ? 'Saved · leave blank to keep' : '';
  }
  section.querySelector<HTMLElement>('[data-server-mode]')!.textContent = state.enabled ? 'Current storage: Notes Server' : 'Current storage: Local';
  const keySelect = section.querySelector<HTMLSelectElement>('[name="privateKeyId"]')!;
  keySelect.dataset.selected = state.privateKeyId ?? '';
  await refreshVaultKeys();
  updateAuth();
}
function updateAuth(): void {
  const section = requireElement<HTMLElement>('#notes-server-settings');
  const key = section.querySelector<HTMLSelectElement>('[name="authType"]')!.value === 'privateKey';
  for (const node of Array.from(section.querySelectorAll<HTMLElement>('[data-server-auth]'))) node.hidden = node.dataset.serverAuth !== (key ? 'privateKey' : 'password');
}
export function registerNotesServerSettings(): void {
  if (initialized) return; initialized = true;
  const section = requireElement<HTMLElement>('#notes-server-settings');
  const status = section.querySelector<HTMLElement>('[data-server-status]')!;
  section.querySelector('[data-notes-host]')!.addEventListener('change', () => {
    status.textContent = '';
    if (section.querySelector<HTMLSelectElement>('[data-notes-host]')!.value === '__new__') {
      for (const name of ['name', 'sshHost', 'username', 'password', 'privateKey', 'passphrase', 'privateKeyId']) section.querySelector<HTMLInputElement>(`[name="${name}"]`)!.value = '';
      for (const name of ['password', 'privateKey', 'passphrase']) section.querySelector<HTMLInputElement>(`[name="${name}"]`)!.placeholder = '';
      section.querySelector<HTMLInputElement>('[name="sshPort"]')!.value = '22';
    }
    updateHostSelection();
  });
  section.querySelector('[data-server-add-key]')!.addEventListener('click', () => openAddPrivateKey(key => { section.querySelector<HTMLSelectElement>('[name="privateKeyId"]')!.value = key.id; }));
  window.notesServerApi.onProgress(message => { status.textContent = message; });
  section.closest('dialog')?.addEventListener('close', () => {
    for (const key of ['password', 'privateKey', 'passphrase']) section.querySelector<HTMLInputElement>(`[name="${key}"]`)!.value = '';
  });
  section.querySelector('[data-server-import-key]')!.addEventListener('click', () => {
    void window.notesServerApi.importPrivateKey().then(imported => { if (imported) status.textContent = 'Private key selected. Save Server to apply.'; }).catch(error => { status.textContent = serverError(error); });
  });
  section.querySelector('[name="authType"]')!.addEventListener('change', updateAuth);
  section.querySelector('[data-server-cancel]')!.addEventListener('click', () => { void window.notesServerApi.cancel(); });
  for (const button of Array.from(section.querySelectorAll<HTMLButtonElement>('[data-server-action]'))) {
    button.addEventListener('click', () => { void (async () => {
      const action = button.dataset.serverAction!;
      const controls = Array.from(section.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLSelectElement | HTMLTextAreaElement>('input,select,textarea,button[data-server-action]'));
      working = true;
      controls.forEach(node => { node.disabled = true; }); status.textContent = 'Working…';
      try {
        if (action === 'save' || action === 'setup' || action === 'test') {
          const value = (name: string) => section.querySelector<HTMLInputElement>(`[name="${name}"]`)!.value;
          const input: NotesServerSettingsDraft = { name: value('name'), sshHost: value('sshHost'), sshPort: Number(value('sshPort')), username: value('username'),
            privateKeyId: value('privateKeyId') || undefined, authType: value('authType') as 'password' | 'privateKey', password: value('password'), privateKey: value('privateKey'), passphrase: value('passphrase') };
          const selection = section.querySelector<HTMLSelectElement>('[data-notes-host]')!.value;
          if (!selection) throw new Error('Select an existing Host or choose Add New Host.');
          if (!(action === 'setup' && (await window.notesServerApi.getSettings()).enabled)) {
            if (selection === '__new__' || selection === '__custom__') await window.notesServerApi.saveSettings({ ...input, createHost: selection === '__new__' });
            else await window.notesServerApi.saveFromHost(selection);
          }
          await refreshNotesServerSettings();
          status.textContent = 'Server configuration saved locally.';
          if (action === 'test') status.textContent = await window.notesServerApi.action('test');
          if (action === 'setup') {
            status.textContent = 'Deploying and starting Notes Server… This can take several minutes.';
            await window.notesServerApi.action('deploy');
            await window.notesServerApi.action('migrate');
            window.location.reload();
          }
        } else {
          status.textContent = await window.notesServerApi.action(action as Parameters<typeof window.notesServerApi.action>[0]);
        }
        await refreshNotesServerSettings();
      } catch (error) { status.textContent = serverError(error); }
      finally { working = false; controls.forEach(node => { node.disabled = false; }); updateHostSelection(); }
    })(); });
  }
}
