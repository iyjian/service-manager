import type { S3SyncSettingsDraft, S3SyncSettingsView, S3SyncState } from '../shared/types';
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
const bucketInput = requireElement<HTMLInputElement>('#s3-bucket');
const regionInput = requireElement<HTMLInputElement>('#s3-region');
const accessKeyInput = requireElement<HTMLInputElement>('#s3-access-key');
const secretKeyInput = requireElement<HTMLInputElement>('#s3-secret-key');
const accessKeyVisibilityButton = requireElement<HTMLButtonElement>('#s3-access-key-visibility');
const secretKeyVisibilityButton = requireElement<HTMLButtonElement>('#s3-secret-key-visibility');
const saveButton = requireElement<HTMLButtonElement>('#settings-save-btn');
const syncButton = requireElement<HTMLButtonElement>('#settings-sync-btn');
const clearCredentialsButton = requireElement<HTMLButtonElement>('#settings-clear-credentials-btn');
const statusElement = requireElement<HTMLElement>('#s3-sync-status');
const navSyncIndicator = requireElement<HTMLElement>('#nav-sync-indicator');

let busy = false;
let hasCredentials = false;
let credentialRevealPending = false;

interface CredentialControl {
  input: HTMLInputElement;
  button: HTMLButtonElement;
  label: string;
}

const accessKeyControl: CredentialControl = {
  input: accessKeyInput,
  button: accessKeyVisibilityButton,
  label: 'Access Key ID',
};
const secretKeyControl: CredentialControl = {
  input: secretKeyInput,
  button: secretKeyVisibilityButton,
  label: 'Secret Access Key',
};
const credentialControls = [accessKeyControl, secretKeyControl];

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : typeof error === 'string' ? error : String(error);
}

function setCredentialVisibility(control: CredentialControl, visible: boolean): void {
  const label = `${visible ? 'Hide' : 'Show'} ${control.label}`;
  control.input.type = visible ? 'text' : 'password';
  control.button.setAttribute('aria-pressed', String(visible));
  control.button.setAttribute('aria-label', label);
  control.button.title = label;
}

function maskCredentials(): void {
  for (const control of credentialControls) setCredentialVisibility(control, false);
}

function updateCredentialControls(): void {
  const locked = busy || credentialRevealPending;
  saveButton.disabled = locked;
  syncButton.disabled = locked;
  clearCredentialsButton.disabled = locked || !hasCredentials;
  endpointInput.disabled = locked;
  bucketInput.disabled = locked;
  regionInput.disabled = locked;
  accessKeyInput.disabled = locked;
  secretKeyInput.disabled = locked;
  closeButton.disabled = locked;
  for (const control of credentialControls) {
    control.input.placeholder = hasCredentials && !control.input.value
      ? 'Saved locally — use the eye to view'
      : control.label;
    control.button.disabled = locked || (!control.input.value && !hasCredentials);
  }
}

async function toggleCredentialVisibility(control: CredentialControl): Promise<void> {
  const show = control.input.type === 'password';
  if (show && !control.input.value && hasCredentials) {
    if (!await revealSavedCredentials()) return;
  }
  if (!control.input.value) return;
  if (show) {
    for (const other of credentialControls) {
      if (other !== control) setCredentialVisibility(other, false);
    }
  }
  setCredentialVisibility(control, show);
}

async function revealSavedCredentials(): Promise<boolean> {
  credentialRevealPending = true;
  updateCredentialControls();
  try {
    const credentials = await window.settingsApi.revealS3SyncCredentials();
    if (!accessKeyInput.value) accessKeyInput.value = credentials.accessKeyId;
    if (!secretKeyInput.value) secretKeyInput.value = credentials.secretAccessKey;
    maskCredentials();
    return true;
  } catch (error) {
    setStatus(`Unable to load saved credentials: ${toErrorMessage(error)}`, 'error');
    return false;
  } finally {
    credentialRevealPending = false;
    updateCredentialControls();
  }
}

function setBusy(next: boolean, action: 'save' | 'sync' | 'clear' = 'save'): void {
  busy = next;
  if (next) maskCredentials();
  saveButton.disabled = next;
  syncButton.disabled = next;
  clearCredentialsButton.disabled = next || !hasCredentials;
  endpointInput.disabled = next;
  bucketInput.disabled = next;
  regionInput.disabled = next;
  accessKeyInput.disabled = next;
  secretKeyInput.disabled = next;
  closeButton.disabled = next;
  saveButton.textContent = next && action === 'save' ? 'Saving…' : 'Save';
  syncButton.textContent = next && action === 'sync' ? 'Syncing…' : 'Sync Now';
  clearCredentialsButton.textContent = next && action === 'clear' ? 'Clearing…' : 'Clear Credentials';
  updateCredentialControls();
}

function setStatus(
  message: string,
  level: 'default' | 'success' | 'error' | 'pending' | 'syncing' | 'conflict' = 'default',
): void {
  statusElement.textContent = message;
  statusElement.classList.toggle('settings-status-success', level === 'success');
  statusElement.classList.toggle('settings-status-error', level === 'error');
  statusElement.classList.toggle('settings-status-pending', level === 'pending');
  statusElement.classList.toggle('settings-status-syncing', level === 'syncing');
  statusElement.classList.toggle('settings-status-conflict', level === 'conflict');
}

function formatSyncTimestamp(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString() : value;
}

function renderSyncState(state: S3SyncState): void {
  navSyncIndicator.dataset.state = state.status;
  openButton.title = `Settings · S3 ${state.status.replace('-', ' ')}`;
  const lastSync = formatSyncTimestamp(state.lastSyncedAt);
  switch (state.status) {
    case 'syncing':
      setStatus('Syncing with S3…', 'syncing');
      return;
    case 'synced':
      setStatus(lastSync ? `Synced ${lastSync}.` : 'Synced with S3.', 'success');
      return;
    case 'pending':
      setStatus('Changes are saved locally and waiting to sync.', 'pending');
      return;
    case 'offline':
      setStatus('S3 is unavailable. Local changes are safe and will retry automatically.', 'error');
      return;
    case 'conflict': {
      const count = state.conflictCount ?? 1;
      setStatus(`Synced with ${count} recoverable ${count === 1 ? 'conflict' : 'conflicts'}. Note conflicts are kept as copies.`, 'conflict');
      return;
    }
    case 'error':
      setStatus(state.message ? `Sync needs attention: ${state.message}` : 'Sync needs attention.', 'error');
      return;
    default:
      setStatus('Automatic S3 sync is not configured.');
  }
}

function renderSettings(settings: S3SyncSettingsView, clearCredentialInputs = false): void {
  hasCredentials = settings.hasCredentials;
  endpointInput.value = settings.endpoint;
  bucketInput.value = settings.bucket;
  regionInput.value = settings.region;
  if (clearCredentialInputs || !settings.hasCredentials) {
    accessKeyInput.value = '';
    secretKeyInput.value = '';
  }
  clearCredentialsButton.disabled = busy || !hasCredentials;
  updateCredentialControls();
  renderSyncState(settings.syncState);
}

function currentDraft(clearCredentials = false): S3SyncSettingsDraft {
  const accessKeyId = accessKeyInput.value.trim();
  const secretAccessKey = secretKeyInput.value;
  return {
    endpoint: endpointInput.value.trim(),
    bucket: bucketInput.value.trim(),
    region: regionInput.value.trim() || 'us-east-1',
    ...(!clearCredentials && accessKeyId ? { accessKeyId } : {}),
    ...(!clearCredentials && secretAccessKey ? { secretAccessKey } : {}),
    ...(clearCredentials ? { clearCredentials: true } : {}),
  };
}

async function saveSettings(action: 'save' | 'sync' | 'clear' = 'save'): Promise<S3SyncSettingsView> {
  setBusy(true, action);
  try {
    const settings = await window.settingsApi.saveS3SyncSettings(currentDraft(action === 'clear'));
    renderSettings(settings, action === 'clear');
    return settings;
  } finally {
    setBusy(false, action);
  }
}

async function openSettings(): Promise<void> {
  maskCredentials();
  if (!dialog.open) dialog.showModal();
  setStatus('Loading S3 settings…');
  try {
    const settings = await window.settingsApi.getS3SyncSettings();
    renderSettings(settings);
    if (settings.hasCredentials && (!accessKeyInput.value || !secretKeyInput.value)) {
      await revealSavedCredentials();
    }
    endpointInput.focus();
  } catch (error) {
    setStatus(`Unable to load settings: ${toErrorMessage(error)}`, 'error');
  }
}

export function registerSettingsDialog(): void {
  openButton.parentElement?.append(openButton);
  updateCredentialControls();
  openButton.addEventListener('click', () => { void openSettings(); });
  closeButton.addEventListener('click', () => { if (!busy && !credentialRevealPending) dialog.close(); });
  accessKeyInput.addEventListener('input', updateCredentialControls);
  secretKeyInput.addEventListener('input', updateCredentialControls);
  window.settingsApi.onS3SyncStateChanged(renderSyncState);
  accessKeyVisibilityButton.addEventListener('click', () => { void toggleCredentialVisibility(accessKeyControl); });
  secretKeyVisibilityButton.addEventListener('click', () => { void toggleCredentialVisibility(secretKeyControl); });
  dialog.addEventListener('click', (event) => {
    if (!busy && !credentialRevealPending && event.target === dialog) dialog.close();
  });
  dialog.addEventListener('cancel', (event) => { if (busy || credentialRevealPending) event.preventDefault(); });
  dialog.addEventListener('close', maskCredentials);
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    if (busy || credentialRevealPending) return;
    void saveSettings('save')
      .then(() => setStatus('S3 settings saved.', 'success'))
      .catch((error) => setStatus(`Unable to save settings: ${toErrorMessage(error)}`, 'error'));
  });
  syncButton.addEventListener('click', () => {
    if (busy || credentialRevealPending) return;
    void (async () => {
      setBusy(true, 'sync');
      try {
        await flushNotesPage();
        renderSettings(await window.settingsApi.saveS3SyncSettings(currentDraft()));
        const result = await window.settingsApi.syncAllDataToS3();
        renderSettings(await window.settingsApi.getS3SyncSettings());
        const actionMessage = result.action === 'pulled'
          ? 'Cloud changes downloaded.'
          : result.action === 'pushed'
            ? `Changes uploaded${result.byteLength ? ` (${Math.max(1, Math.round(result.byteLength / 1024))} KiB)` : ''}.`
            : result.action === 'conflict'
              ? 'Synced; recoverable conflicts were preserved.'
              : 'Already up to date.';
        setStatus(actionMessage, result.action === 'conflict' ? 'conflict' : 'success');
      } catch (error) {
        setStatus(`Sync failed: ${toErrorMessage(error)}`, 'error');
      } finally {
        setBusy(false, 'sync');
      }
    })();
  });
  clearCredentialsButton.addEventListener('click', () => {
    if (busy || credentialRevealPending || !hasCredentials) return;
    void window.serviceApi.confirmAction({
      title: 'Clear S3 credentials?',
      message: 'Remove the saved Access Key ID and Secret Access Key?',
      detail: 'The Endpoint, Bucket, and cloud revisions remain unchanged.',
      kind: 'warning',
      confirmLabel: 'Clear Credentials',
    }).then((confirmed) => {
      if (!confirmed) return;
      return saveSettings('clear').then(() => setStatus('S3 credentials cleared.', 'success'));
    }).catch((error) => setStatus(`Unable to clear credentials: ${toErrorMessage(error)}`, 'error'));
  });
}
