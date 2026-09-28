import { registerPage } from './nav.js';
import { createIcon, renderIcon } from '../components/icon.js';
import type { VaultKeyView } from '../../shared/types';
let keys: VaultKeyView[] = [];
let watching = false;
const errorText = (error: unknown): string => String(error).replace(/^.*Error invoking remote method '[^']+': (?:Error: )?/, '');
function report(message: string): void {
  const status = document.getElementById('vault-status');
  if (status) status.textContent = message;
}
function watch(): void {
  if (watching) return;
  watching = true;
  window.vaultApi.onChanged(() => { void refreshVaultKeys().catch(error => report(errorText(error))); });
}
export async function refreshVaultKeys(): Promise<void> {
  watch();
  keys = await window.vaultApi.list();
  for (const select of Array.from(document.querySelectorAll<HTMLSelectElement>('[data-vault-select]'))) {
    const selected = select.dataset.selected ?? select.value;
    select.replaceChildren(new Option('Select a private key…', ''));
    for (const key of keys) select.add(new Option(key.name, key.id));
    if (selected && !keys.some(key => key.id === selected)) select.add(new Option('Unavailable key', selected));
    select.value = selected; delete select.dataset.selected;
  }
  renderKeys();
}
function renderKeys(): void {
  const list = document.getElementById('vault-key-list'); if (!list) return;
  const query = (document.querySelector<HTMLInputElement>('#vault-search')?.value ?? '').trim().toLocaleLowerCase();
  const visible = keys.filter(key => key.name.toLocaleLowerCase().includes(query));
  document.getElementById('vault-key-count')!.textContent = `${keys.length} ${keys.length === 1 ? 'key' : 'keys'}`;
  list.replaceChildren();
  if (!visible.length) {
    const empty = document.createElement('div'); empty.className = 'vault-empty';
    empty.append(createIcon(query ? 'search' : 'key-round', { size: 28 }));
    const title = document.createElement('strong'); title.textContent = query ? 'No matching keys' : 'Your keys, in one place';
    const detail = document.createElement('p'); detail.textContent = query ? 'Try a different name.' : 'Add a private key to reuse it with Hosts and Notes Server.';
    empty.append(title, detail); list.append(empty); return;
  }
  for (const key of visible) {
    const row = document.createElement('div'); row.className = 'vault-key-row'; row.setAttribute('role', 'listitem');
    const identity = document.createElement('div'); identity.className = 'vault-key-identity';
    const icon = document.createElement('span'); icon.className = 'vault-key-icon'; icon.append(createIcon('key-round', { size: 19 }));
    const copy = document.createElement('div'); copy.className = 'vault-key-copy';
    const name = document.createElement('strong'); name.textContent = key.name; name.title = key.name;
    const meta = document.createElement('span'); meta.textContent = 'SSH private key'; copy.append(name, meta); identity.append(icon, copy);
    const date = document.createElement('div'); date.className = 'vault-key-date';
    const label = document.createElement('span'); label.textContent = key.updatedAt ? 'Updated' : 'Added';
    const time = document.createElement('time'); time.dateTime = key.updatedAt ?? key.createdAt; time.textContent = new Date(time.dateTime).toLocaleDateString(); time.title = new Date(time.dateTime).toLocaleString(); date.append(label, time);
    const actions = document.createElement('div'); actions.className = 'vault-row-actions';
    for (const [mode, text, symbol] of [['rename', 'Rename', 'pencil'], ['replace', 'Replace key', 'rotate-ccw']] as const) {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'btn btn-ghost btn-sm';
      button.append(createIcon(symbol), document.createTextNode(text)); button.setAttribute('aria-label', `${text}: ${key.name}`);
      button.addEventListener('click', () => openKeyDialog(mode, key)); actions.append(button);
    }
    row.append(identity, date, actions); list.append(row);
  }
}
export function openAddPrivateKey(onAdded?: (key: VaultKeyView) => void): void { openKeyDialog('add', undefined, onAdded); }
function openKeyDialog(mode: 'add' | 'rename' | 'replace', key?: VaultKeyView, onAdded?: (key: VaultKeyView) => void): void {
  let importedKey = false, busy = false;
  const opener = document.activeElement as HTMLElement | null;
  const title = mode === 'add' ? 'Add Private Key' : mode === 'rename' ? 'Rename Private Key' : 'Replace Private Key';
  const dialog = document.createElement('dialog'); dialog.className = 'vault-key-dialog'; dialog.setAttribute('aria-label', title);
  const rename = mode === 'rename';
  dialog.innerHTML = `<form><header class="vault-dialog-header"><span class="vault-key-icon">${renderIcon(rename ? 'pencil' : 'key-round', { size: 22 })}</span><div><h2>${title}</h2><p data-dialog-description></p></div><button type="button" class="vault-close btn btn-ghost" data-close aria-label="Close">${renderIcon('x')}</button></header>
    <div class="vault-dialog-body">
    <label class="field" ${mode === 'replace' ? 'hidden' : ''}>Name<input class="input" name="name" ${mode !== 'replace' ? 'required' : ''} maxlength="200" autocomplete="off" placeholder="e.g. Production SSH key"></label>
    ${!rename ? `<div class="vault-material"><div class="vault-material-head"><label for="vault-key-material">${mode === 'replace' ? 'New private key' : 'Private key'}</label><button type="button" class="btn btn-secondary btn-sm" data-import>${renderIcon('upload')}Import from file</button></div><textarea id="vault-key-material" class="input" name="privateKey" rows="7" spellcheck="false" autocomplete="off" placeholder="Paste your private key here"></textarea><p class="vault-field-help" data-import-status>Import opens your default SSH key directory.</p></div><label class="field">Passphrase <span class="vault-optional">Optional</span><input class="input" name="passphrase" type="password" autocomplete="new-password" placeholder="Passphrase for this key"></label>` : ''}
    ${mode === 'replace' ? `<div class="vault-replace-note">${renderIcon('circle-alert')}<span>Hosts and Notes Server using this key will use the replacement for new connections. Existing sessions stay open. This does not install the public key on your servers.</span></div>` : ''}
    <p role="status" class="vault-dialog-status" hidden></p></div><footer class="vault-dialog-footer"><button type="button" class="btn btn-secondary" data-cancel>Cancel</button><button type="submit" class="btn btn-primary">${renderIcon(mode === 'add' ? 'plus' : 'check')}${mode === 'add' ? 'Add Private Key' : mode === 'rename' ? 'Save Name' : 'Replace Key'}</button></footer></form>`;
  document.body.append(dialog);
  const value = (name: string) => (dialog.querySelector(`[name="${name}"]`) as HTMLInputElement | null)?.value ?? '';
  (dialog.querySelector('[name="name"]') as HTMLInputElement).value = key?.name ?? '';
  dialog.querySelector('[data-dialog-description]')!.textContent = mode === 'add' ? 'One key, shared across your connections.' : mode === 'rename' ? 'Change the label. Connected Hosts and Notes keep their reference.' : key!.name;
  const status = dialog.querySelector<HTMLElement>('[role="status"]')!;
  const showError = (error: unknown) => { status.hidden = false; status.textContent = errorText(error); };
  const setBusy = (next: boolean) => { busy = next; for (const element of Array.from(dialog.querySelectorAll<HTMLInputElement | HTMLButtonElement>('input, textarea, button'))) element.disabled = next; };
  dialog.addEventListener('cancel', event => { if (busy) event.preventDefault(); });
  dialog.addEventListener('close', () => { dialog.remove(); if (opener?.isConnected) opener.focus(); else document.getElementById('vault-search')?.focus(); });
  for (const button of Array.from(dialog.querySelectorAll('[data-cancel], [data-close]'))) button.addEventListener('click', () => { if (!busy) dialog.close(); });
  dialog.querySelector('[data-import]')?.addEventListener('click', () => {
    setBusy(true); status.hidden = true;
    void window.vaultApi.importPrivateKey().then(imported => {
      if (imported) { importedKey = true; (dialog.querySelector('[name="privateKey"]') as HTMLTextAreaElement).value = ''; dialog.querySelector('[data-import-status]')!.textContent = 'Private key selected. Its contents stay protected.'; }
    }).catch(showError).finally(() => setBusy(false));
  });
  dialog.querySelector('form')!.addEventListener('submit', event => {
    event.preventDefault(); if (busy) return; status.hidden = true; setBusy(true);
    const draft = { name: value('name'), useImportedKey: importedKey, privateKey: value('privateKey'), passphrase: value('passphrase') || undefined };
    const request = rename ? window.vaultApi.rename(key!.id, draft.name, key!.revision ?? 0)
      : mode === 'replace' ? window.vaultApi.replace({ ...draft, id: key!.id, revision: key!.revision ?? 0 }) : window.vaultApi.add(draft);
    void request.then(async saved => {
      await refreshVaultKeys(); onAdded?.(saved); dialog.close();
      report(mode === 'rename' ? 'Private key renamed.' : mode === 'replace' ? 'Private key replaced. Connection references preserved.' : 'Private key added.');
    }).catch(showError).finally(() => setBusy(false));
  });
  dialog.showModal();
  if (mode === 'replace') (dialog.querySelector('[name="privateKey"]') as HTMLTextAreaElement).focus();
  else (dialog.querySelector('[name="name"]') as HTMLInputElement).select();
}
export function registerVaultPage(): void {
  registerPage({ id: 'vault', title: 'Vault', icon: renderIcon('key-round'), onShow: () => { void refreshVaultKeys().catch(error => report(errorText(error))); } });
  document.getElementById('vault-add-key')!.addEventListener('click', () => openAddPrivateKey());
  document.getElementById('vault-search')!.addEventListener('input', renderKeys);
  window.addEventListener('focus', () => { void refreshVaultKeys().catch(error => report(errorText(error))); });
  void refreshVaultKeys().catch(error => report(errorText(error)));
}
