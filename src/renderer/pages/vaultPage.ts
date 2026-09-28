import { registerPage } from './nav.js';
import { renderIcon } from '../components/icon.js';
import type { VaultKeyView } from '../../shared/types';
let keys: VaultKeyView[] = [];
export async function refreshVaultKeys(): Promise<void> {
  keys = await window.vaultApi.list();
  for (const select of Array.from(document.querySelectorAll<HTMLSelectElement>('[data-vault-select]'))) {
    const selected = select.dataset.selected ?? select.value;
    select.replaceChildren(new Option('Select a private key…', ''));
    for (const key of keys) select.add(new Option(key.name, key.id));
    if (selected && !keys.some(key => key.id === selected)) select.add(new Option('Unavailable key', selected));
    select.value = selected; delete select.dataset.selected;
  }
  const list = document.getElementById('vault-key-list');
  if (list) {
    list.replaceChildren();
    if (!keys.length) list.textContent = 'No private keys yet. Add a key to use it with Hosts and Notes Server.';
    for (const key of keys) {
      const row = document.createElement('div'); row.className = 'vault-key-row';
      const name = document.createElement('strong'); name.textContent = key.name;
      const detail = document.createElement('span'); detail.textContent = `Private key · Added ${new Date(key.createdAt).toLocaleDateString()}`;
      row.append(name, detail); list.append(row);
    }
  }
}
export function openAddPrivateKey(onAdded?: (key: VaultKeyView) => void): void {
  let importedKey = false;
  const dialog = document.createElement('dialog'); dialog.className = 'vault-key-dialog';
  dialog.innerHTML = `<form><h2>Add Private Key</h2><label class="field">Name<input class="input" name="name" required maxlength="200" autocomplete="off"></label><label class="field">Private key<textarea class="input" name="privateKey" rows="7" spellcheck="false" placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"></textarea></label><label class="field">Passphrase (Optional)<input class="input" name="passphrase" type="password" autocomplete="new-password"></label><p role="status"></p><div class="notes-server-actions"><button type="button" class="btn btn-secondary" data-import>Import</button><button type="button" class="btn btn-secondary" data-cancel>Cancel</button><button type="submit" class="btn btn-primary">Add Private Key</button></div></form>`;
  document.body.append(dialog);
  const status = dialog.querySelector('p')!;
  dialog.addEventListener('close', () => dialog.remove());
  dialog.querySelector('[data-cancel]')!.addEventListener('click', () => dialog.close());
  dialog.querySelector('[data-import]')!.addEventListener('click', () => {
    void window.vaultApi.importPrivateKey().then(imported => { if (imported) { importedKey = true; (dialog.querySelector('[name="privateKey"]') as HTMLTextAreaElement).value = ''; status.textContent = 'Private key selected.'; } }).catch(() => { status.textContent = 'Private key could not be imported.'; });
  });
  dialog.querySelector('form')!.addEventListener('submit', event => {
    event.preventDefault();
    const value = (name: string) => (dialog.querySelector(`[name="${name}"]`) as HTMLInputElement).value;
    const controls = Array.from(dialog.querySelectorAll<HTMLButtonElement>('button')); controls.forEach(button => button.disabled = true);
    void window.vaultApi.add({ name: value('name'), useImportedKey: importedKey, privateKey: value('privateKey'), passphrase: value('passphrase') || undefined }).then(async key => {
      await refreshVaultKeys(); onAdded?.(key); dialog.close();
    }).catch(error => { status.textContent = String(error).replace(/^.*Error invoking remote method '[^']+': (?:Error: )?/, ''); }).finally(() => controls.forEach(button => button.disabled = false));
  });
  dialog.showModal();
}
export function registerVaultPage(): void {
  registerPage({ id: 'vault', title: 'Vault', icon: renderIcon('key-round'), onShow: () => { void refreshVaultKeys(); } });
  document.getElementById('vault-add-key')!.addEventListener('click', () => openAddPrivateKey());
  window.addEventListener('focus', () => { void refreshVaultKeys().catch(() => {}); });
  void refreshVaultKeys().catch(() => {});
}
