import { EventEmitter } from 'node:events';
import { app, dialog, type BrowserWindow } from 'electron';
import { autoUpdater } from 'electron-updater';
import type { ProgressInfo, UpdateInfo } from 'electron-updater';
import type { UpdateState } from '../shared/types';
import { classifyUpdateFailure, type UpdateTrigger } from './updateError';

const AUTO_CHECK_DELAY_MS = 10_000;
const AUTO_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const AUTO_NETWORK_RETRY_DELAY_MS = 30_000;

type UpdateOperation = 'check' | 'download';

export class AppUpdater extends EventEmitter {
  private readonly isPackaged = app.isPackaged;
  private readonly currentVersion = app.getVersion();

  private state: UpdateState;
  private isChecking = false;
  private checkingErrorMessage?: string;
  private isDownloading = false;
  private downloadingErrorMessage?: string;
  private started = false;
  private timer?: ReturnType<typeof setInterval>;
  private automaticRetryTimer?: ReturnType<typeof setTimeout>;
  private automaticRetryAttempted = false;
  private lastTrigger: UpdateTrigger = 'auto';
  private promptedDownloadVersion?: string;
  private promptedInstallVersion?: string;

  constructor(private readonly getWindow: () => BrowserWindow | null) {
    super();

    this.state = this.isPackaged
      ? {
          status: 'idle',
          currentVersion: this.currentVersion,
          trigger: 'auto',
        }
      : {
          status: 'unsupported',
          currentVersion: this.currentVersion,
          trigger: 'auto',
        };
  }

  start(): void {
    if (this.started || !this.isPackaged) {
      this.emitState();
      return;
    }

    this.started = true;
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = false;
    autoUpdater.allowDowngrade = false;

    this.bindEvents();
    this.emitState();

    setTimeout(() => {
      void this.checkForUpdates('auto');
    }, AUTO_CHECK_DELAY_MS);

    this.timer = setInterval(() => {
      void this.checkForUpdates('auto');
    }, AUTO_CHECK_INTERVAL_MS);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    this.clearAutomaticRetry();
  }

  getState(): UpdateState {
    return { ...this.state };
  }

  async checkForUpdates(trigger: UpdateTrigger = 'manual', isAutomaticRetry = false): Promise<UpdateState> {
    if (!this.isPackaged) {
      this.setState({
        status: 'unsupported',
        currentVersion: this.currentVersion,
        trigger,
      });
      return this.getState();
    }

    if (this.isChecking) {
      return this.getState();
    }

    this.lastTrigger = trigger;
    if (trigger === 'auto' && !isAutomaticRetry) {
      this.automaticRetryAttempted = false;
      this.clearAutomaticRetry();
    }

    this.isChecking = true;
    this.checkingErrorMessage = undefined;
    this.setState({
      status: 'checking',
      currentVersion: this.currentVersion,
      trigger,
      message: 'Checking for updates...',
    });

    try {
      await autoUpdater.checkForUpdates();
    } catch (error) {
      this.handleError(error, trigger);
    } finally {
      this.isChecking = false;
    }

    return this.getState();
  }

  private bindEvents(): void {
    autoUpdater.on('checking-for-update', () => {
      this.setState({
        status: 'checking',
        currentVersion: this.currentVersion,
        trigger: this.lastTrigger,
        message: 'Checking for updates...',
      });
    });

    autoUpdater.on('update-not-available', () => {
      this.setState({
        status: 'up-to-date',
        currentVersion: this.currentVersion,
        trigger: this.lastTrigger,
      });
    });

    autoUpdater.on('update-available', (info: UpdateInfo) => {
      this.setState({
        status: 'available',
        currentVersion: this.currentVersion,
        availableVersion: info.version,
        trigger: this.lastTrigger,
        message: `Update ${info.version} is available.`,
      });
      void this.promptDownload(info);
    });

    autoUpdater.on('download-progress', (progress: ProgressInfo) => {
      this.setState({
        status: 'downloading',
        currentVersion: this.currentVersion,
        availableVersion: this.state.availableVersion,
        progressPercent: progress.percent,
        trigger: this.lastTrigger,
        message: `Downloading update ${this.state.availableVersion ?? ''} (${Math.round(progress.percent)}%).`,
      });
    });

    autoUpdater.on('update-downloaded', (info: UpdateInfo) => {
      this.setState({
        status: 'downloaded',
        currentVersion: this.currentVersion,
        availableVersion: info.version,
        downloadedVersion: info.version,
        trigger: this.lastTrigger,
        message: `Update ${info.version} downloaded. Restart to install.`,
      });
      void this.promptInstall(info);
    });

    autoUpdater.on('error', (error: Error) => {
      this.handleError(error, this.lastTrigger, this.isDownloading ? 'download' : 'check');
    });
  }

  private async promptDownload(info: UpdateInfo): Promise<void> {
    const version = info.version || '';
    if (!version) {
      return;
    }
    if (this.promptedDownloadVersion === version && this.lastTrigger === 'auto') {
      return;
    }
    this.promptedDownloadVersion = version;

    const result = await this.showMessageBox({
      type: 'info',
      title: 'Update Available',
      message: `Version ${version} is available.`,
      detail: 'Do you want to download and install it now?',
      buttons: ['Later', 'Download'],
      cancelId: 0,
      defaultId: 1,
      noLink: true,
    });

    if (result.response !== 1) {
      return;
    }

    try {
      this.setState({
        status: 'downloading',
        currentVersion: this.currentVersion,
        availableVersion: version,
        trigger: this.lastTrigger,
        message: `Downloading update ${version}...`,
      });
      this.isDownloading = true;
      this.downloadingErrorMessage = undefined;
      await autoUpdater.downloadUpdate();
    } catch (error) {
      this.handleError(error, this.lastTrigger, 'download');
    } finally {
      this.isDownloading = false;
    }
  }

  private async promptInstall(info: UpdateInfo): Promise<void> {
    const version = info.version || '';
    if (!version || this.promptedInstallVersion === version) {
      return;
    }
    this.promptedInstallVersion = version;

    const result = await this.showMessageBox({
      type: 'info',
      title: 'Update Ready',
      message: `Version ${version} has been downloaded.`,
      detail: 'Restart now to apply the update.',
      buttons: ['Later', 'Restart Now'],
      cancelId: 0,
      defaultId: 1,
      noLink: true,
    });

    if (result.response !== 1) {
      return;
    }

    autoUpdater.quitAndInstall(false, true);
  }

  private handleError(error: unknown, trigger: UpdateTrigger, operation: UpdateOperation = 'check'): void {
    const rawMessage = error instanceof Error ? error.message : String(error);

    if (operation === 'check' && this.isChecking) {
      if (this.checkingErrorMessage === rawMessage) {
        return;
      }
      this.checkingErrorMessage = rawMessage;
    }
    if (operation === 'download' && this.isDownloading) {
      if (this.downloadingErrorMessage === rawMessage) {
        return;
      }
      this.downloadingErrorMessage = rawMessage;
    }

    const classification = classifyUpdateFailure(
      rawMessage,
      trigger,
      this.automaticRetryAttempted,
      operation === 'check'
    );

    if (classification.shouldRetry) {
      this.automaticRetryAttempted = true;
      this.scheduleAutomaticRetry();
      this.setState({
        status: 'idle',
        currentVersion: this.currentVersion,
        trigger,
      });
      console.warn('[Updater] Automatic update check failed due to a network error; retrying shortly.', {
        error: rawMessage,
      });
      return;
    }

    if (!classification.shouldShowError) {
      this.setState({
        status: 'idle',
        currentVersion: this.currentVersion,
        trigger,
      });
      console.warn('[Updater] Automatic update check failed due to a network error after retry.', {
        error: rawMessage,
      });
      return;
    }

    this.setState({
      status: 'error',
      currentVersion: this.currentVersion,
      availableVersion: this.state.availableVersion,
      trigger,
      message: classification.message,
      rawMessage,
    });

    console.error('[Updater] Update flow failed', {
      trigger,
      error: rawMessage,
    });
  }

  private scheduleAutomaticRetry(): void {
    if (this.automaticRetryTimer) {
      return;
    }

    this.automaticRetryTimer = setTimeout(() => {
      this.automaticRetryTimer = undefined;
      void this.checkForUpdates('auto', true);
    }, AUTO_NETWORK_RETRY_DELAY_MS);
  }

  private clearAutomaticRetry(): void {
    if (this.automaticRetryTimer) {
      clearTimeout(this.automaticRetryTimer);
      this.automaticRetryTimer = undefined;
    }
  }

  private async showMessageBox(options: Electron.MessageBoxOptions): Promise<Electron.MessageBoxReturnValue> {
    const window = this.getWindow();
    if (window) {
      return dialog.showMessageBox(window, options);
    }
    return dialog.showMessageBox(options);
  }

  private setState(next: UpdateState): void {
    this.state = next;
    this.emitState();
  }

  private emitState(): void {
    this.emit('state-changed', this.getState());
  }
}
