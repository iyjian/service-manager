import type { S3SyncSettingsDraft, S3SyncSettingsView } from '../shared/types';
import { flushNotesPage } from './notesPage.js';

function requireElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing required element: ${selector}`);
  return element;
}

const dialog = requireElement<HTMLDialogElement>('#settings-dialog');
const form = requireElement<HTMLFormElement>('#settings-form');
const openButton = requireElement<HTMLButtonElement>('#nav-settings-btn');
const closeButton = requireElement<HTMLButtonElement>('#settings-close-btn');
const endpointInput = requireElement<HTMLInputElement>('#s3-endpoint');
const regionInput = requireElement<HTMLInputElement>('#s3-region');
const accessKeyInput = requireElement<HTMLInputElement>('#s3-access-key');
const secretKeyInput = requireElement<HTMLInputElement>('#s3-secret-key');
const saveButton = requireElement<HTMLButtonElement>('#settings-save-btn');
const syncButton = requireElement<HTMLButtonElement>('#settings-sync-btn');
const clearCredentialsButton = requireElement<HTMLButtonElement>('#settings-clear-credentials-btn');
const statusElement = requireElement<HTMLElement>('#s3-sync-status');

let busy = false;
let hasCredentials = false;

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : typeof error === 'string' ? error : String(error);
}

function setBusy(next: boolean, action: 'save' | 'sync' | 'clear' = 'save'): void {
  busy = next;
  saveButton.disabled = next;
  syncButton.disabled = next;
  clearCredentialsButton.disabled = next || !hasCredentials;
  endpointInput.disabled = next;
  regionInput.disabled = next;
  accessKeyInput.disabled = next;
  secretKeyInput.disabled = next;
  closeButton.disabled = next;
  saveButton.textContent = next && action === 'save' ? 'Saving…' : 'Save';
  syncButton.textContent = next && action === 'sync' ? 'Syncing…' : 'Sync Now';
  clearCredentialsButton.textContent = next && action === 'clear' ? 'Clearing…' : 'Clear Credentials';
}

function setStatus(message: string, level: 'default' | 'success' | 'error' = 'default'): void {
  statusElement.textContent = message;
  statusElement.classList.toggle('settings-status-success', level === 'success');
  statusElement.classList.toggle('settings-status-error', level === 'error');
}

function formatLastSync(settings: S3SyncSettingsView): string {
  if (!settings.lastSyncedAt) {
    return settings.hasCredentials ? 'Credentials saved. No backup uploaded yet.' : 'S3 backup is not configured.';
  }
  const date = new Date(settings.lastSyncedAt);
  const timestamp = Number.isFinite(date.getTime()) ? date.toLocaleString() : settings.lastSyncedAt;
  return `Last synced ${timestamp}${settings.lastRevision ? ` · ${settings.lastRevision}` : ''}`;
}

function renderSettings(settings: S3SyncSettingsView): void {
  hasCredentials = settings.hasCredentials;
  endpointInput.value = settings.endpoint;
  regionInput.value = settings.region;
  accessKeyInput.value = '';
  secretKeyInput.value = '';
  clearCredentialsButton.disabled = busy || !hasCredentials;
  setStatus(formatLastSync(settings), settings.lastSyncedAt ? 'success' : 'default');
}

function currentDraft(clearCredentials = false): S3SyncSettingsDraft {
  const accessKeyId = accessKeyInput.value.trim();
  const secretAccessKey = secretKeyInput.value;
  return {
    endpoint: endpointInput.value.trim(),
    region: regionInput.value.trim() || 'us-east-1',
    syncVersion: 1,
    ...(!clearCredentials && accessKeyId ? { accessKeyId } : {}),
    ...(!clearCredentials && secretAccessKey ? { secretAccessKey } : {}),
    ...(clearCredentials ? { clearCredentials: true } : {}),
  };
}

async function saveSettings(action: 'save' | 'sync' | 'clear' = 'save'): Promise<S3SyncSettingsView> {
  setBusy(true, action);
  try {
    const settings = await window.settingsApi.saveS3SyncSettings(currentDraft(action === 'clear'));
    renderSettings(settings);
    return settings;
  } finally {
    setBusy(false, action);
  }
}

async function openSettings(): Promise<void> {
  if (!dialog.open) dialog.showModal();
  setStatus('Loading S3 settings…');
  try {
    renderSettings(await window.settingsApi.getS3SyncSettings());
    endpointInput.focus();
  } catch (error) {
    setStatus(`Unable to load settings: ${toErrorMessage(error)}`, 'error');
  }
}

export function registerSettingsDialog(): void {
  openButton.parentElement?.append(openButton);
  openButton.addEventListener('click', () => { void openSettings(); });
  closeButton.addEventListener('click', () => { if (!busy) dialog.close(); });
  dialog.addEventListener('click', (event) => {
    if (!busy && event.target === dialog) dialog.close();
  });
  dialog.addEventListener('cancel', (event) => { if (busy) event.preventDefault(); });
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    if (busy) return;
    void saveSettings('save')
      .then(() => setStatus('S3 settings saved.', 'success'))
      .catch((error) => setStatus(`Unable to save settings: ${toErrorMessage(error)}`, 'error'));
  });
  syncButton.addEventListener('click', () => {
    if (busy) return;
    void (async () => {
      setBusy(true, 'sync');
      try {
        await flushNotesPage();
        renderSettings(await window.settingsApi.saveS3SyncSettings(currentDraft()));
        const result = await window.settingsApi.syncAllDataToS3();
        const kib = Math.max(1, Math.round(result.byteLength / 1024));
        setStatus(`Synced ${kib} KiB · ${result.revision}`, 'success');
        renderSettings(await window.settingsApi.getS3SyncSettings());
      } catch (error) {
        setStatus(`Sync failed: ${toErrorMessage(error)}`, 'error');
      } finally {
        setBusy(false, 'sync');
      }
    })();
  });
  clearCredentialsButton.addEventListener('click', () => {
    if (busy) return;
    void window.serviceApi.confirmAction({
      title: 'Clear S3 credentials?',
      message: 'Remove the saved Access Key ID and Secret Access Key?',
      detail: 'The endpoint and previous backup remain unchanged.',
      kind: 'warning',
      confirmLabel: 'Clear Credentials',
    }).then((confirmed) => {
      if (!confirmed) return;
      return saveSettings('clear').then(() => setStatus('S3 credentials cleared.', 'success'));
    }).catch((error) => setStatus(`Unable to clear credentials: ${toErrorMessage(error)}`, 'error'));
  });
}
