import { app, BrowserWindow, dialog, Menu, nativeImage } from 'electron';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const APP_DISPLAY_NAME = 'Service Manager';
export const APP_ICON_PATH = path.join(__dirname, '..', '..', '..', 'assets', 'icon.png');

export interface AppWindowOptions {
  rendererWindows: Set<BrowserWindow>;
  rendererExportGenerations: Map<number, number>;
  deleteRecentNoteExport(senderId: number): void;
  invalidateRendererExportState(senderId: number): void;
  isCloseWindowShortcut(input: Electron.Input): boolean;
  requestRendererCloseShortcut(window: BrowserWindow): Promise<boolean>;
  requestRendererNotesFlush(window: BrowserWindow): Promise<void>;
  requestQuitAfterRuntimeShutdown(): void;
  canQuitImmediately(): boolean;
  startS3AutoSync(): void;
  logRuntimeError(scope: string, error: unknown, context?: Record<string, unknown>): void;
}

export function primaryRendererWindow(rendererWindows: Set<BrowserWindow>): BrowserWindow | null {
  const focused = BrowserWindow.getFocusedWindow();
  if (
    focused
    && rendererWindows.has(focused)
    && !focused.isDestroyed()
    && !focused.webContents.isDestroyed()
  ) {
    return focused;
  }
  return [...rendererWindows].find((window) =>
    !window.isDestroyed() && !window.webContents.isDestroyed()
  ) ?? null;
}

export function createAppWindow(options: AppWindowOptions): BrowserWindow {
  const rendererUrl = pathToFileURL(path.join(__dirname, '..', '..', 'renderer', 'index.html')).toString();
  const window = new BrowserWindow({
    width: 1230,
    height: 820,
    minWidth: 900,
    minHeight: 620,
    icon: APP_ICON_PATH,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  options.rendererWindows.add(window);
  const rendererId = window.webContents.id;
  options.rendererExportGenerations.set(rendererId, 0);
  window.once('closed', () => {
    options.rendererWindows.delete(window);
    options.deleteRecentNoteExport(rendererId);
    options.rendererExportGenerations.delete(rendererId);
  });
  window.webContents.on('render-process-gone', () => options.invalidateRendererExportState(rendererId));
  window.webContents.on('did-start-navigation', (_event, _url, _isInPlace, isMainFrame) => {
    if (isMainFrame) options.invalidateRendererExportState(rendererId);
  });

  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  const preventRemoteNavigation = (event: Electron.Event, url: string): void => {
    if (url !== rendererUrl) event.preventDefault();
  };
  window.webContents.on('will-navigate', preventRemoteNavigation);
  window.webContents.on('will-redirect', preventRemoteNavigation);
  window.webContents.on('will-frame-navigate', (event) => {
    if (event.isMainFrame && event.url === rendererUrl) return;
    if (!event.isMainFrame && (event.url === 'about:blank' || event.url.startsWith('blob:file:///'))) return;
    event.preventDefault();
  });
  let closeShortcutPending = false;
  window.webContents.on('before-input-event', (event, input) => {
    if (!options.isCloseWindowShortcut(input)) return;
    event.preventDefault();
    if (closeShortcutPending) return;
    closeShortcutPending = true;
    void options.requestRendererCloseShortcut(window).then((handled) => {
      closeShortcutPending = false;
      if (!handled && !window.isDestroyed()) window.close();
    }).catch((error) => {
      closeShortcutPending = false;
      options.logRuntimeError('window:close-shortcut', error);
      if (!window.isDestroyed()) window.close();
    });
  });

  window.on('unresponsive', () => {
    options.logRuntimeError('window:unresponsive', new Error('Renderer became unresponsive.'));
  });

  window.webContents.once('did-finish-load', () => {
    options.startS3AutoSync();
  });

  let allowStandaloneWindowClose = false;
  let standaloneWindowClosePending = false;
  window.on('close', (event) => {
    if (options.canQuitImmediately() || allowStandaloneWindowClose) return;
    event.preventDefault();
    if (process.platform !== 'darwin') {
      options.requestQuitAfterRuntimeShutdown();
      return;
    }
    if (standaloneWindowClosePending) return;
    standaloneWindowClosePending = true;
    void options.requestRendererNotesFlush(window).then(() => {
      allowStandaloneWindowClose = true;
      if (!window.isDestroyed()) window.close();
    }).catch((error) => {
      standaloneWindowClosePending = false;
      options.logRuntimeError('notes:window-close-flush', error);
      if (!window.isDestroyed()) {
        void dialog.showMessageBox(window, {
          type: 'error',
          title: 'Notes Could Not Be Saved',
          message: 'The window was kept open because the latest Notes changes could not be saved.',
          detail: 'Try saving again before closing the window.',
        });
      }
    });
  });

  void window.loadURL(rendererUrl).catch((error) => {
    options.logRuntimeError('window:load-file', error);
  });
  return window;
}

export function getAppIconImage(): Electron.NativeImage | null {
  const icon = nativeImage.createFromPath(APP_ICON_PATH);
  return icon.isEmpty() ? null : icon;
}

export function applyAppIcon(): void {
  if (process.platform !== 'darwin') {
    return;
  }

  const icon = getAppIconImage();
  if (icon) {
    app.dock.setIcon(icon);
  }
}

export function applyAppMenu(checkForUpdates: () => void): void {
  if (process.platform !== 'darwin') {
    return;
  }

  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: APP_DISPLAY_NAME,
      submenu: [
        { role: 'about' },
        {
          label: 'Check for Updates...',
          click: checkForUpdates,
        },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'File',
      submenu: [{ role: 'close' }],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'delete' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload', accelerator: 'CmdOrCtrl+Alt+R' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Window',
      submenu: [{ role: 'minimize' }, { role: 'zoom' }, { type: 'separator' }, { role: 'front' }],
    },
    {
      label: 'Help',
      submenu: [],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
