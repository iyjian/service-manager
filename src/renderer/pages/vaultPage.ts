import { registerPage } from './nav.js';
import { createIcon, renderIcon } from '../components/icon.js';
import type { VaultAccountView, VaultEntryView, VaultEntryDraft, VaultKeyView } from '../../shared/types';
let keys: VaultKeyView[] = [];
let watching = false;
let entries: VaultEntryView[] = [];
let selectedId = '';
let category = 'all';
let clearDetailSecrets = () => {};
window.addEventListener('blur', () => clearDetailSecrets());
document.addEventListener('visibilitychange', () => { if (document.hidden) clearDetailSecrets(); });
const errorText = (error: unknown): string => String(error).replace(/^.*Error invoking remote method '[^']+': (?:Error: )?/, '');
function report(message: string): void {
  const status = document.getElementById('vault-status'); if (status) status.textContent = message;
}
function watch(): void {
  if (watching) return; watching = true;
  window.vaultApi.onChanged(() => { void refreshVaultKeys().catch(error => report(errorText(error))); });
}
export async function refreshVaultKeys(): Promise<void> {
  watch(); keys = await window.vaultApi.list();
  for (const select of Array.from(document.querySelectorAll<HTMLSelectElement>('[data-vault-select]'))) {
    const selected = select.dataset.selected ?? select.value;
    select.replaceChildren(new Option('Select a private key…', ''));
    for (const key of keys) select.add(new Option(key.name, key.id));
    if (selected && !keys.some(key => key.id === selected)) select.add(new Option('Unavailable key', selected));
    select.value = selected; delete select.dataset.selected;
  }
  entries = await window.vaultApi.entries(); renderKeys(); report((await window.vaultApi.status()).message);
}
function action(label: string, run: () => void | Promise<unknown>): HTMLButtonElement {
  const button = document.createElement('button'); button.type = 'button'; button.className = 'btn btn-secondary btn-sm'; button.textContent = label;
  button.addEventListener('click', () => { void Promise.resolve().then(run).catch(error => report(errorText(error))); }); return button;
}
function renderKeys(selectFirst = false): void {
  const list = document.getElementById('vault-key-list'); if (!list) return;
  const query = (document.querySelector<HTMLInputElement>('#vault-search')?.value ?? '').trim().toLocaleLowerCase();
  const visible = entries.filter(item => (category === 'all' || item.type === category) && [item.type === 'sshKey' ? item.name : item.loginUrl, ...item.accounts.map(account => account.username)].join(' ').toLocaleLowerCase().includes(query));
  document.getElementById('vault-key-count')!.textContent = `${entries.length} ${entries.length === 1 ? 'item' : 'items'}`;
  for (const button of Array.from(document.querySelectorAll<HTMLButtonElement>('#vault-groups [data-type]'))) {
    const type = button.dataset.type!; const active = type === category;
    button.classList.toggle('selected', active); button.setAttribute('aria-pressed', String(active));
    button.querySelector('[data-count]')!.textContent = String(type === 'all' ? entries.length : entries.filter(item => item.type === type).length);
  }
  if (selectFirst || !visible.some(item => item.id === selectedId)) selectedId = visible[0]?.id ?? '';
  const scrollTop = selectFirst ? 0 : list.scrollTop;
  list.replaceChildren();
  for (const item of visible) {
    const row = document.createElement('button'); row.type = 'button'; row.className = 'vault-entry-row'; row.classList.toggle('selected', item.id === selectedId); row.setAttribute('aria-pressed', String(item.id === selectedId));
    const title = document.createElement('strong'); title.textContent = item.type === 'login' ? item.loginUrl || 'Website URL needed' : item.name; title.title = title.textContent;
    const meta = document.createElement('span'); meta.textContent = item.type === 'login' ? `${item.accounts.length} ${item.accounts.length === 1 ? 'account' : 'accounts'}${item.accounts.length === 1 && item.accounts[0].username ? ` · ${item.accounts[0].username}` : ''}` : 'SSH Key';
    row.append(title, meta); row.addEventListener('click', () => { selectedId = item.id; renderKeys(); });
    const wrapper = document.createElement('div'); wrapper.className = 'vault-entry-item'; wrapper.append(row);
    if (item.type === 'login') {
      const remove = action('Delete', async () => {
        remove.disabled = true;
        try { if (await window.vaultApi.deleteLogin(item.id, item.revision ?? 0)) { await refreshVaultKeys(); report('Login deleted'); } }
        finally { remove.disabled = false; }
      });
      remove.className = 'vault-entry-delete'; remove.title = 'Delete Login'; remove.setAttribute('aria-label', `Delete Login ${item.loginUrl || 'Website URL needed'}`);
      remove.replaceChildren(createIcon('trash-2', { size: 14 })); wrapper.append(remove);
    }
    list.append(wrapper);
  }
  if (!visible.length) { const empty = document.createElement('p'); empty.className = 'vault-empty'; empty.textContent = 'No matching items.'; list.append(empty); }
  list.scrollTop = scrollTop;
  renderDetail(visible.find(item => item.id === selectedId));
}
function renderDetail(item?: VaultEntryView): void {
  const detail = document.getElementById('vault-detail'); if (!detail) return;
  const selection = window.getSelection();
  if (selection && ((selection.anchorNode && detail.contains(selection.anchorNode)) || (selection.focusNode && detail.contains(selection.focusNode)))) selection.removeAllRanges();
  clearDetailSecrets();
  const secretCleanups: Array<() => void> = [];
  clearDetailSecrets = () => secretCleanups.forEach(cleanup => cleanup());
  detail.replaceChildren(); detail.classList.toggle('vault-detail-empty', !item);
  if (!item) {
    const icon = document.createElement('span'); icon.className = 'vault-empty-symbol'; icon.append(createIcon('key-round', { size: 30 }));
    const label = document.createElement('p'); label.textContent = 'Select an item to view details.'; detail.append(icon, label); return;
  }
  const heading = document.createElement('h2'); heading.textContent = item.type === 'login' ? item.loginUrl || 'Website URL needed' : item.name; detail.append(heading);
  const field = (parent: HTMLElement, label: string, value: string) => {
    const block = document.createElement('div'); block.className = 'vault-detail-field';
    const name = document.createElement('span'); name.textContent = label;
    const text = document.createElement('p'); text.textContent = value || '—'; block.append(name, text); parent.append(block); return block;
  };
  if (item.type === 'sshKey') {
    field(detail, 'Type', 'SSH Key'); detail.append(action('Rename', () => openKeyDialog('rename', item)), action('Replace Key', () => openKeyDialog('replace', item)));
  } else {
    const toolbar = document.createElement('div'); toolbar.className = 'vault-row-actions';
    toolbar.append(action('Edit', () => openEntryDialog(item)));
    if (item.loginUrl) toolbar.append(action('Open Website', () => window.vaultApi.openUrl(item.id)));
    detail.append(toolbar);
    item.accounts.forEach((account, index) => {
      const section = document.createElement('section'); section.className = 'vault-account-detail'; section.setAttribute('aria-label', `Account ${index + 1}`);
      const title = document.createElement('h3'); title.textContent = `Account ${index + 1}`; section.append(title);
      const credentials = document.createElement('div'); credentials.className = 'vault-account-credentials'; section.append(credentials);
      const credentialRow = (label: string, value: string) => {
        const row = document.createElement('div'); row.className = 'vault-credential-row';
        const labelNode = document.createElement('span'); labelNode.className = 'vault-credential-label'; labelNode.textContent = label;
        const content = document.createElement('p'); content.className = 'vault-credential-value'; content.textContent = value || '—'; content.tabIndex = 0; content.setAttribute('aria-label', label);
        const controls = document.createElement('div'); controls.className = 'vault-credential-actions';
        row.append(labelNode, content, controls); credentials.append(row); return { content, controls };
      };
      const iconAction = (label: string, icon: 'copy' | 'eye', run: () => Promise<unknown> | void) => {
        const button = action(label, run); button.className = 'vault-credential-action'; button.title = label; button.setAttribute('aria-label', label);
        button.replaceChildren(createIcon(icon, { size: 18 })); return button;
      };
      const username = credentialRow('Username', account.username);
      username.content.title = account.username;
      username.controls.append(iconAction('Copy username', 'copy', () => window.vaultApi.copy(item.id, 'username', account.id).then(() => report('Username copied · Clears after 30s'))));
      const masked = account.hasPassword ? '••••••••••••' : 'Not set';
      const password = credentialRow('Password', masked);
      let revealed = false, generation = 0, timer: ReturnType<typeof setTimeout> | undefined;
      const hide = () => {
        generation++; clearTimeout(timer); revealed = false; password.content.textContent = masked;
        toggle.title = 'Show password'; toggle.setAttribute('aria-label', 'Show password'); toggle.setAttribute('aria-pressed', 'false');
        toggle.replaceChildren(createIcon('eye', { size: 18 }));
      };
      const toggle = iconAction('Show password', 'eye', async () => {
        if (revealed) { hide(); return; }
        const request = ++generation; toggle.disabled = true;
        try {
          const value = await window.vaultApi.readPassword(item.id, item.revision ?? 0, account.id);
          if (request !== generation || !password.content.isConnected) return;
          password.content.textContent = value || 'Not set'; revealed = true;
          toggle.title = 'Hide password'; toggle.setAttribute('aria-label', 'Hide password'); toggle.setAttribute('aria-pressed', 'true');
          toggle.replaceChildren(createIcon('eye-off', { size: 18 })); timer = setTimeout(hide, 30_000);
        } finally { toggle.disabled = !account.hasPassword; }
      });
      toggle.disabled = !account.hasPassword; toggle.setAttribute('aria-pressed', 'false'); secretCleanups.push(hide);
      password.controls.append(iconAction('Copy password', 'copy', () => window.vaultApi.copy(item.id, 'password', account.id).then(() => report('Password copied · Clears after 30s'))), toggle);
      field(section, 'Notes', account.notes); detail.append(section);
    });
  }
  field(detail, 'Updated', new Date(item.updatedAt ?? item.createdAt).toLocaleString());
}
async function openEntryDialog(item?: VaultEntryView): Promise<void> {
  const passwords = item ? await window.vaultApi.editPasswords(item.id, item.revision ?? 0) : [];
  const dialog = document.createElement('dialog'); dialog.className = 'vault-key-dialog vault-login-dialog';
  const title = `${item ? 'Edit' : 'Add'} Login`; dialog.setAttribute('aria-label', title);
  dialog.innerHTML = `<form><header class="vault-dialog-header"><div><h2>${title}</h2></div>${!item ? '<button class="btn btn-ghost btn-sm" type="button" data-chrome>Import from Chrome</button>' : ''}</header><div class="vault-dialog-body">
    <label class="field">Login URL<input class="input" name="loginUrl" type="url" required maxlength="2048" placeholder="https://example.com/login" autocomplete="off"></label>
    <div data-accounts></div><button class="vault-text-action" type="button" data-add-account>${renderIcon('plus')}Add Account</button>
    <p class="vault-dialog-status" role="status"></p></div><footer class="vault-dialog-footer"><button class="btn btn-secondary" type="button" data-cancel>Cancel</button><button class="btn btn-primary" type="submit">Save</button></footer></form>`;
  const accountList = dialog.querySelector<HTMLElement>('[data-accounts]')!;
  const appendAccount = (account?: VaultAccountView) => {
    const section = document.createElement('section'); section.className = 'vault-account-editor'; if (account) section.dataset.accountId = account.id;
    section.innerHTML = `<div class="vault-account-heading"><h3></h3><button type="button" class="btn btn-ghost btn-sm" data-remove>Remove</button></div>
      <label class="field">Username<input class="input" name="username" maxlength="1000" autocomplete="off"></label>
      <label class="field">Password<span class="vault-password-input"><input class="input" type="password" name="password" maxlength="65536" autocomplete="new-password" placeholder="Enter a password"><button type="button" class="vault-password-toggle" data-toggle-password aria-label="Show password" aria-pressed="false">${renderIcon('eye')}</button></span></label>
      <label class="vault-generate"><input type="checkbox" name="generatePassword"> Generate a strong password when saved</label>
      <label class="field">Notes<textarea class="input" name="notes" rows="2" maxlength="65536" placeholder="Notes for this account"></textarea></label>`;
    const password = section.querySelector<HTMLInputElement>('[name=password]')!;
    password.value = passwords.find(saved => saved.id === account?.id)?.password ?? '';
    const toggle = section.querySelector<HTMLButtonElement>('[data-toggle-password]')!;
    toggle.addEventListener('click', () => {
      const visible = password.type === 'password'; password.type = visible ? 'text' : 'password';
      toggle.setAttribute('aria-label', visible ? 'Hide password' : 'Show password'); toggle.setAttribute('aria-pressed', String(visible));
      toggle.replaceChildren(createIcon(visible ? 'eye-off' : 'eye', { size: 16 }));
    });
    section.querySelector<HTMLInputElement>('[name=username]')!.value = account?.username ?? '';
    section.querySelector<HTMLTextAreaElement>('[name=notes]')!.value = account?.notes ?? '';
    section.querySelector('[data-remove]')!.addEventListener('click', () => { section.remove(); renumber(); }); accountList.append(section); renumber();
  };
  const renumber = () => {
    const sections = Array.from(accountList.children);
    sections.forEach((section, index) => { section.querySelector('h3')!.textContent = `Account ${index + 1}`; section.querySelector<HTMLButtonElement>('[data-remove]')!.disabled = sections.length === 1; });
    dialog.querySelector<HTMLButtonElement>('[data-add-account]')!.disabled = sections.length >= 200;
  };
  (dialog.querySelector('[name=loginUrl]') as HTMLInputElement).value = item?.loginUrl ?? '';
  if (item) item.accounts.forEach(appendAccount); else appendAccount();
  passwords.forEach(saved => { saved.password = ''; });
  let busy = false, suspended = false; const opener = document.activeElement as HTMLElement | null;
  const setBusy = (value: boolean) => { busy = value; for (const control of Array.from(dialog.querySelectorAll<HTMLInputElement>('input, textarea, button'))) control.disabled = value; if (!value) renumber(); };
  dialog.querySelector('[data-add-account]')!.addEventListener('click', () => appendAccount());
  dialog.querySelector('[data-cancel]')!.addEventListener('click', () => { if (!busy) dialog.close(); });
  dialog.addEventListener('cancel', event => { if (busy) event.preventDefault(); });
  dialog.addEventListener('close', () => { if (!suspended) { dialog.querySelectorAll<HTMLInputElement>('[name=password]').forEach(input => { input.value = ''; }); dialog.remove(); opener?.focus(); } });
  dialog.querySelector('[data-chrome]')?.addEventListener('click', () => {
    setBusy(true);
    void openChromeImport(() => { suspended = true; dialog.close(); }).then(imported => {
      if (imported) { suspended = false; dialog.remove(); opener?.focus(); }
      else if (suspended) { suspended = false; dialog.showModal(); }
    }).catch(error => {
      if (suspended) { suspended = false; dialog.showModal(); }
      dialog.querySelector('[role=status]')!.textContent = errorText(error);
    }).finally(() => setBusy(false));
  });
  dialog.querySelector('form')!.addEventListener('submit', event => {
    event.preventDefault(); if (busy) return;
    const draft: VaultEntryDraft = { id: item?.id, revision: item?.revision ?? 0, type: 'login', loginUrl: dialog.querySelector<HTMLInputElement>('[name=loginUrl]')!.value,
      accounts: Array.from(accountList.querySelectorAll<HTMLElement>('.vault-account-editor')).map(section => ({ id: section.dataset.accountId,
        username: section.querySelector<HTMLInputElement>('[name=username]')!.value, password: section.querySelector<HTMLInputElement>('[name=password]')!.value,
        notes: section.querySelector<HTMLTextAreaElement>('[name=notes]')!.value, generatePassword: section.querySelector<HTMLInputElement>('[name=generatePassword]')!.checked })) };
    setBusy(true);
    void window.vaultApi.saveEntry(draft).then(async saved => { selectedId = saved.id; category = 'login'; await refreshVaultKeys(); dialog.close(); })
      .catch(error => { dialog.querySelector('[role=status]')!.textContent = errorText(error); }).finally(() => setBusy(false));
  });
  document.body.append(dialog); dialog.showModal(); dialog.querySelector<HTMLInputElement>('[name=loginUrl]')!.focus();
}
async function openChromeImport(onPreview: () => void): Promise<boolean> {
  const preview = await window.vaultApi.previewChromeImport(); if (!preview) return false;
  onPreview();
  return new Promise(resolve => {
    const dialog = document.createElement('dialog'); dialog.className = 'vault-key-dialog vault-import-dialog'; dialog.setAttribute('aria-label', 'Preview Chrome Import');
    dialog.innerHTML = `<header class="vault-dialog-header"><div><h2>Preview Chrome Import</h2><p>Choose accounts to import. Passwords stay hidden. Existing accounts are never overwritten.</p></div></header>
      <div class="vault-import-body"><div class="vault-import-toolbar"><label><input type="checkbox" data-all> Select all importable</label><span data-summary></span></div>
      <div class="vault-import-scroll"><table><thead><tr><th>Select</th><th>Login URL</th><th>Username</th><th>Password</th><th>Notes</th><th>Result</th></tr></thead><tbody></tbody></table></div>
      <div class="vault-import-toolbar"><button type="button" class="btn btn-ghost btn-sm" data-prev>Previous</button><span data-page></span><button type="button" class="btn btn-ghost btn-sm" data-next>Next</button></div>
      </div><footer class="vault-dialog-footer"><p class="vault-dialog-status" role="status" aria-live="polite"></p><button type="button" class="btn btn-secondary" data-cancel>Cancel</button><button type="button" class="btn btn-primary" data-confirm>Import Selected</button></footer>`;
    const ready = preview.rows.filter(row => row.status === 'ready'); const selected = new Set(ready.map(row => row.id));
    let page = 0, busy = false, imported = false; const pages = Math.ceil(preview.rows.length / 50);
    const updateSelection = () => {
      dialog.querySelector('[data-summary]')!.textContent = `${selected.size} selected · ${preview.rows.length - ready.length} skipped`;
      const all = dialog.querySelector<HTMLInputElement>('[data-all]')!; all.checked = ready.length > 0 && selected.size === ready.length; all.indeterminate = selected.size > 0 && selected.size < ready.length; all.disabled = busy || !ready.length;
      const confirm = dialog.querySelector<HTMLButtonElement>('[data-confirm]')!;
      confirm.disabled = busy || !selected.size; confirm.textContent = busy ? 'Importing…' : 'Import Selected';
      dialog.setAttribute('aria-busy', String(busy));
    };
    const render = () => {
      const body = dialog.querySelector('tbody')!; body.replaceChildren();
      for (const row of preview.rows.slice(page * 50, page * 50 + 50)) {
        const tr = document.createElement('tr'); const select = document.createElement('td'); const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.checked = selected.has(row.id); checkbox.disabled = busy || row.status !== 'ready'; checkbox.setAttribute('aria-label', `Import ${row.username || 'account'} at ${row.loginUrl || 'invalid URL'}`);
        checkbox.addEventListener('change', () => { if (checkbox.checked) selected.add(row.id); else selected.delete(row.id); updateSelection(); }); select.append(checkbox); tr.append(select);
        for (const value of [row.loginUrl || '—', row.username || '—', row.hasPassword ? '••••••••' : 'Not set', row.notes || '—', row.message]) { const cell = document.createElement('td'); cell.textContent = value; cell.title = value; tr.append(cell); }
        body.append(tr);
      }
      dialog.querySelector('[data-page]')!.textContent = `Page ${page + 1} of ${pages}`;
      dialog.querySelector<HTMLButtonElement>('[data-prev]')!.disabled = busy || page === 0;
      dialog.querySelector<HTMLButtonElement>('[data-next]')!.disabled = busy || page >= pages - 1; updateSelection();
    };
    dialog.querySelector('[data-all]')!.addEventListener('change', event => { selected.clear(); if ((event.target as HTMLInputElement).checked) ready.forEach(row => selected.add(row.id)); render(); });
    dialog.querySelector('[data-prev]')!.addEventListener('click', () => { page--; render(); }); dialog.querySelector('[data-next]')!.addEventListener('click', () => { page++; render(); });
    dialog.querySelector('[data-cancel]')!.addEventListener('click', () => { if (!busy) dialog.close(); }); dialog.addEventListener('cancel', event => { if (busy) event.preventDefault(); });
    dialog.addEventListener('close', () => { void window.vaultApi.cancelChromeImport(preview.token).catch(() => {}); dialog.remove(); resolve(imported); });
    dialog.querySelector('[data-confirm]')!.addEventListener('click', () => {
      if (busy) return; busy = true;
      dialog.querySelector('[role=status]')!.textContent = 'Saving selected accounts to Vault…';
      render(); dialog.querySelector<HTMLButtonElement>('[data-cancel]')!.disabled = true;
      void window.vaultApi.confirmChromeImport(preview.token, [...selected]).then(async result => {
        imported = true; category = 'login'; dialog.close();
        const message = `Imported ${result.accounts} accounts · ${result.websites} new websites`;
        try { await refreshVaultKeys(); report(message); }
        catch { report(`${message}. Refresh to reload the list.`); }
      })
        .catch(error => { dialog.querySelector('[role=status]')!.textContent = errorText(error); })
        .finally(() => { busy = false; render(); dialog.querySelector<HTMLButtonElement>('[data-cancel]')!.disabled = false; });
    });
    document.body.append(dialog); render(); dialog.showModal();
  });
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
  document.getElementById('vault-add-login')!.addEventListener('click', () => { void openEntryDialog().catch(error => report(errorText(error))); });
  document.getElementById('vault-refresh')!.addEventListener('click', event => {
    const button = event.currentTarget as HTMLButtonElement; button.disabled = true; report('Connecting to remote Vault…');
    void window.vaultApi.refresh().then(async status => { await refreshVaultKeys(); report(status.message); }).catch(error => report(errorText(error))).finally(() => { button.disabled = false; });
  });
  for (const button of Array.from(document.querySelectorAll<HTMLButtonElement>('#vault-groups [data-type]'))) button.addEventListener('click', () => { category = button.dataset.type!; renderKeys(true); });
  document.getElementById('vault-add-key')!.addEventListener('click', () => openAddPrivateKey());
  document.getElementById('vault-search')!.addEventListener('input', () => renderKeys());
  window.addEventListener('focus', () => { void refreshVaultKeys().catch(error => report(errorText(error))); });
  void refreshVaultKeys().catch(error => report(errorText(error)));
}
