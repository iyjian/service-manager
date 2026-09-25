import { BrowserWindow, WebContentsView, ipcMain, type WebContents } from 'electron';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { APP_ICON_PATH } from './appWindow';
import type { PanelWindowState } from '../../shared/types';

import { PanelRegistry } from './panelRegistry';
export type PanelId = string;
export const validatePanelId = (value: unknown): PanelId => new PanelRegistry().validate(value);
export interface RendererSurface {
  webContents: WebContents;
  isDestroyed(): boolean;
}
interface PanelEntry {
  id: PanelId;
  view: WebContentsView;
  surface: RendererSurface;
  detached?: BrowserWindow;
}
interface Options {
  registry?: PanelRegistry;
  rendererWindows: Set<RendererSurface>;
  onSurfaceCreated(surface: RendererSurface): void;
  onSurfaceClosed(surface: RendererSurface): void;
  canQuitImmediately(): boolean;
  requestQuit(): void;
  startSync(): void;
  closeShortcut(input: Electron.Input): boolean;
  requestCloseShortcut(surface: RendererSurface): Promise<boolean>;
  report(scope: string, error: unknown): void;
}

/** One persistent WebContents per panel. Detach/dock moves its native view without reloading it. */
export class PanelWindowManager {
  readonly mainWindow: BrowserWindow;
  private readonly entries = new Map<PanelId, PanelEntry>();
  private active: PanelId;
  private readonly registry: PanelRegistry;
  private disposed = false;
  private readonly channels = ['panels:activate', 'panels:detach', 'panels:merge', 'panels:get-state', 'panels:focus', 'panels:list'];
  constructor(private readonly options: Options) {
    this.registry = options.registry ?? new PanelRegistry();
    this.active = this.registry.defaultId;
    this.mainWindow = this.newWindow('Service Manager');
    const shellUrl = pathToFileURL(path.join(__dirname, '../../renderer/panelShell.html')).toString();
    this.secure(this.mainWindow.webContents, shellUrl);
    this.mainWindow.on('resize', () => this.layoutMain());
    this.mainWindow.on('close', event => {
      if (this.disposed || options.canQuitImmediately()) return;
      event.preventDefault();
      if (process.platform === 'darwin') this.mainWindow.hide(); else options.requestQuit();
    });
    this.mainWindow.once('closed', () => this.dispose());
    this.mainWindow.webContents.on('did-finish-load', () => this.publish());
    this.mainWindow.webContents.on('before-input-event', (event, input) => {
      if (options.closeShortcut(input)) { event.preventDefault(); this.mainWindow.close(); }
    });
    const authorize = (sender: WebContents): void => {
      if (sender !== this.mainWindow.webContents && ![...this.entries.values()].some(entry => entry.view.webContents === sender)) {
        throw new Error('Unknown panel window.');
      }
    };
    ipcMain.handle('panels:list', event => { authorize(event.sender); return this.registry.list(); });
    ipcMain.handle('panels:get-state', event => { authorize(event.sender); return this.state(event.sender); });
    ipcMain.handle('panels:activate', (event, id: unknown) => { authorize(event.sender); this.activate(this.registry.validate(id)); });
    ipcMain.handle('panels:focus', (event, id: unknown) => { authorize(event.sender); this.focus(this.registry.validate(id)); });
    ipcMain.handle('panels:detach', event => {
      authorize(event.sender);
      const entry = [...this.entries.values()].find(entry => entry.view.webContents === event.sender);
      if (!entry) throw new Error('Select a panel first.');
      this.detach(entry.id);
    });
    ipcMain.handle('panels:merge', (event, id: unknown) => {
      authorize(event.sender);
      const entry = [...this.entries.values()].find(entry => entry.view.webContents === event.sender);
      this.merge(entry?.id ?? this.registry.validate(id));
    });
    void this.mainWindow.loadURL(shellUrl).catch(error => options.report('panels:shell', error));
  }
  private newWindow(title: string): BrowserWindow {
    return new BrowserWindow({ title, width: 1230, height: 820, minWidth: 900, minHeight: 620, icon: APP_ICON_PATH,
      webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false } });
  }
  private secure(contents: WebContents, url: string): void {
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    contents.on('will-navigate', (event, destination) => { if (destination !== url) event.preventDefault(); });
    contents.on('will-redirect', (event, destination) => { if (destination !== url) event.preventDefault(); });
    contents.on('will-frame-navigate', event => {
      if (event.isMainFrame && event.url === url) return;
      if (!event.isMainFrame && (event.url === 'about:blank' || event.url.startsWith('blob:file:///'))) return;
      event.preventDefault();
    });
  }
  private ensure(id: PanelId): PanelEntry {
    this.registry.validate(id);
    const existing = this.entries.get(id);
    if (existing) return existing;
    const view = new WebContentsView({ webPreferences: {
      preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false,
      backgroundThrottling: false,
    } });
    const surface: RendererSurface = { webContents: view.webContents, isDestroyed: () => view.webContents.isDestroyed() };
    const entry: PanelEntry = { id, view, surface };
    this.entries.set(id, entry);
    this.options.rendererWindows.add(surface);
    this.options.onSurfaceCreated(surface);
    const url = new URL(pathToFileURL(path.join(__dirname, '../../renderer/index.html')).toString());
    url.searchParams.set('panel', id);
    this.secure(view.webContents, url.toString());
    view.webContents.on('did-finish-load', () => { this.options.startSync(); this.publish(); });
    view.webContents.on('page-title-updated', (event, title) => {
      event.preventDefault();
      if (process.platform === 'win32' && (entry.detached || this.active === id)) {
        (entry.detached ?? this.mainWindow).setTitle(`${this.registry.title(id)} — ${title}`);
      }
    });
    let shortcutPending = false;
    view.webContents.on('before-input-event', (event, input) => {
      if (!this.options.closeShortcut(input)) return;
      event.preventDefault();
      if (shortcutPending) return;
      shortcutPending = true;
      void this.options.requestCloseShortcut(surface).then(handled => {
        if (!handled) (entry.detached ?? this.mainWindow).close();
      }).catch(error => this.options.report('panels:close-shortcut', error)).finally(() => { shortcutPending = false; });
    });
    view.webContents.once('destroyed', () => {
      this.options.rendererWindows.delete(surface);
      this.options.onSurfaceClosed(surface);
      this.entries.delete(id);
    });
    void view.webContents.loadURL(url.toString()).catch(error => this.options.report('panels:load', error));
    return entry;
  }
  activate(id: PanelId): void {
    if (this.disposed) return;
    this.active = id;
    const entry = this.ensure(id);
    for (const candidate of this.entries.values()) {
      if (this.mainWindow.contentView.children.includes(candidate.view)) this.mainWindow.contentView.removeChildView(candidate.view);
    }
    if (!entry.detached) this.mainWindow.contentView.addChildView(entry.view);
    this.layoutMain(); this.mainWindow.show(); this.mainWindow.focus();
    if (!entry.detached) entry.view.webContents.focus();
    this.publish();
  }
  detach(id: PanelId): void {
    const entry = this.ensure(id);
    if (entry.detached) { this.focus(id); return; }
    const detached = this.newWindow(`${this.registry.title(id)} — Service Manager`);
    this.secure(detached.webContents, 'about:blank');
    if (this.mainWindow.contentView.children.includes(entry.view)) this.mainWindow.contentView.removeChildView(entry.view);
    entry.detached = detached;
    detached.contentView.addChildView(entry.view);
    const resize = (): void => { const [width, height] = detached.getContentSize(); entry.view.setBounds({ x: 0, y: 0, width, height }); };
    detached.on('resize', resize);
    detached.on('close', event => {
      if (this.disposed || this.options.canQuitImmediately()) return;
      event.preventDefault(); this.merge(id);
    });
    resize(); detached.show(); entry.view.webContents.focus(); this.publish();
  }
  merge(id: PanelId): void {
    const entry = this.entries.get(id); if (!entry) return;
    const detached = entry.detached;
    if (detached && !detached.isDestroyed()) {
      detached.contentView.removeChildView(entry.view);
      entry.detached = undefined;
      detached.destroy();
    }
    this.activate(id);
  }
  focus(id: PanelId): void {
    const window = this.entries.get(id)?.detached;
    if (!window) { this.activate(id); return; }
    if (window.isMinimized()) window.restore();
    window.show(); window.focus(); this.entries.get(id)?.view.webContents.focus();
  }
  private layoutMain(): void {
    const entry = this.entries.get(this.active);
    if (!entry || entry.detached) return;
    const [width, height] = this.mainWindow.getContentSize();
    entry.view.setBounds({ x: 0, y: 0, width, height });
  }
  private state(sender?: WebContents): PanelWindowState {
    const own = [...this.entries.values()].find(entry => entry.view.webContents === sender);
    return { active: this.active, panel: own?.id, detached: Boolean(own?.detached),
      detachedPanels: [...this.entries.values()].filter(entry => entry.detached).map(entry => entry.id) };
  }
  private publish(): void {
    if (this.disposed) return;
    this.mainWindow.webContents.send('panels:state', this.state());
    for (const entry of this.entries.values()) if (!entry.view.webContents.isDestroyed()) entry.view.webContents.send('panels:state', this.state(entry.view.webContents));
  }
  primaryWindow(): BrowserWindow {
    const focused = BrowserWindow.getFocusedWindow();
    return focused && [...this.entries.values()].some(entry => entry.detached === focused) ? focused : this.mainWindow;
  }
  show(): void { if (this.mainWindow.isMinimized()) this.mainWindow.restore(); this.mainWindow.show(); this.mainWindow.focus(); }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const channel of this.channels) ipcMain.removeHandler(channel);
    for (const entry of [...this.entries.values()]) {
      if (!entry.view.webContents.isDestroyed()) entry.view.webContents.close();
      if (entry.detached && !entry.detached.isDestroyed()) entry.detached.destroy();
    }
    this.entries.clear();
  }
}
