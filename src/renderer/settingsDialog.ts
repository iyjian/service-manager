import type {
  LlmSettingsDraft,
  LlmSettingsView,
  S3ConnectionTestDraft,
  S3SyncSettingsDraft,
  S3SyncSettingsView,
  S3SyncState,
  UiPreferences,
} from '../shared/types';
import { applyNotesEditorTheme, applyNotesFontSize, flushNotesPage } from './notesPage.js';

const DEFAULT_NOTES_FONT_SIZE = 14;
const MIN_NOTES_FONT_SIZE = 12;
const MAX_NOTES_FONT_SIZE = 24;

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
const syncEncryptionKeyInput = requireElement<HTMLInputElement>('#s3-sync-encryption-key');
const accessKeyVisibilityButton = requireElement<HTMLButtonElement>('#s3-access-key-visibility');
const secretKeyVisibilityButton = requireElement<HTMLButtonElement>('#s3-secret-key-visibility');
const syncEncryptionKeyVisibilityButton = requireElement<HTMLButtonElement>('#s3-sync-encryption-key-visibility');
const syncEncryptionKeyCopyButton = requireElement<HTMLButtonElement>('#s3-sync-encryption-key-copy');
const saveButton = requireElement<HTMLButtonElement>('#settings-save-btn');
const testButton = requireElement<HTMLButtonElement>('#settings-test-btn');
const syncButton = requireElement<HTMLButtonElement>('#settings-sync-btn');
const notesFontSizeInput = requireElement<HTMLInputElement>('#notes-font-size');
const notesEditorThemeInput = requireElement<HTMLSelectElement>('#notes-editor-theme');
const llmEndpointInput = requireElement<HTMLInputElement>('#llm-endpoint');
const llmTokenInput = requireElement<HTMLInputElement>('#llm-token');
const llmTokenVisibilityButton = requireElement<HTMLButtonElement>('#llm-token-visibility');
const llmTokenRemoveButton = requireElement<HTMLButtonElement>('#llm-token-remove');
const llmModelInput = requireElement<HTMLSelectElement>('#llm-model');
const llmLoadModelsButton = requireElement<HTMLButtonElement>('#settings-llm-load-models-btn');
const llmModelStatus = requireElement<HTMLElement>('#llm-model-status');
const llmHttpWarning = requireElement<HTMLElement>('#llm-http-warning');
const statusElement = requireElement<HTMLElement>('#s3-sync-status');
const saveStatusElement = requireElement<HTMLElement>('#settings-save-status');
const navSyncIndicator = requireElement<HTMLElement>('#nav-sync-indicator');

type SettingsTab = 's3' | 'notes' | 'llm';
type BusyAction = 'save' | 'test' | 'sync' | 'load-models';

interface SettingsTabElements {
  button: HTMLButtonElement;
  panel: HTMLElement;
}

const settingsTabs: Record<SettingsTab, SettingsTabElements> = {
  s3: {
    button: requireElement<HTMLButtonElement>('#settings-s3-tab'),
    panel: requireElement<HTMLElement>('#settings-s3-panel'),
  },
  notes: {
    button: requireElement<HTMLButtonElement>('#settings-notes-tab'),
    panel: requireElement<HTMLElement>('#settings-notes-panel'),
  },
  llm: {
    button: requireElement<HTMLButtonElement>('#settings-llm-tab'),
    panel: requireElement<HTMLElement>('#settings-llm-panel'),
  },
};
const settingsTabOrder: SettingsTab[] = ['s3', 'notes', 'llm'];

let busy = false;
let busyAction: BusyAction | undefined;
let activeTab: SettingsTab = 's3';
let hasCredentials = false;
let hasSyncEncryptionKey = false;
let hasLlmToken = false;
let llmTokenEdited = false;
let llmSavedTokenHydrated = false;
let llmTokenClearRequested = false;
let credentialRevealPending = false;
let settingsLoading = false;
let s3SettingsLoaded = false;
let uiPreferencesLoaded = false;
let llmSettingsLoaded = false;
let settingsOpenGeneration = 0;

interface CredentialControl {
  input: HTMLInputElement;
  button: HTMLButtonElement;
  label: string;
  source: 's3' | 'llm';
  hasSavedValue: () => boolean;
}

const accessKeyControl: CredentialControl = {
  input: accessKeyInput,
  button: accessKeyVisibilityButton,
  label: 'Access Key ID',
  source: 's3',
  hasSavedValue: () => hasCredentials,
};
const secretKeyControl: CredentialControl = {
  input: secretKeyInput,
  button: secretKeyVisibilityButton,
  label: 'Secret Access Key',
  source: 's3',
  hasSavedValue: () => hasCredentials,
};
const syncEncryptionKeyControl: CredentialControl = {
  input: syncEncryptionKeyInput,
  button: syncEncryptionKeyVisibilityButton,
  label: 'Sync Encryption Key',
  source: 's3',
  hasSavedValue: () => hasSyncEncryptionKey,
};
const llmTokenControl: CredentialControl = {
  input: llmTokenInput,
  button: llmTokenVisibilityButton,
  label: 'LLM Token',
  source: 'llm',
  hasSavedValue: () => hasLlmToken && !llmTokenClearRequested,
};
const credentialControls = [accessKeyControl, secretKeyControl, syncEncryptionKeyControl, llmTokenControl];
const s3Inputs = [
  endpointInput,
  bucketInput,
  regionInput,
  accessKeyInput,
  secretKeyInput,
  syncEncryptionKeyInput,
];

function toErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : String(error);
  return message.replace(/^Error invoking remote method '[^']+': Error: /, '');
}

function activateTab(tab: SettingsTab, focus = false): void {
  activeTab = tab;
  for (const name of settingsTabOrder) {
    const selected = name === tab;
    const { button, panel } = settingsTabs[name];
    button.setAttribute('aria-selected', String(selected));
    button.tabIndex = selected ? 0 : -1;
    panel.hidden = !selected;
  }
  if (focus) settingsTabs[tab].button.focus();
}

function setSaveFeedback(message = '', level: 'success' | 'error' = 'error'): void {
  saveStatusElement.textContent = message;
  saveStatusElement.classList.toggle('hidden', !message);
  saveStatusElement.classList.toggle('settings-save-status-success', Boolean(message) && level === 'success');
  saveStatusElement.classList.toggle('settings-save-status-error', Boolean(message) && level === 'error');
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

function clearCredentialInputs(): void {
  for (const control of credentialControls) control.input.value = '';
}

function prepareSettingsDialogClose(): void {
  settingsOpenGeneration += 1;
  llmTokenEdited = false;
  llmSavedTokenHydrated = false;
  llmTokenClearRequested = false;
  settingsLoading = false;
  s3SettingsLoaded = false;
  uiPreferencesLoaded = false;
  llmSettingsLoaded = false;
  clearCredentialInputs();
  maskCredentials();
  updateControls();
}

function closeSettingsDialog(): void {
  prepareSettingsDialogClose();
  dialog.close();
}

function updateLlmHttpWarning(): void {
  const hasToken = Boolean(llmTokenInput.value) || (hasLlmToken && !shouldClearLlmToken());
  llmHttpWarning.classList.toggle(
    'hidden',
    !hasToken || !/^http:\/\//i.test(llmEndpointInput.value.trim()),
  );
}

function updateControls(): void {
  const locked = busy || credentialRevealPending || settingsLoading;
  const settingsReady = s3SettingsLoaded && uiPreferencesLoaded && llmSettingsLoaded;
  saveButton.disabled = locked || !settingsReady;
  testButton.disabled = locked || !s3SettingsLoaded;
  syncButton.disabled = locked || !s3SettingsLoaded;
  closeButton.disabled = locked;
  notesFontSizeInput.disabled = locked || !uiPreferencesLoaded;
  notesEditorThemeInput.disabled = locked || !uiPreferencesLoaded;
  llmEndpointInput.disabled = locked || !llmSettingsLoaded;
  llmTokenInput.disabled = locked || !llmSettingsLoaded;
  llmModelInput.disabled = locked || !llmSettingsLoaded;
  llmLoadModelsButton.disabled = locked || !llmSettingsLoaded || !llmEndpointInput.value.trim();
  llmTokenRemoveButton.classList.toggle('hidden', !hasLlmToken);
  llmTokenRemoveButton.disabled = locked || !llmSettingsLoaded || !hasLlmToken;
  llmTokenRemoveButton.textContent = shouldClearLlmToken() ? 'Keep saved Token' : 'Remove saved Token';
  for (const { button } of Object.values(settingsTabs)) button.disabled = locked;
  for (const input of s3Inputs) input.disabled = locked || !s3SettingsLoaded;
  syncEncryptionKeyCopyButton.disabled = locked || !s3SettingsLoaded
    || (!syncEncryptionKeyInput.value && !hasSyncEncryptionKey);
  for (const control of credentialControls) {
    control.input.placeholder = control.hasSavedValue() && !control.input.value
      ? 'Saved locally — use the eye to view'
      : control.label;
    control.button.disabled = locked || (!control.input.value && !control.hasSavedValue());
  }
  updateLlmHttpWarning();
}

async function toggleCredentialVisibility(control: CredentialControl): Promise<void> {
  const show = control.input.type === 'password';
  if (show && !control.input.value && control.hasSavedValue()) {
    const revealed = control.source === 'llm' ? await revealSavedLlmToken() : await revealSavedCredentials();
    if (!revealed) return;
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
  updateControls();
  try {
    const credentials = await window.settingsApi.revealS3SyncCredentials();
    if (!accessKeyInput.value && credentials.accessKeyId) accessKeyInput.value = credentials.accessKeyId;
    if (!secretKeyInput.value && credentials.secretAccessKey) secretKeyInput.value = credentials.secretAccessKey;
    if (!syncEncryptionKeyInput.value && credentials.syncEncryptionKey) {
      syncEncryptionKeyInput.value = credentials.syncEncryptionKey;
    }
    maskCredentials();
    return true;
  } catch (error) {
    setStatus(`Unable to load saved credentials: ${toErrorMessage(error)}`, 'error');
    return false;
  } finally {
    credentialRevealPending = false;
    updateControls();
  }
}

async function revealSavedLlmToken(): Promise<boolean> {
  credentialRevealPending = true;
  updateControls();
  try {
    const token = await window.settingsApi.revealLlmToken();
    if (!llmTokenInput.value) {
      llmTokenInput.value = token;
      llmSavedTokenHydrated = Boolean(token);
    }
    maskCredentials();
    setLlmStatus(llmEndpointInput.value.trim()
      ? 'Load models to refresh the list.'
      : 'Configure an API base, then load its models.');
    return true;
  } catch (error) {
    llmModelStatus.textContent = `Unable to load saved Token: ${toErrorMessage(error)}`;
    llmModelStatus.classList.add('settings-status-error');
    return false;
  } finally {
    credentialRevealPending = false;
    updateControls();
  }
}

function setBusy(next: boolean, action: BusyAction = 'save'): void {
  busy = next;
  busyAction = next ? action : undefined;
  if (next) maskCredentials();
  saveButton.textContent = next && action === 'save' ? 'Saving…' : 'Save';
  testButton.textContent = next && action === 'test' ? 'Testing…' : 'Test';
  syncButton.textContent = next && action === 'sync' ? 'Syncing…' : 'Sync Now';
  llmLoadModelsButton.textContent = next && action === 'load-models' ? 'Loading…' : 'Load Models';
  updateControls();
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
  if (busyAction === 'test') return;
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

function renderSettings(settings: S3SyncSettingsView): void {
  hasCredentials = settings.hasCredentials;
  hasSyncEncryptionKey = settings.hasSyncEncryptionKey;
  endpointInput.value = settings.endpoint;
  bucketInput.value = settings.bucket;
  regionInput.value = settings.region || 'us-east-1';
  if (!settings.hasCredentials) {
    accessKeyInput.value = '';
    secretKeyInput.value = '';
  }
  if (!settings.hasSyncEncryptionKey) syncEncryptionKeyInput.value = '';
  updateControls();
  renderSyncState(settings.syncState);
}

async function renderSettingsWithAuthoritativeSyncKey(settings: S3SyncSettingsView): Promise<void> {
  // A target change may cause main to generate a new key. Always replace the
  // draft with the authoritative protected value returned by main.
  syncEncryptionKeyInput.value = '';
  renderSettings(settings);
  if (settings.hasSyncEncryptionKey) await revealSavedCredentials();
}

function renderUiPreferences(preferences: UiPreferences): void {
  notesFontSizeInput.value = String(preferences.notesFontSize);
  notesEditorThemeInput.value = preferences.notesEditorTheme;
  applyNotesFontSize(preferences.notesFontSize);
  applyNotesEditorTheme(preferences.notesEditorTheme);
}

function setLlmStatus(message: string, error = false): void {
  llmModelStatus.textContent = message;
  llmModelStatus.classList.toggle('settings-status-error', error);
  llmModelStatus.classList.toggle('settings-status-success', !error && /loaded|saved/i.test(message));
}

function renderLlmModelOptions(models: readonly string[], selectedModel: string): void {
  llmModelInput.replaceChildren();
  const empty = document.createElement('option');
  empty.value = '';
  empty.textContent = models.length > 0 ? 'Select a model' : 'Load models to select';
  llmModelInput.appendChild(empty);
  if (selectedModel && !models.includes(selectedModel)) {
    const retained = document.createElement('option');
    retained.value = selectedModel;
    retained.textContent = `${selectedModel} (not in loaded list)`;
    llmModelInput.appendChild(retained);
  }
  for (const model of models) {
    const option = document.createElement('option');
    option.value = model;
    option.textContent = model;
    llmModelInput.appendChild(option);
  }
  llmModelInput.value = selectedModel;
}

function renderLlmSettings(settings: LlmSettingsView): void {
  hasLlmToken = settings.hasToken;
  llmEndpointInput.value = settings.endpoint;
  if (!settings.hasToken && !llmTokenEdited) {
    llmTokenInput.value = '';
    llmSavedTokenHydrated = false;
  }
  renderLlmModelOptions([], settings.selectedModel);
  setLlmStatus(settings.endpoint ? 'Load models to refresh the list.' : 'Configure an API base, then load its models.');
  updateControls();
}

function currentDraft(): S3SyncSettingsDraft {
  const accessKeyId = accessKeyInput.value.trim();
  const secretAccessKey = secretKeyInput.value;
  const syncEncryptionKey = syncEncryptionKeyInput.value.trim();
  return {
    endpoint: endpointInput.value.trim(),
    bucket: bucketInput.value.trim(),
    region: regionInput.value.trim() || 'us-east-1',
    ...(accessKeyId ? { accessKeyId } : {}),
    ...(secretAccessKey ? { secretAccessKey } : {}),
    ...(syncEncryptionKey ? { syncEncryptionKey } : {}),
  };
}

function currentS3TestDraft(): S3ConnectionTestDraft {
  return {
    endpoint: endpointInput.value.trim(),
    bucket: bucketInput.value.trim(),
    region: regionInput.value.trim() || 'us-east-1',
    accessKeyId: accessKeyInput.value.trim(),
    secretAccessKey: secretKeyInput.value,
  };
}

function currentUiPreferences(): UiPreferences {
  const notesFontSize = notesFontSizeInput.valueAsNumber;
  if (!Number.isInteger(notesFontSize)
    || notesFontSize < MIN_NOTES_FONT_SIZE
    || notesFontSize > MAX_NOTES_FONT_SIZE) {
    throw new Error(
      `Notes font size must be a whole number from ${MIN_NOTES_FONT_SIZE} to ${MAX_NOTES_FONT_SIZE}.`,
    );
  }
  const notesEditorTheme = notesEditorThemeInput.value;
  if (notesEditorTheme !== 'light' && notesEditorTheme !== 'dark') {
    throw new Error('Notes editor theme is invalid.');
  }
  return { notesFontSize, notesEditorTheme };
}

function shouldClearLlmToken(): boolean {
  return hasLlmToken && (
    llmTokenClearRequested
    || (!llmTokenInput.value && llmTokenEdited && llmSavedTokenHydrated)
  );
}

function currentLlmDraft(): LlmSettingsDraft {
  const token = llmTokenInput.value;
  return {
    endpoint: llmEndpointInput.value.trim(),
    selectedModel: llmModelInput.value,
    ...(token && llmTokenEdited ? { token } : {}),
    ...(shouldClearLlmToken() ? { clearToken: true } : {}),
  };
}

function shouldSaveS3Draft(draft: S3SyncSettingsDraft): boolean {
  return Boolean(
    draft.endpoint
      || draft.bucket
      || draft.accessKeyId
      || draft.secretAccessKey
      || draft.syncEncryptionKey
      || hasCredentials
      || hasSyncEncryptionKey
      || (draft.region && draft.region !== 'us-east-1'),
  );
}

async function saveAllSettings(): Promise<void> {
  setSaveFeedback();
  if (!s3SettingsLoaded || !uiPreferencesLoaded || !llmSettingsLoaded) {
    setSaveFeedback('Settings are not fully loaded. Close this dialog and try again.');
    return;
  }
  let preferences: UiPreferences;
  try {
    preferences = currentUiPreferences();
  } catch (error) {
    activateTab('notes');
    setSaveFeedback(toErrorMessage(error));
    notesFontSizeInput.focus();
    return;
  }

  const s3Draft = currentDraft();
  const llmDraft = currentLlmDraft();
  const saveS3 = shouldSaveS3Draft(s3Draft);
  let stage: SettingsTab = saveS3 ? 's3' : 'notes';
  let savedS3Settings: S3SyncSettingsView | undefined;
  setBusy(true, 'save');
  try {
    if (saveS3) savedS3Settings = await window.settingsApi.saveS3SyncSettings(s3Draft);
    stage = 'notes';
    renderUiPreferences(await window.settingsApi.saveUiPreferences(preferences));
    stage = 'llm';
    const savedLlmSettings = await window.settingsApi.saveLlmSettings(llmDraft);
    llmTokenEdited = false;
    llmTokenClearRequested = false;
    llmSavedTokenHydrated = Boolean(savedLlmSettings.hasToken && llmTokenInput.value);
    renderLlmSettings(savedLlmSettings);
    if (savedS3Settings) await renderSettingsWithAuthoritativeSyncKey(savedS3Settings);
    setSaveFeedback();
  } catch (error) {
    activateTab(stage);
    setSaveFeedback(`Unable to save settings: ${toErrorMessage(error)}`);
    return;
  } finally {
    setBusy(false, 'save');
  }
  closeSettingsDialog();
}

async function testS3Connection(): Promise<void> {
  setSaveFeedback();
  setBusy(true, 'test');
  try {
    if ((!accessKeyInput.value || !secretKeyInput.value) && hasCredentials) {
      if (!await revealSavedCredentials()) return;
    }
    await window.settingsApi.testS3Connection(currentS3TestDraft());
    setStatus('S3 connection succeeded.', 'success');
  } catch (error) {
    setStatus(`Connection test failed: ${toErrorMessage(error)}`, 'error');
  } finally {
    setBusy(false, 'test');
  }
}

async function loadLlmModels(): Promise<void> {
  setSaveFeedback();
  setBusy(true, 'load-models');
  setLlmStatus('Loading models…');
  try {
    const selectedModel = llmModelInput.value;
    const token = llmTokenInput.value;
    const models = await window.settingsApi.listLlmModels({
      endpoint: llmEndpointInput.value.trim(),
      ...(token ? { token } : {}),
      ...(!token && hasLlmToken && !shouldClearLlmToken() ? { useSavedToken: true } : {}),
    });
    renderLlmModelOptions(models, selectedModel);
    setLlmStatus(`Loaded ${models.length} ${models.length === 1 ? 'model' : 'models'}.`);
  } catch (error) {
    setLlmStatus(`Unable to load models: ${toErrorMessage(error)}`, true);
  } finally {
    setBusy(false, 'load-models');
  }
}

async function syncNow(): Promise<void> {
  setSaveFeedback();
  setBusy(true, 'sync');
  try {
    await flushNotesPage();
    await renderSettingsWithAuthoritativeSyncKey(
      await window.settingsApi.saveS3SyncSettings(currentDraft()),
    );
    const result = await window.settingsApi.syncAllDataToS3();
    await renderSettingsWithAuthoritativeSyncKey(await window.settingsApi.getS3SyncSettings());
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
}

async function openSettings(): Promise<void> {
  const openGeneration = ++settingsOpenGeneration;
  llmTokenEdited = false;
  llmSavedTokenHydrated = false;
  llmTokenClearRequested = false;
  settingsLoading = true;
  s3SettingsLoaded = false;
  uiPreferencesLoaded = false;
  llmSettingsLoaded = false;
  clearCredentialInputs();
  maskCredentials();
  updateControls();
  setSaveFeedback();
  if (!dialog.open) dialog.showModal();
  setStatus('Loading S3 settings…');

  const [settingsResult, preferencesResult, llmResult] = await Promise.allSettled([
    window.settingsApi.getS3SyncSettings(),
    window.settingsApi.getUiPreferences(),
    window.settingsApi.getLlmSettings(),
  ]);

  if (!dialog.open || openGeneration !== settingsOpenGeneration) return;

  if (settingsResult.status === 'fulfilled') {
    renderSettings(settingsResult.value);
    s3SettingsLoaded = true;
    if ((settingsResult.value.hasCredentials && (!accessKeyInput.value || !secretKeyInput.value))
      || (settingsResult.value.hasSyncEncryptionKey && !syncEncryptionKeyInput.value)) {
      await revealSavedCredentials();
    }
  } else {
    setStatus(`Unable to load S3 settings: ${toErrorMessage(settingsResult.reason)}`, 'error');
  }

  if (preferencesResult.status === 'fulfilled') {
    renderUiPreferences(preferencesResult.value);
    uiPreferencesLoaded = true;
  } else {
    notesFontSizeInput.value = String(DEFAULT_NOTES_FONT_SIZE);
    notesEditorThemeInput.value = 'light';
    applyNotesFontSize(DEFAULT_NOTES_FONT_SIZE);
    applyNotesEditorTheme('light');
    setSaveFeedback(`Unable to load Notes settings: ${toErrorMessage(preferencesResult.reason)}`);
  }

  if (llmResult.status === 'fulfilled') {
    renderLlmSettings(llmResult.value);
    llmSettingsLoaded = true;
    if (llmResult.value.hasToken) await revealSavedLlmToken();
  } else {
    renderLlmSettings({ endpoint: '', selectedModel: '', hasToken: false });
    setSaveFeedback(`Unable to load LLM settings: ${toErrorMessage(llmResult.reason)}`);
  }

  settingsLoading = false;
  updateControls();
  if (activeTab === 'notes') notesFontSizeInput.focus();
  else if (activeTab === 'llm') llmEndpointInput.focus();
  else endpointInput.focus();
}

function handleTabKeydown(event: KeyboardEvent): void {
  const currentIndex = settingsTabOrder.findIndex((name) => settingsTabs[name].button === event.target);
  if (currentIndex < 0) return;
  let nextIndex: number | undefined;
  if (event.key === 'ArrowRight' || event.key === 'ArrowDown') nextIndex = (currentIndex + 1) % settingsTabOrder.length;
  else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
    nextIndex = (currentIndex - 1 + settingsTabOrder.length) % settingsTabOrder.length;
  } else if (event.key === 'Home') nextIndex = 0;
  else if (event.key === 'End') nextIndex = settingsTabOrder.length - 1;
  if (nextIndex === undefined) return;
  event.preventDefault();
  activateTab(settingsTabOrder[nextIndex] ?? 's3', true);
}

export function registerSettingsDialog(): void {
  openButton.parentElement?.append(openButton);
  activateTab(activeTab);
  updateControls();

  void window.settingsApi.getUiPreferences()
    .then(renderUiPreferences)
    .catch(() => {
      applyNotesFontSize(DEFAULT_NOTES_FONT_SIZE);
      applyNotesEditorTheme('light');
    });

  openButton.addEventListener('click', () => { void openSettings(); });
  closeButton.addEventListener('click', () => {
    if (!busy && !credentialRevealPending) closeSettingsDialog();
  });
  for (const input of [accessKeyInput, secretKeyInput, syncEncryptionKeyInput, llmEndpointInput]) {
    input.addEventListener('input', updateControls);
  }
  llmTokenInput.addEventListener('input', () => {
    llmTokenEdited = true;
    llmTokenClearRequested = false;
    updateControls();
  });
  for (const name of settingsTabOrder) {
    const { button } = settingsTabs[name];
    button.addEventListener('click', () => activateTab(name));
    button.addEventListener('keydown', handleTabKeydown);
  }

  window.settingsApi.onS3SyncStateChanged(renderSyncState);
  window.settingsApi.onUiPreferencesChanged(renderUiPreferences);
  accessKeyVisibilityButton.addEventListener('click', () => { void toggleCredentialVisibility(accessKeyControl); });
  secretKeyVisibilityButton.addEventListener('click', () => { void toggleCredentialVisibility(secretKeyControl); });
  syncEncryptionKeyVisibilityButton.addEventListener('click', () => {
    void toggleCredentialVisibility(syncEncryptionKeyControl);
  });
  llmTokenVisibilityButton.addEventListener('click', () => {
    void toggleCredentialVisibility(llmTokenControl);
  });
  llmTokenRemoveButton.addEventListener('click', () => {
    if (busy || credentialRevealPending || settingsLoading || !hasLlmToken) return;
    void (async () => {
      if (shouldClearLlmToken()) {
        llmTokenClearRequested = false;
        llmTokenEdited = false;
        if (llmSavedTokenHydrated) await revealSavedLlmToken();
        else setLlmStatus('The saved Token will be kept.');
      } else {
        llmTokenClearRequested = true;
        llmTokenEdited = false;
        llmTokenInput.value = '';
        setCredentialVisibility(llmTokenControl, false);
        setLlmStatus('The saved Token will be removed when you Save.');
      }
      updateControls();
    })().catch((error) => setLlmStatus(`Unable to update saved Token: ${toErrorMessage(error)}`, true));
  });
  syncEncryptionKeyCopyButton.addEventListener('click', () => {
    if (busy || credentialRevealPending) return;
    void (async () => {
      if (!syncEncryptionKeyInput.value && hasSyncEncryptionKey && !await revealSavedCredentials()) return;
      if (!syncEncryptionKeyInput.value) return;
      await window.serviceApi.writeClipboardText(syncEncryptionKeyInput.value);
      syncEncryptionKeyCopyButton.dataset.copied = 'true';
      setStatus('Sync Encryption Key copied. Keep it private.', 'success');
      window.setTimeout(() => { delete syncEncryptionKeyCopyButton.dataset.copied; }, 1_500);
    })().catch((error) => setStatus(`Unable to copy Sync Encryption Key: ${toErrorMessage(error)}`, 'error'));
  });

  dialog.addEventListener('click', (event) => {
    if (!busy && !credentialRevealPending && event.target === dialog) closeSettingsDialog();
  });
  dialog.addEventListener('cancel', (event) => {
    if (busy || credentialRevealPending) event.preventDefault();
    else prepareSettingsDialogClose();
  });
  dialog.addEventListener('close', () => {
    if (dialog.open) return;
    clearCredentialInputs();
    maskCredentials();
    updateControls();
  });
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    if (!busy && !credentialRevealPending) void saveAllSettings();
  });
  testButton.addEventListener('click', () => {
    if (!busy && !credentialRevealPending) void testS3Connection();
  });
  syncButton.addEventListener('click', () => {
    if (!busy && !credentialRevealPending) void syncNow();
  });
  llmLoadModelsButton.addEventListener('click', () => {
    if (!busy && !credentialRevealPending) void loadLlmModels();
  });
}
